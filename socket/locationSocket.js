// socket/locationSocket.js
//
// Room naming convention:  "task_location:{roomId}"
//
// ── Employee ────────────────────────────────────────────────────────────────
//  • emit  "join_task_location"   { token, taskId }
//    → server joins socket to "task_location:{roomId}" and stores employee meta
//  • emit  "location_update"      { taskId, stepId, lat, lng, accuracy?, battery? }
//    → server re-broadcasts to same room as "employee_location"
//    → everyone in the room (manager) gets real-time position
//  • emit  "leave_task_location"  { taskId }
//    → cleanly leaves the room
//
// ── Manager ─────────────────────────────────────────────────────────────────
//  • emit  "watch_task_location"  { token, taskId }
//    → server joins socket to same "task_location:{roomId}"
//    → starts receiving "employee_location" broadcasts
//  • emit  "unwatch_task_location" { taskId }
//    → leaves room
//
// ── Server → Client broadcasts ──────────────────────────────────────────────
//  "employee_location"  { taskId, stepId, lat, lng, accuracy, battery, timestamp }
//  "tracking_stopped"   { taskId, reason }   (on task complete / cancel)

const jwt      = require('jsonwebtoken');
const Task     = require('../models/Task');
const User     = require('../models/User');

// ── Helper: verify JWT and return { userId, user } or throw ──────────────────
async function verifyToken(token) {
  if (!token) throw new Error('No token');
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  const user    = await User.findById(decoded.userId).select('-password');
  if (!user) throw new Error('User not found');
  return { userId: user._id, user };
}

// ── Helper: resolve the Socket.IO room name from a taskId ───────────────────
async function roomNameForTask(taskId, organizationId) {
  const task = await Task.findOne({ _id: taskId, organization: organizationId })
    .select('room');
  if (!task) throw new Error('Task not found');
  return `task_location:${task.room.toString()}:${taskId}`;
}

// ── Main export ──────────────────────────────────────────────────────────────
function registerSocketHandlers(io) {

  io.on('connection', (socket) => {
    console.log(`[WS] connected: ${socket.id}`);

    // ── EMPLOYEE: join real-time tracking room ──────────────────────────────
    socket.on('join_task_location', async ({ token, taskId } = {}) => {
      try {
        const { userId, user } = await verifyToken(token);

        // Must be an employee and the task must be assigned to them
        const task = await Task.findOne({
          _id: taskId,
          organization: user.organization,
          assignedTo: userId,
          status: 'in_progress'
        }).select('room isFieldWork status');

        if (!task) {
          socket.emit('error', { message: 'Active task not found' });
          return;
        }

        const room = `task_location:${task.room.toString()}:${taskId}`;
        socket.join(room);

        // Stash on socket for later reference
        socket.data.role   = 'employee';
        socket.data.userId = userId.toString();
        socket.data.taskId = taskId;
        socket.data.room   = room;

        socket.emit('joined_task_location', { room, taskId });
        console.log(`[WS] Employee ${userId} joined ${room}`);

      } catch (err) {
        socket.emit('error', { message: err.message });
      }
    });

    // ── EMPLOYEE: broadcast current GPS position ────────────────────────────
    socket.on('location_update', ({ taskId, stepId, lat, lng, accuracy, battery } = {}) => {
      if (!socket.data.room || socket.data.taskId !== taskId) return;

      const payload = {
        taskId,
        stepId,
        lat,
        lng,
        accuracy: accuracy ?? null,
        battery:  battery  ?? null,
        timestamp: new Date().toISOString(),
      };

      // Broadcast to every socket in the room (including manager, excluding sender)
      socket.to(socket.data.room).emit('employee_location', payload);
    });

    // ── EMPLOYEE: leave room ────────────────────────────────────────────────
    socket.on('leave_task_location', ({ taskId } = {}) => {
      if (socket.data.room) {
        socket.leave(socket.data.room);
        console.log(`[WS] Employee ${socket.data.userId} left ${socket.data.room}`);
        socket.data.room = null;
      }
    });

    // ── MANAGER: watch an employee's location ──────────────────────────────
    socket.on('watch_task_location', async ({ token, taskId } = {}) => {
      try {
        const { userId, user } = await verifyToken(token);

        // Must be manager and must own the task
        const task = await Task.findOne({
          _id: taskId,
          organization: user.organization,
          createdBy: userId,
        }).select('room status assignedTo');

        if (!task) {
          socket.emit('error', { message: 'Task not found' });
          return;
        }

        const room = `task_location:${task.room.toString()}:${taskId}`;
        socket.join(room);

        socket.data.role   = 'manager';
        socket.data.userId = userId.toString();
        socket.data.taskId = taskId;
        socket.data.room   = room;

        socket.emit('watching_task_location', { room, taskId, taskStatus: task.status });
        console.log(`[WS] Manager ${userId} watching ${room}`);

      } catch (err) {
        socket.emit('error', { message: err.message });
      }
    });

    // ── MANAGER: stop watching ──────────────────────────────────────────────
    socket.on('unwatch_task_location', ({ taskId } = {}) => {
      if (socket.data.room) {
        socket.leave(socket.data.room);
        console.log(`[WS] Manager ${socket.data.userId} stopped watching ${socket.data.room}`);
        socket.data.room = null;
      }
    });

    // ── Disconnect cleanup ──────────────────────────────────────────────────
    socket.on('disconnect', () => {
      console.log(`[WS] disconnected: ${socket.id} (${socket.data.role ?? 'unknown'})`);
      // Socket.IO automatically removes it from all rooms — no action needed
    });
  });
}

module.exports = { registerSocketHandlers };