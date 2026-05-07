// fieldwork-backend/models/Attendance.js
//
// Replaces the inline Attendance schema in Locationtrace.js.
// Supports multiple online/offline sessions per day (go-online → go-offline → go-online …)
// and aggregates task productivity stats.

'use strict';
const mongoose = require('mongoose');

// ─── Session sub-schema ───────────────────────────────────────────────────────
// One entry per "go-online / go-offline" pair.
const sessionSchema = new mongoose.Schema({
  startTime: { type: Date, required: true },
  endTime:   { type: Date, default: null },   // null = still online

  startLocation: {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number], default: undefined },
  },
  endLocation: {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number], default: undefined },
  },

  // How many minutes this session lasted (set on go-offline)
  durationMinutes: { type: Number, default: null },

  method: {
    type:    String,
    enum:    ['manual', 'auto_task_start'],
    default: 'manual',
  },
}, { _id: false });

// ─── Main Attendance schema ───────────────────────────────────────────────────
const attendanceSchema = new mongoose.Schema({
  organization: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'Organization',
    required: true,
  },
  employee: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'User',
    required: true,
  },

  // Work date stored at midnight UTC so date-only queries are simple
  workDate: { type: Date, required: true },

  // All online/offline sessions for this day
  sessions: { type: [sessionSchema], default: [] },

  // Aggregated totals (recomputed on every go-offline)
  totalMinutes: { type: Number, default: 0 },   // sum of all closed sessions
  isOnline:     { type: Boolean, default: false }, // true = an open session exists

  // Productivity snapshot (updated on go-offline and at day-end)
  tasksCompleted: { type: Number, default: 0 },
  tasksAssigned:  { type: Number, default: 0 },
  tasksInProgress:{ type: Number, default: 0 },

  // Task that auto-triggered first session (if any)
  firstTaskId: {
    type:    mongoose.Schema.Types.ObjectId,
    ref:     'Task',
    default: null,
  },

  notes: { type: String, default: null },

  // ── Legacy fields kept for backward compat with existing task.js code ──────
  punchInTime:  { type: Date, default: null },
  punchOutTime: { type: Date, default: null },
  totalHours:   { type: Number, default: null },
  punchInMethod:{ type: String, default: 'manual' },

}, { timestamps: true });

// Indexes
attendanceSchema.index({ employee: 1, workDate: -1 });
attendanceSchema.index({ organization: 1, workDate: -1 });
attendanceSchema.index({ employee: 1, workDate: 1 }, { unique: true }); // one record per day per employee

// ─── Instance Methods ─────────────────────────────────────────────────────────

/** Start a new session (go online). Idempotent if already online. */
attendanceSchema.methods.goOnline = async function(coordinates, method = 'manual') {
  // Already has an open session → no-op
  if (this.isOnline) return this;

  const session = {
    startTime: new Date(),
    method,
  };
  if (coordinates) {
    session.startLocation = { type: 'Point', coordinates };
  }

  this.sessions.push(session);
  this.isOnline = true;

  // Keep legacy field in sync
  if (!this.punchInTime) {
    this.punchInTime    = session.startTime;
    this.punchInMethod  = method;
  }

  return await this.save();
};

/** End the current open session (go offline). */
attendanceSchema.methods.goOffline = async function(coordinates) {
  if (!this.isOnline) return this;

  // ✅ Safe for all Node versions
  let openIdx = -1;
  for (let i = this.sessions.length - 1; i >= 0; i--) {
    if (!this.sessions[i].endTime) { openIdx = i; break; }
  }

  if (openIdx === -1) {
    this.isOnline = false;
    return await this.save();
  }

  const now = new Date();
  const diffMs = now - this.sessions[openIdx].startTime;
  const mins   = parseFloat((diffMs / 60000).toFixed(2));

  this.sessions[openIdx].endTime          = now;
  this.sessions[openIdx].durationMinutes  = mins;
  if (coordinates) {
    this.sessions[openIdx].endLocation = { type: 'Point', coordinates };
  }

  this.isOnline      = false;
  this.totalMinutes  = this.sessions.reduce((sum, s) => sum + (s.durationMinutes || 0), 0);
  this.totalHours    = parseFloat((this.totalMinutes / 60).toFixed(2)); // legacy

  // Legacy fields
  if (!this.punchOutTime) {
    this.punchOutTime = now;
  }

  return await this.save();
};

/** Recompute totalMinutes (call after manual data fixes). */
attendanceSchema.methods.recompute = function() {
  this.totalMinutes = this.sessions.reduce((s, sess) => s + (sess.durationMinutes || 0), 0);
  this.totalHours   = parseFloat((this.totalMinutes / 60).toFixed(2));
};

/** Convenience: formatted total like "3h 25m". */
attendanceSchema.virtual('totalFormatted').get(function() {
  const mins = Math.round(this.totalMinutes || 0);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
});

// ─── Static helpers ───────────────────────────────────────────────────────────

/** Get or create today's record for an employee. */
attendanceSchema.statics.getOrCreateToday = async function(employeeId, organizationId) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);

  let record = await this.findOne({ employee: employeeId, workDate: { $gte: start } });
  if (!record) {
    record = new this({
      organization: organizationId,
      employee:     employeeId,
      workDate:     start,
    });
    await record.save();
  }
  return record;
};

/** Snapshot task counts onto today's record. */
attendanceSchema.statics.refreshTaskStats = async function(employeeId, organizationId) {
  const Task   = mongoose.model('Task');

  const start = new Date();
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  const record = await this.findOne({
    employee: employeeId,
    workDate: { $gte: start }
  });

  if (!record) return;

  const [completed, inProgress, assigned] = await Promise.all([
    Task.countDocuments({
      assignedTo: employeeId,
      organization: organizationId,
      status: 'completed',
      completedAt: {
        $gte: start,
        $lt: end
      }
    }),

    Task.countDocuments({
      assignedTo: employeeId,
      organization: organizationId,
      status: 'in_progress'
    }),

    Task.countDocuments({
      assignedTo: employeeId,
      organization: organizationId,
      startDatetime: {
        $gte: start,
        $lt: end
      },
      status: { $nin: ['cancelled'] }
    }),
  ]);

  record.tasksCompleted  = completed;
  record.tasksInProgress = inProgress;
  record.tasksAssigned   = assigned;

  await record.save();
};

module.exports = mongoose.model('Attendance', attendanceSchema);