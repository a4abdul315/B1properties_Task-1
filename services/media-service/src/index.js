const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const rateLimit = require('express-rate-limit');

dotenv.config();

const app = express();

const PORT = process.env.PORT || 4002;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/media-service';
const SERVICE_NAME = process.env.SERVICE_NAME || 'media-service';
const JWT_SECRET = process.env.JWT_SECRET || 'replace_this_secret';
const UPLOAD_DIR = process.env.UPLOAD_DIR || 'uploads';
const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:4003';
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:4001';
const MAX_FILE_SIZE_MB = Number(process.env.MAX_FILE_SIZE_MB || 50);

const uploadRoot = path.join(__dirname, '..', UPLOAD_DIR);
if (!fs.existsSync(uploadRoot)) {
  fs.mkdirSync(uploadRoot, { recursive: true });
}

app.use(cors());
app.use(express.json());

// Basic rate limiting to reduce abuse and protect storage
const mediaLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(mediaLimiter);

// Stateless service: no in-memory session state. Scale horizontally behind a load balancer.
// Media files are stored on shared storage (or object storage in production) so any instance can serve them.

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

const mediaSchema = new mongoose.Schema(
  {
    fileName: { type: String, required: true },
    villaId: { type: String, required: true },
    version: { type: Number, required: true },
    size: { type: Number, required: true },
    hash: { type: String, required: true },
    storagePath: { type: String, required: true },
  },
  { timestamps: true }
);

mediaSchema.index({ villaId: 1, fileName: 1, version: -1 });
mediaSchema.index({ hash: 1 }, { unique: false });

const Media = mongoose.model('Media', mediaSchema);

const mediaAccessLogSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    fileId: { type: String, required: true },
    action: { type: String, enum: ['VIEW', 'DOWNLOAD'], required: true },
    timestamp: { type: Date, default: Date.now },
  },
  { collection: 'media_access_logs' }
);

mediaAccessLogSchema.index(
  { userId: 1, fileId: 1, action: 1 },
  { unique: true, partialFilterExpression: { action: 'DOWNLOAD' } }
);

const MediaAccessLog = mongoose.model('MediaAccessLog', mediaAccessLogSchema);

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

const authorizeVillaAccess = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.user.role === 'SALES_AGENT') {
    return next();
  }

  const villaId = req.params.villaId || req.body.villaId;
  if (req.user.role === 'CLIENT' && villaId && req.user.villaId === villaId) {
    return next();
  }

  return res.status(403).json({ error: 'Forbidden' });
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadRoot);
  },
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/\s+/g, '_');
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, `${uniqueSuffix}-${safeName}`);
  },
});

// Multer streams file uploads directly to disk; adjust limits for large files via env.
const upload = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_SIZE_MB * 1024 * 1024,
  },
});

const sendNotification = async (type, message, payload) => {
  if (!NOTIFICATION_SERVICE_URL) return;
  try {
    await axios.post(`${NOTIFICATION_SERVICE_URL}/notify`, { type, message, ...payload });
  } catch (err) {
    console.error(`[${SERVICE_NAME}] notification failed`, err.message);
  }
};

const buildInternalToken = () =>
  jwt.sign({ id: 'media-service', role: 'SALES_AGENT', villaId: null }, JWT_SECRET, {
    expiresIn: '8h',
  });

const fetchAssignedClients = async (villaId) => {
  const token = buildInternalToken();
  const response = await axios.get(`${AUTH_SERVICE_URL}/clients/by-villa/${villaId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  return response.data || [];
};

const clearAssignedVilla = async (villaId) => {
  const token = buildInternalToken();
  const response = await axios.delete(`${AUTH_SERVICE_URL}/client-villas/${encodeURIComponent(villaId)}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  return response.data || null;
};

const isSafeId = (value) => /^[a-fA-F0-9]{24}$/.test(String(value || ''));

const toActivityItem = (log, media) => ({
  id: String(log._id),
  userId: log.userId,
  fileId: log.fileId,
  action: log.action,
  timestamp: log.timestamp,
  fileName: media?.fileName || 'Unknown file',
  villaId: media?.villaId || null,
  version: media?.version || null,
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: SERVICE_NAME });
});

// Readiness check for load balancers
app.get('/ready', (req, res) => {
  res.json({ status: 'ready', service: SERVICE_NAME });
});

