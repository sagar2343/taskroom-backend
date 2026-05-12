'use strict';
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const mongoose   = require('mongoose');
const path       = require('path');
const helmet     = require('helmet');
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

// ── NEW PRODUCTION ROUTES ──────────────────────────────────────────────────────
const billingRoutes      = require('./routes/billing');      // Razorpay payments
const exportRoutes       = require('./routes/export');       // PDF / Excel reports
const analyticsRoutes    = require('./routes/analytics');    // Productivity scores

// ── Services ───────────────────────────────────────────────────────────────
const { registerSocketHandlers }      = require('./socket/locationSocket');
const { verifyCloudinaryConnection }  = require('./services/cloudinaryService');

// ── App setup ──────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

// ── Trust proxy (important for Render + HTTPS) ────────────────────────────
app.enable('trust proxy');

// ── Socket.IO ──────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});
app.set('io', io);

// ── Security Middleware ───────────────────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: false }));

// ── Force HTTPS in production ─────────────────────────────────────────────
app.use((req, res, next) => {
  if (
    process.env.NODE_ENV === 'production' &&
    req.headers['x-forwarded-proto'] !== 'https'
  ) {
    return res.redirect(`https://${req.headers.host}${req.url}`);
  }

  next();
});

// ── Middleware ─────────────────────────────────────────────────────────────
// NOTE: /api/billing/webhook needs raw body — mount BEFORE express.json()
app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── MongoDB ────────────────────────────────────────────────────────────────
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log('✅ MongoDB connected');
    verifyCloudinaryConnection();
  })
  .catch((err) => console.error('❌ Mongo error:', err.message));

// ── REST routes ────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use('/api/auth',         authRoutes);
app.use('/api/user',         userRoutes);
app.use('/api/organization', organizationRoutes);
app.use('/api/rooms',        roomRoutes);
app.use('/api/tasks',        taskRoutes);
app.use('/api/fcm',          fcmTokenRoutes);
app.use('/api/upload',       uploadRoutes);
app.use('/api/attendance',   attendanceRoutes);

// ── Production routes ──────────────────────────────────────────────────────────
app.use('/api/billing',      billingRoutes);
app.use('/api/export',       exportRoutes);
app.use('/api/analytics',    analyticsRoutes);

// ── 404 handler ────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.method} ${req.path} not found` });
});

// ── Global error handler ────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

// ── Socket.IO handlers ─────────────────────────────────────────────────────
registerSocketHandlers(io);

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});