'use strict';
// socket/locationSocket.js

const jwt  = require('jsonwebtoken');
const Task = require('../models/Task');
const User = require('../models/User');

// ─── Token resolver ───────────────────────────────────────────────────────────
// Priority: event payload → handshake.auth.token → handshake.query.token
// Also strips "Bearer " prefix in case Flutter passes the full header value.
function resolveToken(socket, eventToken) {
  const raw =
    eventToken                          ||
    socket.handshake?.auth?.token       ||   // .setAuth({'token': t}) in Flutter
    socket.handshake?.query?.token      ||   // ?token=... in URL
    null;

  if (!raw) throw new Error('No authentication token provided');
  return raw.startsWith('Bearer ') ? raw.slice(7) : raw;
}

// ─── Token verifier ───────────────────────────────────────────────────────────
async function verifyToken(socket, eventToken) {
  const token   = resolveToken(socket, eventToken);
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  const user    = await User.findById(decoded.userId).select('-password');
  if (!user) throw new Error('User not found');
  return { userId: user._id, user };
}

// ─── Main export ──────────────────────────────────────────────────────────────
function registerSocketHandlers(io) {

  // ── Connection-level auth middleware ────────────────────────────────────────
  // Resolves the user ONCE at connect time if token is in handshake.
  // Events will still work even if this fails (falls back to per-event token).
  io.use(async (socket, next) => {
    try {
      const { userId, user } = await verifyToken(socket, null);
      socket.data.userId = userId.toString();
      socket.data.user   = user;
      console.log(`[WS] auth ok at connect — user=${userId}`);
    } catch {
      // No token in handshake — allowed. Per-event auth handles it.
    }
    next();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  io.on('connection', (socket) => {
    console.log(`[WS] connected sid=${socket.id} uid=${socket.data.userId ?? 'anon'}`);

    // ─── EMPLOYEE: join tracking room ────────────────────────────────────────
    // Payload: { taskId, token? }
    socket.on('join_task_location', async (payload = {}) => {
      const { taskId, token } = payload;
      try {
        let userId, user;
        if (socket.data.userId) {
          userId = socket.data.userId;
          user   = socket.data.user;
        } else {
          ({ userId, user } = await verifyToken(socket, token));
          socket.data.userId = userId.toString();
          socket.data.user   = user;
        }

        if (!taskId) {
          socket.emit('socket_error', { message: 'taskId is required' });
          return;
        }

        const task = await Task.findOne({
          _id:          taskId,
          organization: user.organization,
          assignedTo:   userId,
          status:       'in_progress',
        }).select('room isFieldWork status');

        if (!task) {
          socket.emit('socket_error', { message: 'No active task found for this employee' });
          return;
        }

        const room = `task_location:${task.room.toString()}:${taskId}`;
        socket.join(room);

        socket.data.role   = 'employee';
        socket.data.taskId = taskId;
        socket.data.room   = room;

        socket.emit('joined_task_location', { room, taskId });
        console.log(`[WS] employee ${userId} joined ${room}`);

      } catch (err) {
        console.error(`[WS] join_task_location error: ${err.message}`);
        socket.emit('socket_error', { message: err.message });
      }
    });

    // ─── EMPLOYEE: GPS broadcast ─────────────────────────────────────────────
    // Payload: { taskId, stepId, lat, lng, accuracy?, battery? }
    socket.on('location_update', (payload = {}) => {
      const { taskId, stepId, lat, lng, accuracy, battery } = payload;

      if (!socket.data.room) {
        socket.emit('socket_error', { message: 'You must join a tracking room first' });
        return;
      }
      // Silently ignore if taskId doesn't match current room
      if (socket.data.taskId !== taskId) return;

      socket.to(socket.data.room).emit('employee_location', {
        taskId,
        stepId:    stepId   ?? null,
        lat,
        lng,
        accuracy:  accuracy ?? null,
        battery:   battery  ?? null,
        timestamp: new Date().toISOString(),
      });
    });

    // ─── EMPLOYEE: leave room ────────────────────────────────────────────────
    socket.on('leave_task_location', (payload = {}) => {
      const { taskId } = payload;
      if (socket.data.room) {
        socket.to(socket.data.room).emit('tracking_stopped', {
          taskId, reason: 'Employee ended tracking',
        });
        socket.leave(socket.data.room);
        console.log(`[WS] employee ${socket.data.userId} left ${socket.data.room}`);
        socket.data.room = null;
      }
    });

    // ─── MANAGER: start watching ─────────────────────────────────────────────
    // Payload: { taskId, token? }
    socket.on('watch_task_location', async (payload = {}) => {
      const { taskId, token } = payload;
      try {
        let userId, user;
        if (socket.data.userId) {
          userId = socket.data.userId;
          user   = socket.data.user;
        } else {
          ({ userId, user } = await verifyToken(socket, token));
          socket.data.userId = userId.toString();
          socket.data.user   = user;
        }

        if (!taskId) {
          socket.emit('socket_error', { message: 'taskId is required' });
          return;
        }

        const task = await Task.findOne({
          _id:          taskId,
          organization: user.organization,
          createdBy:    userId,   // manager must own the task
        }).select('room status assignedTo');

        if (!task) {
          socket.emit('socket_error', {
            message: 'Task not found. Make sure you created this task.',
          });
          return;
        }

        const room = `task_location:${task.room.toString()}:${taskId}`;
        socket.join(room);

        socket.data.role   = 'manager';
        socket.data.taskId = taskId;
        socket.data.room   = room;

        socket.emit('watching_task_location', {
          room,
          taskId,
          taskStatus: task.status,
        });
        console.log(`[WS] manager ${userId} watching ${room}`);

      } catch (err) {
        console.error(`[WS] watch_task_location error: ${err.message}`);
        socket.emit('socket_error', { message: err.message });
      }
    });

    // ─── MANAGER: stop watching ──────────────────────────────────────────────
    socket.on('unwatch_task_location', (payload = {}) => {
      if (socket.data.room) {
        socket.leave(socket.data.room);
        console.log(`[WS] manager ${socket.data.userId} left ${socket.data.room}`);
        socket.data.room = null;
      }
    });

    // ─── Cleanup on disconnect ────────────────────────────────────────────────
    socket.on('disconnect', (reason) => {
      console.log(`[WS] disconnected sid=${socket.id} role=${socket.data.role ?? 'anon'} reason=${reason}`);
    });
  });
}

module.exports = { registerSocketHandlers };