// Upload media
app.post('/upload', authenticate, upload.single('file'), async (req, res, next) => {
  try {
    const { villaId } = req.body;

    if (req.user.role !== 'SALES_AGENT') {
      return res.status(403).json({ error: 'Only sales agents can upload media' });
    }

    if (!villaId) {
      return res.status(400).json({ error: 'villaId is required' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'file is required' });
    }

    const fileBuffer = fs.readFileSync(req.file.path);
    const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    const duplicate = await Media.findOne({ hash, villaId });
    if (duplicate) {
      fs.unlinkSync(req.file.path);
      return res.status(409).json({ error: 'Duplicate file upload detected', mediaId: duplicate._id });
    }

    const lastVersion = await Media.findOne({ villaId, fileName: req.file.originalname })
      .sort({ version: -1 })
      .lean();

    const version = lastVersion ? lastVersion.version + 1 : 1;

    const media = await Media.create({
      fileName: req.file.originalname,
      villaId,
      version,
      size: req.file.size,
      hash,
      storagePath: req.file.path,
    });

    console.log(`[${SERVICE_NAME}] media uploaded`, {
      id: media._id,
      villaId: media.villaId,
      fileName: media.fileName,
      version: media.version,
    });

    await sendNotification(
      'MEDIA_UPLOADED',
      `New media uploaded for villa ${media.villaId}`,
      {
        id: media._id,
        fileName: media.fileName,
        villaId: media.villaId,
        version: media.version,
        size: media.size,
        hash: media.hash,
      }
    );

    try {
      const clients = await fetchAssignedClients(media.villaId);
      await Promise.all(
        clients.map((client) =>
          sendNotification(
            'CLIENT_MEDIA_AVAILABLE',
            `New media is available for your villa ${media.villaId}.`,
            {
              targetUserId: String(client._id),
              villaId: media.villaId,
              payload: {
                clientId: String(client._id),
                clientEmail: client.email,
                mediaId: String(media._id),
                fileName: media.fileName,
                version: media.version,
              },
            }
          )
        )
      );
    } catch (err) {
      console.error(`[${SERVICE_NAME}] client notification lookup failed`, err.message);
    }

    res.status(201).json({
      id: media._id,
      fileName: media.fileName,
      villaId: media.villaId,
      version: media.version,
      size: media.size,
      hash: media.hash,
    });
  } catch (err) {
    next(err);
  }
});

app.get('/activity/:villaId', authenticate, authorizeVillaAccess, async (req, res, next) => {
  try {
    const { villaId } = req.params;

    if (!villaId || typeof villaId !== 'string') {
      return res.status(400).json({ error: 'Invalid villaId' });
    }

    const media = await Media.find({ villaId }).select('_id fileName villaId version').lean();
    const mediaMap = new Map(media.map((item) => [String(item._id), item]));
    const fileIds = media.map((item) => String(item._id));

    if (fileIds.length === 0) {
      return res.json({ villaId, activity: [], downloadedFileIds: [] });
    }

    const activityLogs = await MediaAccessLog.find({ fileId: { $in: fileIds } })
      .sort({ timestamp: -1 })
      .limit(50)
      .lean();

    const activity = activityLogs
      .map((log) => toActivityItem(log, mediaMap.get(String(log.fileId))))
      .filter((item) => item.villaId === villaId);

    const downloadedFileIds = activity
      .filter((item) => item.action === 'DOWNLOAD' && item.userId === req.user.id)
      .map((item) => item.fileId);

    res.json({
      villaId,
      activity,
      downloadedFileIds,
    });
  } catch (err) {
    next(err);
  }
});

