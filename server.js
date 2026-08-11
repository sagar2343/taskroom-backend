'use strict';
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const mongoose   = require('mongoose');
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
    startTaskAutoCancelSweep();
    startIdleAttendanceSweep();
  })
  .catch((err) => {
    console.error('❌ Mongo error:', err.message);
    process.exit(1);
  });

// ── Scheduled plan-expiry sweep ──────────────────────────────────────────
// Auto-downgrades any org whose paid plan (planExpiresAt) has passed back to
// 'starter', and expires stale trials. Runs once daily at 00:15 IST via
// node-cron (previously ran every hour via setInterval — switched to a
// midnight-only cron since plan/trial expiry is a once-a-day concern, not
// something that needs hourly checking). Scheduled after the task
// auto-cancel sweep (00:05) and idle-attendance sweep (00:10) purely to
// keep all three midnight jobs spaced apart rather than firing at once.
function startPlanExpirySweep() {
  const cron = require('node-cron');
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

  // Run once immediately on boot too, so a deploy/restart right around
  // midnight doesn't cause a missed day. Safe to run any time of day —
  // this only ever touches orgs whose plan/trial has already genuinely
  // expired, regardless of when the check happens.
  sweep();

  cron.schedule('15 0 * * *', sweep, { timezone: 'Asia/Kolkata' });

  console.log('🕐 Plan expiry sweep scheduled for 00:15 IST daily.');
}

// ── Scheduled task auto-cancel sweep ──────────────────────────────────────
// Cancels any task (across ALL organizations — this is a platform-wide job,
// not scoped to one org) whose end DATE has fully passed without being
// completed. Runs once daily at 00:05 IST via node-cron, plus once
// immediately on boot as a safety net for restarts near midnight.
//
// This relies on the server staying alive 24/7 (kept awake by an UptimeRobot
// ping every 5 min on Render's free tier) — no external cron pinger needed.
function startTaskAutoCancelSweep() {
  const cron = require('node-cron');
  const { runTaskAutoCancelSweep } = require('./services/taskAutoCancelService');
  const { reconcileAllRoomStats } = require('./services/roomStatsReconcileService');

  // Self-heal: after every sweep run, immediately recompute every room's
  // stats from the real Task collection and log anything that had to be
  // corrected. This is a permanent safety net — even if some future bug
  // (in this sweep, in a manual route, in a race between them, anything)
  // causes Room.stats to drift again, it gets silently corrected within
  // seconds every single night instead of sitting wrong until someone
  // notices and manually reconciles it.
  async function sweepThenReconcile(label) {
    await runTaskAutoCancelSweep();
    try {
      const result = await reconcileAllRoomStats();
      if (result.roomsFixed > 0) {
        console.log(`[AutoCancelSweep:${label}] Self-heal corrected drift in ${result.roomsFixed} room(s):`);
        for (const r of result.fixed) {
          console.log(`  - ${r.roomName}: activeTasks ${r.before.activeTasks} → ${r.after.activeTasks}`);
        }
      }
    } catch (err) {
      console.error(`[AutoCancelSweep:${label}] Self-heal reconcile failed:`, err.message);
    }
  }

  sweepThenReconcile('startup').catch((err) =>
    console.error('Task auto-cancel sweep (startup run) failed:', err.message)
  );

  // '5 0 * * *' = every day at 00:05, in the timezone specified below.
  cron.schedule(
    '5 0 * * *',
    () => {
      sweepThenReconcile('scheduled').catch((err) =>
        console.error('Task auto-cancel sweep (scheduled run) failed:', err.message)
      );
    },
    { timezone: 'Asia/Kolkata' }
  );

  console.log('🕛 Task auto-cancel sweep scheduled for 00:05 IST daily.');
}
  
// ── Scheduled idle-attendance sweep ───────────────────────────────────────
// Forces employees offline at midnight if they left themselves online
// (forgot to tap "Go Offline", app got killed, etc.) — but skips anyone
// with a genuinely in-progress task, who must stay online uninterrupted.
// Scheduled 5 minutes after the task auto-cancel sweep (00:10 IST vs
// 00:05 IST) so it sees that day's final task statuses — an employee whose
// only in-progress task just expired at 00:05 correctly gets forced
// offline too, since they no longer have anything actually in progress.
//
// IMPORTANT: unlike the task sweep, this one does NOT also run immediately
// on server boot. The task sweep is safe to run at any time of day (it only
// touches tasks whose deadline has already genuinely passed). This sweep is
// different — if the server happens to restart mid-afternoon (a deploy,
// a crash) while employees are legitimately online, running this sweep
// right then would incorrectly force them offline in the middle of their
// workday. It should only ever run at the scheduled midnight time.
function startIdleAttendanceSweep() {
  const cron = require('node-cron');
  const { runIdleAttendanceSweep } = require('./services/idleAttendanceSweepService');

  cron.schedule(
    '10 0 * * *',
    () => {
      runIdleAttendanceSweep().catch((err) =>
        console.error('Idle attendance sweep (scheduled run) failed:', err.message)
      );
    },
    { timezone: 'Asia/Kolkata' }
  );

  console.log('🕙 Idle attendance sweep scheduled for 00:10 IST daily.');
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
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 TaskRoom API running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
});