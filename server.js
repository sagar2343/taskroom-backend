'use strict';
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const mongoose   = require('mongoose');
// const path       = require('path');
require('dotenv').config();

// ── Routes ─────────────────────────────────────────────────────────────────
const authRoutes         = require('./routes/auth');
const userRoutes         = require('./routes/user');
const organizationRoutes = require('./routes/organization');
const roomRoutes         = require('./routes/room');
const taskRoutes         = require('./routes/task');
const fcmTokenRoutes     = require('./routes/fcmToken');
const uploadRoutes       = require('./routes/upload');
const attendanceRoutes   = require('./routes/attendance');
const billingRoutes      = require('./routes/billing');
const exportRoutes       = require('./routes/export');
const analyticsRoutes    = require('./routes/analytics');
const adminPlanRoutes    = require('./routes/admin/plans');
const supportRoutes      = require('./routes/support');

// ── Services ───────────────────────────────────────────────────────────────
const { registerSocketHandlers }      = require('./socket/locationSocket');
const { verifyCloudinaryConnection }  = require('./services/cloudinaryService');

// ── App setup ──────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
app.set('trust proxy', 1);

// ── Allowed origins ────────────────────────────────────────────────────────
// Comma-separated in .env:  ALLOWED_ORIGINS=https://taskroom.in,https://app.taskroom.in
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(o => o.trim()).filter(Boolean);

function isOriginAllowed(origin) {
  if (!origin) return true;                               // non-browser / server-to-server
  if (process.env.NODE_ENV !== 'production') return true; // allow all in dev
  return ALLOWED_ORIGINS.includes(origin);
}

// ── Socket.IO ──────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin:      (origin, cb) => cb(null, isOriginAllowed(origin)),
    methods:     ['GET', 'POST'],
    credentials: true,
  },
  allowEIO3:       true, 
  transports:      ['polling', 'websocket'],
  allowUpgrades:   true,
  upgradeTimeout:  30000,
  pingTimeout:     60000,
  pingInterval:    25000,
  maxHttpBufferSize: 1e6,
});
app.set('io', io);

// ── Security headers (helmet) ──────────────────────────────────────────────
try {
  const helmet = require('helmet');
  app.use(helmet());
} catch (_) { /* install helmet for production */ }

// ── CORS ───────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (isOriginAllowed(origin) && origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-admin-secret');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Rate limiting ──────────────────────────────────────────────────────────
try {
  const rateLimit = require('express-rate-limit');

  // Strict: auth brute-force protection
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 30,
    standardHeaders: true, legacyHeaders: false,
    message: { success: false, message: 'Too many requests, please try again later.' },
  });
  // General API limiter
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000, max: 200,
    standardHeaders: true, legacyHeaders: false,
    message: { success: false, message: 'Too many requests, please try again later.' },
  });

  app.use('/api/auth', authLimiter);
  app.use('/api',      apiLimiter);
} catch (_) { /* install express-rate-limit for production */ }

// ── Body parsers ───────────────────────────────────────────────────────────
// NOTE: Razorpay webhook needs raw body — mount BEFORE express.json()
app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));
app.use('/api/support/inbound', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));


// // ── Middleware ─────────────────────────────────────────────────────────────
// // NOTE: /api/billing/webhook needs raw body — mount BEFORE express.json()
// app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));
// app.use(express.json());
// app.use(express.static(path.join(__dirname, 'public')));

// ── MongoDB ────────────────────────────────────────────────────────────────
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log('✅ MongoDB connected');
    verifyCloudinaryConnection();
    startPlanExpirySweep();
  })
  .catch((err) => {
    console.error('❌ Mongo error:', err.message);
    process.exit(1);
  });

// ── Scheduled plan-expiry sweep ──────────────────────────────────────────
// Auto-downgrades any org whose paid plan (planExpiresAt) has passed back to
// 'starter', and expires stale trials. Runs on boot, then every hour.
async function startPlanExpirySweep() {
  const Organization = require('./models/Organization');

  async function sweep() {
    try {
      const now = new Date();

      const expiredPaid = await Organization.find({
        plan:          { $ne: 'starter' },
        planExpiresAt: { $ne: null, $lt: now },
      });
      for (const org of expiredPaid) {
        await org.applyPlanExpiryIfNeeded();
        console.log(`⏬ Org ${org._id} (${org.name}) auto-downgraded to starter (plan expired).`);
      }

      const expiredTrials = await Organization.find({
        isTrialActive: true,
        trialEndsAt:   { $lt: now },
      });
      for (const org of expiredTrials) {
        await org.expireTrial();
      }
    } catch (err) {
      console.error('Plan expiry sweep failed:', err.message);
    }
  }

  await sweep();                          // run once at startup
  setInterval(sweep, 60 * 60 * 1000);     // then every hour
}
  

// ── Health check ───────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const s = mongoose.connection.readyState;
  res.status(s === 1 ? 200 : 503).json({
    success:   s === 1,
    status:    s === 1 ? 'ok' : 'degraded',
    db:        ['disconnected','connected','connecting','disconnecting'][s] ?? 'unknown',
    uptime:    Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    version:   process.env.npm_package_version || '1.0.0',
  });
});

// // Root — API identity (no HTML)
app.get('/', (_req, res) => {
  res.json({ success: true, name: 'TaskRoom API', health: '/api/health', docs: 'https://taskroom.in' });
});

// ── REST routes ────────────────────────────────────────────────────────────
// app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use('/api/auth',         authRoutes);
app.use('/api/user',         userRoutes);
app.use('/api/organization', organizationRoutes);
app.use('/api/rooms',        roomRoutes);
app.use('/api/tasks',        taskRoutes);
app.use('/api/fcm',          fcmTokenRoutes);
app.use('/api/upload',       uploadRoutes);
app.use('/api/attendance',   attendanceRoutes);
app.use('/api/billing',      billingRoutes);
app.use('/api/export',       exportRoutes);
app.use('/api/analytics',    analyticsRoutes);
app.use('/api/admin/plans',  adminPlanRoutes);
app.use('/api/support',      supportRoutes);

// ── 404 handler ────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.method} ${req.path} not found` });
});

// ── Global error handler ───────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

// ── Socket.IO handlers ─────────────────────────────────────────────────────
registerSocketHandlers(io);

// ── Graceful shutdown ──────────────────────────────────────────────────────
function shutdown(signal) {
  console.log(`\n${signal} received — shutting down gracefully`);
  server.close(() => {
    mongoose.connection.close(false).then(() => {
      console.log('MongoDB closed'); process.exit(0);
    });
  });
  setTimeout(() => { console.error('Forced exit'); process.exit(1); }, 10_000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ── Start ──────────────────────────────────────────────────────────────────
// const PORT = process.env.PORT || 3000;
// server.listen(PORT, () => {
//   console.log(`🚀 Server running on http://localhost:${PORT}`);
// });
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 TaskRoom API running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
});