app.get('/villas', authenticate, async (req, res, next) => {
  try {
    if (req.user.role !== 'SALES_AGENT') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const mediaVillaIds = await Media.distinct('villaId');
    let assignedVillaIds = [];

    try {
      const token = buildInternalToken();
      const response = await axios.get(`${AUTH_SERVICE_URL}/client-villas`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      assignedVillaIds = response.data || [];
    } catch (err) {
      console.error(`[${SERVICE_NAME}] villa lookup failed`, err.message);
    }

    const allVillaIds = [...new Set([...mediaVillaIds, ...assignedVillaIds])]
      .filter((villaId) => typeof villaId === 'string' && villaId.trim())
      .sort();

    const villaSummaries = await Promise.all(
      allVillaIds.map(async (villaId) => {
        const mediaCount = await Media.countDocuments({ villaId });
        const latestMedia = await Media.findOne({ villaId })
          .sort({ createdAt: -1 })
          .select('fileName version createdAt')
          .lean();
        const assignedClients = await fetchAssignedClients(villaId).catch(() => []);

        return {
          villaId,
          mediaCount,
          assignedClientsCount: assignedClients.length,
          latestMedia: latestMedia || null,
        };
      })
    );

    res.json(villaSummaries);
  } catch (err) {
    next(err);
  }
});

app.delete('/villas/:villaId', authenticate, async (req, res, next) => {
  try {
    if (req.user.role !== 'SALES_AGENT') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { villaId } = req.params;
    if (!villaId || typeof villaId !== 'string') {
      return res.status(400).json({ error: 'Invalid villaId' });
    }

    const normalizedVillaId = villaId.trim();
    if (!normalizedVillaId) {
      return res.status(400).json({ error: 'Invalid villaId' });
    }

    const mediaItems = await Media.find({ villaId: normalizedVillaId }).select('_id storagePath').lean();
    const mediaIds = mediaItems.map((item) => String(item._id));

    for (const item of mediaItems) {
      if (item.storagePath && fs.existsSync(item.storagePath)) {
        try {
          fs.unlinkSync(item.storagePath);
        } catch (err) {
          console.error(`[${SERVICE_NAME}] file delete failed`, item.storagePath, err.message);
        }
      }
    }

    const deletedMediaResult = await Media.deleteMany({ villaId: normalizedVillaId });
    await MediaAccessLog.deleteMany({ fileId: { $in: mediaIds } });

    let clearedClientsCount = 0;
    try {
      const authResult = await clearAssignedVilla(normalizedVillaId);
      clearedClientsCount = authResult?.clearedClientsCount || 0;
    } catch (err) {
      console.error(`[${SERVICE_NAME}] client villa clear failed`, err.message);
    }

    res.json({
      villaId: normalizedVillaId,
      deletedMediaCount: deletedMediaResult.deletedCount || 0,
      clearedClientsCount,
    });
  } catch (err) {
    next(err);
  }
});

// Fetch media list by villa
app.get('/:villaId', authenticate, authorizeVillaAccess, async (req, res, next) => {
  try {
    const { villaId } = req.params;

    if (!villaId || typeof villaId !== 'string') {
      return res.status(400).json({ error: 'Invalid villaId' });
    }

    const media = await Media.find({ villaId }).sort({ createdAt: -1 });

    console.log(`[${SERVICE_NAME}] media list accessed`, {
      villaId,
      by: req.user.id,
      role: req.user.role,
    });

    if (req.user?.id && media.length > 0) {
      const logs = media.map((item) => ({
        userId: req.user.id,
        fileId: String(item._id),
        action: 'VIEW',
      }));
      MediaAccessLog.insertMany(logs).catch((err) => {
        console.error(`[${SERVICE_NAME}] media access log error`, err);
      });
    }

    res.json(media);
  } catch (err) {
    next(err);
  }
});

// Fetch a single file by id
app.get('/file/:id', authenticate, async (req, res, next) => {
  try {
    if (!isSafeId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid file id' });
    }

    const media = await Media.findById(req.params.id);
    if (!media) {
      return res.status(404).json({ error: 'File not found' });
    }

    if (req.user.role === 'CLIENT' && req.user.villaId !== media.villaId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const existingDownload = await MediaAccessLog.findOne({
      userId: req.user.id,
      fileId: String(media._id),
      action: 'DOWNLOAD',
    }).lean();

    if (existingDownload) {
      return res.status(409).json({ error: 'File already downloaded' });
    }

    console.log(`[${SERVICE_NAME}] media file accessed`, {
      id: media._id,
      villaId: media.villaId,
      by: req.user.id,
      role: req.user.role,
    });

    try {
      await MediaAccessLog.create({
        userId: req.user.id,
        fileId: String(media._id),
        action: 'DOWNLOAD',
      });
    } catch (err) {
      if (err?.code === 11000) {
        return res.status(409).json({ error: 'File already downloaded' });
      }
      throw err;
    }

    return res.sendFile(path.resolve(media.storagePath));
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
