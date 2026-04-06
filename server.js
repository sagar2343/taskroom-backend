const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
require('dotenv').config();

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const organizationRoutes = require('./routes/organization');
const roomRoutes = require('./routes/room');
const taskRoutes = require('./routes/task');

// ── Socket handler ─────────────────────────────────────────────────────────
const { registerSocketHandlers } = require('./socket/locationSocket');

const app    = express();
const server = http.createServer(app);          // wrap express in http.Server

// ── Socket.IO setup ────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports:   ['websocket', 'polling'],
  // ── FIX 3: tighter heartbeat so dead connections are detected in ≤40 s ──
  pingTimeout:  20000,   // ← was 30000; server waits 20 s for pong
  pingInterval: 10000,   // ← unchanged; server pings every 10 s
});

// Make io accessible to REST route handlers if ever needed
app.set('io', io);

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(express.json());


// ── MongoDB ────────────────────────────────────────────────────────────────
// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ Mongo error:', err.message));



// ── REST routes ────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ success: true, message: 'Backend is running' }));
app.use('/api/auth',         authRoutes);
app.use('/api/user',         userRoutes);
app.use('/api/organization', organizationRoutes);
app.use('/api/rooms',        roomRoutes);
app.use('/api/tasks',        taskRoutes);


// ── Socket.IO handlers ─────────────────────────────────────────────────────
registerSocketHandlers(io);

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});