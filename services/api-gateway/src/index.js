const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const jwt = require('jsonwebtoken');
const { createProxyMiddleware } = require('http-proxy-middleware');
const rateLimit = require('express-rate-limit');

dotenv.config();

const app = express();

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'replace_this_secret';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://127.0.0.1:4001';
const MEDIA_SERVICE_URL = process.env.MEDIA_SERVICE_URL || 'http://127.0.0.1:4002';
const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL || 'http://127.0.0.1:4003';
const SYNC_SERVICE_URL = process.env.SYNC_SERVICE_URL || 'http://127.0.0.1:4004';

// Stateless service: no in-memory user session state is stored here.
// Horizontal scaling strategy: run multiple API Gateway instances behind a load balancer.
// The load balancer can distribute traffic via round-robin or least-connections.
// Each request is independently authenticated via JWT so any instance can serve it.

const proxyDefaults = {
  changeOrigin: true,
  proxyTimeout: 10000,
  timeout: 10000,
  onError: (err, req, res) => {
    console.error('[api-gateway] proxy error', err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Upstream service unavailable' });
    }
  },
};

app.use(cors());

// Basic rate limiting to protect public edge
const gatewayLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(gatewayLimiter);

// Log all incoming requests
app.use((req, res, next) => {
  console.log(`[api-gateway] ${req.method} ${req.originalUrl}`);
  next();
});

// JWT validation middleware (skip auth routes)
app.use((req, res, next) => {
  if (req.path.startsWith('/auth')) return next();

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
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'api-gateway' });
});

// Readiness check for load balancers
app.get('/ready', (req, res) => {
  res.json({ status: 'ready', service: 'api-gateway' });
});

// Proxy routes
app.use(
  '/auth',
  createProxyMiddleware({
    target: AUTH_SERVICE_URL,
    ...proxyDefaults,
    pathRewrite: { '^/auth': '' },
  })
);

app.use(
  '/media',
  createProxyMiddleware({
    target: MEDIA_SERVICE_URL,
    ...proxyDefaults,
    pathRewrite: { '^/media': '' },
  })
);

app.use(
  '/notify',
  createProxyMiddleware({
    target: NOTIFICATION_SERVICE_URL,
    ...proxyDefaults,
  })
);

app.use(
  '/sync',
  createProxyMiddleware({
    target: SYNC_SERVICE_URL,
    ...proxyDefaults,
  })
);

// Centralized error handling
app.use((err, req, res, next) => {
  console.error('[api-gateway] error', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

app.listen(PORT, () => {
  console.log(`[api-gateway] running on port ${PORT}`);
});
