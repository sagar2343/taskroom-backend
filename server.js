const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const mongoose   = require('mongoose');
const path       = require('path');
require('dotenv').config();

// ── Routes ─────────────────────────────────────────────────────────────────
const authRoutes         = require('./routes/auth');
const userRoutes         = require('./routes/user');
const organizationRoutes = require('./routes/organization');
const roomRoutes         = require('./routes/room');
const taskRoutes         = require('./routes/task');
const fcmTokenRoutes     = require('./routes/fcmToken');
const uploadRoutes       = require('./routes/upload');

// ── Services ───────────────────────────────────────────────────────────────
const { registerSocketHandlers }      = require('./socket/locationSocket');
const { verifyCloudinaryConnection }  = require('./services/cloudinaryService');

// ── App setup ──────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

// ── Socket.IO ──────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin:  '*',
    methods: ['GET', 'POST'],
  },
});
app.set('io', io);

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── MongoDB ────────────────────────────────────────────────────────────────
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log('✅ MongoDB connected');
    verifyCloudinaryConnection();   // ping Cloudinary after DB is ready
  })
  .catch((err) => console.error('❌ Mongo error:', err.message));

// ── REST routes ────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use('/api/auth',         authRoutes);
app.use('/api/user',         userRoutes);
app.use('/api/organization', organizationRoutes);
app.use('/api/rooms',        roomRoutes);
app.use('/api/tasks',        taskRoutes);
app.use('/api/fcm',          fcmTokenRoutes);
app.use('/api/upload',       uploadRoutes);

// ── Socket.IO handlers ─────────────────────────────────────────────────────
registerSocketHandlers(io);

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});