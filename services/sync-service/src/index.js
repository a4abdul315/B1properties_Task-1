const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const axios = require('axios');
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

const PORT = process.env.PORT || 4004;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/sync-service';
const SERVICE_NAME = process.env.SERVICE_NAME || 'sync-service';
const MEDIA_SERVICE_URL = process.env.MEDIA_SERVICE_URL || 'http://localhost:4002';
const MEDIA_SERVICE_TOKEN = process.env.MEDIA_SERVICE_TOKEN || '';
const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:4003';
const SYNC_SERVICE_JWT_SECRET = process.env.SYNC_SERVICE_JWT_SECRET || '';
const ENABLE_BACKGROUND_SYNC = String(process.env.ENABLE_BACKGROUND_SYNC).toLowerCase() === 'true';
const SYNC_INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS || 30000);

app.use(cors());
app.use(express.json());

// Basic rate limiting to prevent abuse
const syncLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(syncLimiter);

// Stateless service: sync decisions are derived from request + DB state.
// Horizontal scaling strategy: multiple instances behind a load balancer.

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

const syncLogSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    villaId: { type: String, required: true },
    fileId: { type: String, required: true },
    action: { type: String, enum: ['SYNC'], required: true },
    timestamp: { type: Date, default: Date.now },
  },
  { collection: 'sync_logs' }
);

syncLogSchema.index({ userId: 1, villaId: 1, fileId: 1, action: 1 });

const SyncLog = mongoose.model('SyncLog', syncLogSchema);

const normalizeDeviceVersions = (input) => {
  if (!input) return {};
  if (Array.isArray(input)) {
    return input.reduce((acc, item) => {
      if (item && item.fileName) {
        acc[item.fileName] = {
          version: Number(item.version || 0),
          hash: item.hash || null,
        };
      }
      return acc;
    }, {});
  }
  return Object.keys(input).reduce((acc, key) => {
    const value = input[key] || {};
    acc[key] = {
      version: Number(value.version || 0),
      hash: value.hash || null,
    };
    return acc;
  }, {});
};

const buildInternalToken = () => {
  if (MEDIA_SERVICE_TOKEN) return MEDIA_SERVICE_TOKEN;
  if (!SYNC_SERVICE_JWT_SECRET) return '';
  return jwt.sign(
    { id: 'sync-service', role: 'SALES_AGENT', villaId: null },
    SYNC_SERVICE_JWT_SECRET,
    { expiresIn: '8h' }
  );
};

const fetchVillaMedia = async (villaId) => {
  const headers = {};
  const token = buildInternalToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await axios.get(`${MEDIA_SERVICE_URL}/${villaId}`, { headers });
  return response.data || [];
};

const sendNotification = async (type, message, payload) => {
  if (!NOTIFICATION_SERVICE_URL) return;
  try {
    await axios.post(`${NOTIFICATION_SERVICE_URL}/notify`, { type, message, payload });
  } catch (err) {
    console.error(`[${SERVICE_NAME}] notification failed`, err.message);
  }
};

const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing or invalid token' });
  }

  try {
    req.user = jwt.verify(token, SYNC_SERVICE_JWT_SECRET);
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

const resolveSyncContext = (req) => {
  const requestedVillaId = typeof req.body.villaId === 'string' ? req.body.villaId.trim() : '';
  const requestedUserId = typeof req.body.userId === 'string' ? req.body.userId.trim() : '';

  if (!req.user) {
    return { error: 'Unauthorized', status: 401 };
  }

  if (req.user.role === 'CLIENT') {
    if (!req.user.villaId) {
      return { error: 'Client is not assigned to a villa', status: 403 };
    }
    if (requestedVillaId && requestedVillaId !== req.user.villaId) {
      return { error: 'Forbidden', status: 403 };
    }

    return {
      userId: req.user.id,
      villaId: req.user.villaId,
    };
  }

  if (req.user.role === 'SALES_AGENT') {
    if (!requestedVillaId) {
      return { error: 'villaId is required', status: 400 };
    }

    return {
      userId: requestedUserId || req.user.id,
      villaId: requestedVillaId,
    };
  }

  return { error: 'Forbidden', status: 403 };
};

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: SERVICE_NAME });
});

// Readiness check for load balancers
app.get('/ready', (req, res) => {
  res.json({ status: 'ready', service: SERVICE_NAME });
});

const handleSync = async (req, res, next) => {
  try {
    const { deviceVersions, networkName } = req.body;
    const syncContext = resolveSyncContext(req);

    if (syncContext.error) {
      return res.status(syncContext.status).json({ error: syncContext.error });
    }

    const { userId, villaId } = syncContext;

    const connectedAt = new Date();
    const trigger = {
      type: 'WIFI_CONNECTED',
      networkName: typeof networkName === 'string' && networkName.trim() ? networkName.trim() : 'Villa WiFi',
      connectedAt: connectedAt.toISOString(),
    };

    eventBus.emit('wifi.connected', { userId, villaId, trigger });

    const deviceMap = normalizeDeviceVersions(deviceVersions);
    const mediaList = await fetchVillaMedia(villaId);

    const previousLogs = await SyncLog.find({ userId, villaId, action: 'SYNC' }).lean();
    const servedFileIds = new Set(previousLogs.map((log) => log.fileId));

    const updates = [];

    for (const media of mediaList) {
      const clientInfo = deviceMap[media.fileName];
      const clientVersion = clientInfo ? clientInfo.version : 0;
      const hashMismatch = clientInfo && clientInfo.hash && clientInfo.hash !== media.hash;
      const needsUpdate = media.version > clientVersion || hashMismatch;

      if (!needsUpdate) continue;
      if (servedFileIds.has(String(media._id))) continue;

      updates.push({
        id: media._id,
        fileName: media.fileName,
        villaId: media.villaId,
        version: media.version,
        size: media.size,
        hash: media.hash,
        reason: hashMismatch ? 'HASH_MISMATCH' : 'NEWER_VERSION',
        downloadPath: `/media/file/${media._id}`,
      });
    }

    if (updates.length > 0) {
      const logs = updates.map((item) => ({
        userId,
        villaId,
        fileId: String(item.id),
        action: 'SYNC',
      }));
      await SyncLog.insertMany(logs);
    }

    console.log(`[${SERVICE_NAME}] sync completed`, {
      userId,
      villaId,
      updates: updates.length,
    });

    await sendNotification(
      'SYNC_COMPLETED',
      `Sync completed for villa ${villaId}`,
      { userId, villaId, updatesCount: updates.length }
    );

    res.json({
      userId,
      villaId,
      trigger,
      deviceVersions: deviceMap,
      updates,
    });
  } catch (err) {
    next(err);
  }
};

// Simulate WiFi-triggered sync
app.post('/sync', authenticate, handleSync);
// Allow gateway forwarding without path rewrite
app.post('/', authenticate, handleSync);

// Event-driven async simulation
eventBus.on('wifi.connected', (payload) => {
  console.log(`[${SERVICE_NAME}] wifi connected`, payload);
});

if (ENABLE_BACKGROUND_SYNC) {
  setInterval(() => {
    console.log(`[${SERVICE_NAME}] background sync tick`);
  }, SYNC_INTERVAL_MS);
}

// Centralized error handling
app.use((err, req, res, next) => {
  console.error(`[${SERVICE_NAME}] error`, err);
  res.status(500).json({ error: 'Internal Server Error' });
});

app.listen(PORT, () => {
  console.log(`[${SERVICE_NAME}] running on port ${PORT}`);
});
