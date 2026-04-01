const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');

dotenv.config();

const app = express();

const PORT = process.env.PORT || 4001;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/auth-service';
const SERVICE_NAME = process.env.SERVICE_NAME || 'auth-service';
const JWT_SECRET = process.env.JWT_SECRET || 'replace_this_secret';
const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:4003';

app.use(cors());
app.use(express.json());

// Basic rate limiting to reduce brute-force attempts
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(authLimiter);

// Stateless service: authentication is done with JWTs so any instance can verify requests.
// Horizontal scaling strategy: multiple auth-service instances behind a load balancer.

// Log all incoming requests
app.use((req, res, next) => {
  console.log(`[${SERVICE_NAME}] ${req.method} ${req.originalUrl}`);
  next();
});

// MongoDB connection
mongoose
  .connect(MONGODB_URI)
  .then(() => console.log(`[${SERVICE_NAME}] MongoDB connected`))
  .catch((err) => console.error(`[${SERVICE_NAME}] MongoDB connection error`, err));

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ['CLIENT', 'SALES_AGENT'], required: true },
    villaId: { type: String, default: null },
  },
  { timestamps: true }
);

const User = mongoose.model('User', userSchema);

const buildDefaultName = (email) => {
  const localPart = String(email || '').split('@')[0].trim();
  return localPart || 'User';
};

const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing or invalid token' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

const authorize = (role) => (req, res, next) => {
  if (!req.user || req.user.role !== role) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  return next();
};

const isSafeId = (value) => /^[a-fA-F0-9]{24}$/.test(String(value || ''));

const sendNotification = async (type, message, payload) => {
  if (!NOTIFICATION_SERVICE_URL) return;
  try {
    await fetch(`${NOTIFICATION_SERVICE_URL}/notify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type,
        message,
        ...payload,
      }),
    });
  } catch (err) {
    console.error(`[${SERVICE_NAME}] notification failed`, err.message);
  }
};

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: SERVICE_NAME });
});

// Readiness check for load balancers
app.get('/ready', (req, res) => {
  res.json({ status: 'ready', service: SERVICE_NAME });
});

// Register
app.post('/register', async (req, res, next) => {
  try {
    const { name, email, password, role, villaId } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    if (typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'Invalid field types' });
    }

    const normalizedName = typeof name === 'string' && name.trim() ? name.trim() : buildDefaultName(email);
    const normalizedRole = role || 'SALES_AGENT';

    if (typeof normalizedName !== 'string' || typeof normalizedRole !== 'string') {
      return res.status(400).json({ error: 'Invalid field types' });
    }

    if (!['CLIENT', 'SALES_AGENT'].includes(normalizedRole)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    if (villaId != null && typeof villaId !== 'string') {
      return res.status(400).json({ error: 'villaId must be a string' });
    }

    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(409).json({ error: 'Email already in use' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await User.create({
      name: normalizedName,
      email,
      passwordHash,
      role: normalizedRole,
      villaId: normalizedRole === 'CLIENT' ? (typeof villaId === 'string' ? villaId.trim() || null : null) : null,
    });

    res.status(201).json({
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      villaId: user.villaId,
    });
  } catch (err) {
    next(err);
  }
});

// Login
app.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'Invalid field types' });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: user._id, role: user.role, villaId: user.villaId },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({ token });
  } catch (err) {
    next(err);
  }
});

// Me
app.get('/me', authenticate, async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).select('-passwordHash');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(user);
  } catch (err) {
    next(err);
  }
});

app.get('/clients', authenticate, authorize('SALES_AGENT'), async (req, res, next) => {
  try {
    const clients = await User.find({ role: 'CLIENT' })
      .select('-passwordHash')
      .sort({ createdAt: -1 });

    res.json(clients);
  } catch (err) {
    next(err);
  }
});

app.get('/clients/by-villa/:villaId', authenticate, authorize('SALES_AGENT'), async (req, res, next) => {
  try {
    const { villaId } = req.params;

    if (!villaId || typeof villaId !== 'string') {
      return res.status(400).json({ error: 'Invalid villaId' });
    }

    const clients = await User.find({ role: 'CLIENT', villaId }).select('-passwordHash');
    res.json(clients);
  } catch (err) {
    next(err);
  }
});

app.get('/client-villas', authenticate, authorize('SALES_AGENT'), async (req, res, next) => {
  try {
    const villaIds = await User.distinct('villaId', {
      role: 'CLIENT',
      villaId: { $type: 'string', $ne: '' },
    });

    res.json(villaIds.sort());
  } catch (err) {
    next(err);
  }
});

app.delete('/client-villas/:villaId', authenticate, authorize('SALES_AGENT'), async (req, res, next) => {
  try {
    const { villaId } = req.params;

    if (!villaId || typeof villaId !== 'string') {
      return res.status(400).json({ error: 'Invalid villaId' });
    }

    const normalizedVillaId = villaId.trim();
    if (!normalizedVillaId) {
      return res.status(400).json({ error: 'Invalid villaId' });
    }

    const clients = await User.find({ role: 'CLIENT', villaId: normalizedVillaId }).select('-passwordHash');

    await User.updateMany(
      { role: 'CLIENT', villaId: normalizedVillaId },
      { $set: { villaId: null } }
    );

    await Promise.all(
      clients.map((client) =>
        sendNotification(
          'VILLA_REMOVED',
          `Villa ${normalizedVillaId} is no longer assigned to your account.`,
          {
            targetUserId: String(client._id),
            villaId: normalizedVillaId,
            payload: {
              clientId: String(client._id),
              clientEmail: client.email,
              villaId: normalizedVillaId,
              removedBy: req.user.id,
            },
          }
        )
      )
    );

    res.json({
      villaId: normalizedVillaId,
      clearedClientsCount: clients.length,
    });
  } catch (err) {
    next(err);
  }
});

app.patch('/clients/:id/villa', authenticate, authorize('SALES_AGENT'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { villaId } = req.body || {};

    if (!isSafeId(id)) {
      return res.status(400).json({ error: 'Invalid client id' });
    }
    if (!villaId || typeof villaId !== 'string') {
      return res.status(400).json({ error: 'villaId is required' });
    }

    const client = await User.findOneAndUpdate(
      { _id: id, role: 'CLIENT' },
      { villaId: villaId.trim() },
      { new: true }
    ).select('-passwordHash');

    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    await sendNotification(
      'VILLA_ASSIGNED',
      `Villa ${client.villaId} has been assigned to your account.`,
      {
        targetUserId: String(client._id),
        villaId: client.villaId,
        payload: {
          clientId: String(client._id),
          clientEmail: client.email,
          villaId: client.villaId,
          assignedBy: req.user.id,
        },
      }
    );

    res.json(client);
  } catch (err) {
    next(err);
  }
});

// Centralized error handling
app.use((err, req, res, next) => {
  console.error(`[${SERVICE_NAME}] error`, err);
  res.status(500).json({ error: 'Internal Server Error' });
});

app.listen(PORT, () => {
  console.log(`[${SERVICE_NAME}] running on port ${PORT}`);
});

module.exports = { authenticate, authorize };
