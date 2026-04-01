const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const { EventEmitter } = require('events');
const rateLimit = require('express-rate-limit');
let jwt;
try {
  jwt = require('jsonwebtoken');
} catch (err) {
  jwt = require('../../auth-service/node_modules/jsonwebtoken');
}

dotenv.config();

const app = express();
const eventBus = new EventEmitter();

const PORT = process.env.PORT || 4003;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/notification-service';
const SERVICE_NAME = process.env.SERVICE_NAME || 'notification-service';
const JWT_SECRET = process.env.JWT_SECRET || 'replace_this_secret';

app.use(cors());
app.use(express.json());

// Basic rate limiting to prevent notification spam
const notifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(notifyLimiter);

// Stateless service: notifications are stored in MongoDB so any instance can handle requests.
// Horizontal scaling strategy: run multiple instances behind a load balancer.

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

const notificationSchema = new mongoose.Schema(
  {
    type: { type: String, required: true },
    message: { type: String, required: true },
    targetUserId: { type: String, default: null },
    villaId: { type: String, default: null },
    payload: { type: Object, default: {} },
  },
  { timestamps: true }
);

const Notification = mongoose.model('Notification', notificationSchema);

const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing or invalid token' });
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
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

// Notify endpoint
app.post('/notify', async (req, res, next) => {
  try {
    const { type, message, payload, targetUserId, villaId } = req.body || {};

    if (!type || !message) {
      return res.status(400).json({ error: 'type and message are required' });
    }
    if (typeof type !== 'string' || typeof message !== 'string') {
      return res.status(400).json({ error: 'Invalid field types' });
    }

    const record = await Notification.create({
      type,
      message,
      targetUserId: typeof targetUserId === 'string' ? targetUserId : null,
      villaId: typeof villaId === 'string' ? villaId : null,
      payload: payload || {},
    });

    eventBus.emit('notification.created', record.toObject());

    res.status(201).json({
      id: record._id,
      type: record.type,
      message: record.message,
      createdAt: record.createdAt,
    });
  } catch (err) {
    next(err);
  }
});

app.get('/notify/mine', authenticate, async (req, res, next) => {
  try {
    const query =
      req.user.role === 'CLIENT'
        ? {
            $or: [
              { targetUserId: req.user.id },
              ...(req.user.villaId ? [{ villaId: req.user.villaId }] : []),
            ],
          }
        : { targetUserId: req.user.id };

    const notifications = await Notification.find(query).sort({ createdAt: -1 }).limit(50).lean();
    res.json(notifications);
  } catch (err) {
    next(err);
  }
});

// Event-driven simulation: log notifications
eventBus.on('notification.created', (data) => {
  console.log(`[${SERVICE_NAME}] notification`, {
    id: data._id,
    type: data.type,
    message: data.message,
    payload: data.payload,
  });
});

// Centralized error handling
app.use((err, req, res, next) => {
  console.error(`[${SERVICE_NAME}] error`, err);
  res.status(500).json({ error: 'Internal Server Error' });
});

app.listen(PORT, () => {
  console.log(`[${SERVICE_NAME}] running on port ${PORT}`);
});
