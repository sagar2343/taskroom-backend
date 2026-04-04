// socket_server.js
// ─────────────────────────────────────────────────────────────────────────────
// Initialise Socket.IO on the HTTP server.
// Usage in app.js / server.js:
//   const { initSocket } = require('./socket_server');
//   const server = http.createServer(app);
//   initSocket(server);
//   server.listen(PORT);
// ─────────────────────────────────────────────────────────────────────────────

const socketIO = require('socket.io');
const jwt      = require('jsonwebtoken');

let io;

// ── Initialise ────────────────────────────────────────────────────────────────

function initSocket(server) {
  io = socketIO(server, {
    cors: {
      origin:  '*',   // tighten in production to your app domains
      methods: ['GET', 'POST']
    },
    // Tuning for mobile clients that may drop connections frequently
    pingTimeout:  30000,
    pingInterval: 25000
  });

  // ── Auth middleware ────────────────────────────────────────────────────────
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('AUTH_REQUIRED'));

      const decoded   = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId   = decoded.userId || decoded._id || decoded.id;
      socket.userRole = decoded.role;
      socket.orgId    = decoded.organization;
      next();
    } catch {
      next(new Error('AUTH_INVALID'));
    }
  });

  // ── Connection handler ─────────────────────────────────────────────────────
  io.on('connection', (socket) => {
    console.log(`[Socket] +++ ${socket.userRole} ${socket.userId} connected`);

    // ── task:join ──────────────────────────────────────────────────────────
    // Called by BOTH employee (when task starts) and manager (when map opens).
    // Room name: "task:<taskId>"
    socket.on('task:join', ({ taskId }) => {
      if (!taskId) return;
      socket.join(`task:${taskId}`);
      console.log(`[Socket] ${socket.userRole} ${socket.userId} → task:${taskId}`);

      // Tell the joining client which employees are currently tracked
      socket.emit('task:joined', { taskId, ts: Date.now() });
    });

    // ── task:leave ─────────────────────────────────────────────────────────
    socket.on('task:leave', ({ taskId }) => {
      socket.leave(`task:${taskId}`);
    });

    // ── location:update ────────────────────────────────────────────────────
    // Emitted by the EMPLOYEE background service every ~30 s.
    // The HTTP ping route ALSO calls broadcastLocation() after saving to DB.
    // The socket event is an additional real-time channel; the HTTP call is the
    // source of truth and handles persistence.
    socket.on('location:update', ({ taskId, stepId, coordinates, accuracyMeters, batteryLevel }) => {
      if (!taskId || !coordinates || coordinates.length !== 2) return;

      // Broadcast to every manager / co-worker watching this task room
      const payload = {
        taskId,
        stepId,
        coordinates,
        accuracyMeters: accuracyMeters || null,
        batteryLevel:   batteryLevel   || null,
        recordedAt:     new Date().toISOString(),
        employeeId:     socket.userId
      };

      // Broadcast to all OTHER sockets in the room (manager sees it)
      socket.to(`task:${taskId}`).emit('location:update', payload);
    });

    // ── task:completed ─────────────────────────────────────────────────────
    // Broadcast when task finishes so manager map can stop live tracking
    socket.on('task:completed', ({ taskId }) => {
      io.to(`task:${taskId}`).emit('task:completed', { taskId });
    });

    socket.on('disconnect', (reason) => {
      console.log(`[Socket] --- ${socket.userId} disconnected (${reason})`);
    });
  });

  return io;
}

// ── broadcastLocation ─────────────────────────────────────────────────────────
// Called from the HTTP ping route after saving to MongoDB.
// This ensures persistence (DB) and real-time (socket) both happen.

function broadcastLocation(taskId, payload) {
  if (!io) return;
  io.to(`task:${taskId}`).emit('location:update', payload);
}

function getIO() {
  if (!io) throw new Error('Socket.IO not yet initialised');
  return io;
}

module.exports = { initSocket, broadcastLocation, getIO };