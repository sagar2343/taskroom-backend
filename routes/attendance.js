'use strict';
// fieldwork-backend/routes/attendance.js
//
// All attendance endpoints — mounted at /api/attendance in server.js

const express    = require('express');
const mongoose   = require('mongoose');
const Attendance = require('../models/Attendance');
const Task       = require('../models/Task');
const User       = require('../models/User');
const authMiddleware = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

const isValidObjectId = id => mongoose.Types.ObjectId.isValid(id);

// ── helper ────────────────────────────────────────────────────────────────────
const todayStart = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

// const dateRange = (dateStr) => {
//   const d = new Date(dateStr);
//   d.setHours(0, 0, 0, 0);
//   const next = new Date(d);
//   next.setDate(next.getDate() + 1);
//   return { start: d, end: next };
// };

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/attendance/go-online
//  Employee marks themselves online. Creates today's record if needed.
//  Also triggered automatically when a task is started (method: auto_task_start).
// ─────────────────────────────────────────────────────────────────────────────
router.post('/go-online', async (req, res) => {
  try {
    const { coordinates, method = 'manual', taskId } = req.body;

    const record = await Attendance.getOrCreateToday(req.userId, req.user.organization);

    if (record.isOnline) {
      return res.json({
        success:  true,
        message:  'Already online',
        data:     { attendance: record, alreadyOnline: true },
      });
    }

    await record.goOnline(coordinates, method);

    if (taskId && !record.firstTaskId) {
      record.firstTaskId = taskId;
      await record.save();
    }

    // Set user.isOnline = true
    await User.findByIdAndUpdate(req.userId, { isOnline: true });

    // Refresh task stats
    await Attendance.refreshTaskStats(req.userId, req.user.organization);

    const updated = await Attendance.findById(record._id)
      .populate('employee', 'username fullName profilePicture');

    res.json({
      success: true,
      message: 'You are now online',
      data:    { attendance: updated },
    });
  } catch (err) {
    console.error('go-online error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/attendance/go-offline
//  Blocks if the employee has any task in_progress.
//  Otherwise closes the open session and computes total.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/go-offline', async (req, res) => {
  try {
    const { coordinates, force = false } = req.body;

    // Block if active task exists (unless force = true, reserved for admin)
    if (!force) {
      const activeTask = await Task.findOne({
        assignedTo:   req.userId,
        organization: req.user.organization,
        status:       'in_progress',
      }).select('title');

      if (activeTask) {
        return res.status(400).json({
          success: false,
          message: `You have an active task "${activeTask.title}". Please complete or hand it over before going offline.`,
          data:    { blockedByTask: activeTask._id },
        });
      }
    }

    const record = await Attendance.getOrCreateToday(req.userId, req.user.organization);

    if (!record.isOnline) {
      return res.json({
        success:      true,
        message:      'Already offline',
        data:         { attendance: record, alreadyOffline: true },
      });
    }

    await record.goOffline(coordinates);

    // Refresh productivity stats on logout
    await Attendance.refreshTaskStats(req.userId, req.user.organization);

    // Set user.isOnline = false
    await User.findByIdAndUpdate(req.userId, { isOnline: false });

    const updated = await Attendance.findById(record._id)
      .populate('employee', 'username fullName profilePicture');

    res.json({
      success: true,
      message: 'You are now offline',
      data: {
        attendance:     updated,
        totalMinutes:   updated.totalMinutes,
        totalFormatted: updated.totalFormatted,
      },
    });
  } catch (err) {
    console.error('go-offline error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/attendance/today
//  Current employee's today record + task counts.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/today', async (req, res) => {
  try {
    const start  = todayStart();
    const record = await Attendance.findOne({
      employee: req.userId,
      workDate: { $gte: start },
    }).populate('employee', 'username fullName profilePicture');

    // Live task counts (always fresh)
    const [completed, inProgress, assigned] = await Promise.all([
      Task.countDocuments({ assignedTo: req.userId, organization: req.user.organization, status: 'completed' }),
      Task.countDocuments({ assignedTo: req.userId, organization: req.user.organization, status: 'in_progress' }),
      Task.countDocuments({ assignedTo: req.userId, organization: req.user.organization, status: { $nin: ['cancelled'] } }),
    ]);

    res.json({
      success: true,
      message: 'ok',
      data: {
        attendance:      record || null,
        isOnline:        record?.isOnline ?? false,
        totalMinutes:    record?.totalMinutes ?? 0,
        totalFormatted:  record?.totalFormatted ?? '0m',
        sessions:        record?.sessions ?? [],
        taskStats: {
          completed,
          inProgress,
          assigned,
          completionRate: assigned > 0 ? Math.round((completed / assigned) * 100) : 0,
        },
      },
    });
  } catch (err) {
    console.error('attendance/today error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/attendance/history
//  Employee's own history OR manager querying a specific employee.
//  Query params: page, limit, from (YYYY-MM-DD), to (YYYY-MM-DD), month (YYYY-MM), employeeId
// ─────────────────────────────────────────────────────────────────────────────
router.get('/history', async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 31;
    const skip  = (page - 1) * limit;

    let query = { organization: req.user.organization };

    // Determine whose history
    if (req.user.role === 'employee') {
      query.employee = req.userId;
    } else if (req.query.employeeId && isValidObjectId(req.query.employeeId)) {
      query.employee = req.query.employeeId;
    } else {
      // Manager with no employeeId → return their own org summary (all employees)
      // (handled by /org-summary)
      query.employee = req.userId;
    }

    // Date range
    if (req.query.from && req.query.to) {
      const from = new Date(req.query.from); from.setHours(0, 0, 0, 0);
      const to   = new Date(req.query.to);   to.setHours(23, 59, 59, 999);
      query.workDate = { $gte: from, $lte: to };
    } else if (req.query.month) {
      const [year, month] = req.query.month.split('-').map(Number);
      query.workDate = {
        $gte: new Date(year, month - 1, 1),
        $lt:  new Date(year, month, 1),
      };
    }

    const [records, total] = await Promise.all([
      Attendance.find(query)
        .populate('employee', 'username fullName profilePicture')
        .sort({ workDate: -1 })
        .skip(skip)
        .limit(limit),
      Attendance.countDocuments(query),
    ]);

    // Aggregate totals for the period
    const aggResult = await Attendance.aggregate([
      { $match: query },
      { $group: {
          _id: null,
          totalMinutes:    { $sum: '$totalMinutes' },
          totalDays:       { $sum: 1 },
        //   presentDays:     { $sum: { $cond: [{ $gt: ['$totalMinutes', 0] }, 1, 0] } },
          // BUG-FIX: also count today if session is still open (isOnline=true, totalMinutes=0)
          // presentDays: { $sum: { $cond: [{ $or: [{ $gt: ['$totalMinutes', 0] }, { $eq: ['$isOnline', true] }] }, 1, 0] } },
          presentDays: { $sum: { $cond: [{ $or: [{ $gt: ['$tasksCompleted', 0] }, { $gte: ['$totalMinutes', 30] }] }, 1, 0] } },
          // presentDays: { $sum: { $cond: [ { $gt: ['$tasksCompleted', 0] }, 1, 0] } },
          tasksCompleted:  { $sum: '$tasksCompleted' },
      }},
    ]);
    const agg = aggResult[0] || { totalMinutes: 0, totalDays: 0, presentDays: 0, tasksCompleted: 0 };
    const totalHours = parseFloat((agg.totalMinutes / 60).toFixed(2));

    res.json({
      success: true,
      message: 'ok',
      data: {
        records,
        summary: {
          totalDays:      agg.totalDays,
          presentDays:    agg.presentDays,
          absentDays:     agg.totalDays - agg.presentDays,
          totalMinutes:   Math.round(agg.totalMinutes),
          totalHours,
          avgHoursPerDay: agg.presentDays > 0
            ? parseFloat((totalHours / agg.presentDays).toFixed(2))
            : 0,
          tasksCompleted: agg.tasksCompleted,
        },
        pagination: {
          currentPage: page,
          totalPages:  Math.ceil(total / limit),
          total,
          limit,
        },
      },
    });
  } catch (err) {
    console.error('attendance/history error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/attendance/org-today   [Manager only]
//  All employees in the org with their today's status, total hours, task counts.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/org-today', async (req, res) => {
  try {
    if (req.user.role !== 'manager') {
      return res.status(403).json({ success: false, message: 'Manager access only' });
    }

    const start = todayStart();

    // All employees in org
    const employees = await User.find({
      organization: req.user.organization,
      role: 'employee',
    }).select('_id username fullName profilePicture isOnline department designation');

    // Today's attendance records
    const todayRecords = await Attendance.find({
      organization: req.user.organization,
      workDate: { $gte: start },
    });

    const recordMap = {};
    for (const r of todayRecords) {
      recordMap[r.employee.toString()] = r;
    }

    // Live task counts per employee
    const taskCounts = await Task.aggregate([
      {
        $match: {
          organization: req.user.organization,
          assignedTo:   { $in: employees.map(e => e._id) },
        },
      },
      {
        $group: {
          _id:       '$assignedTo',
          total:     { $sum: { $cond: [{ $ne: ['$status', 'cancelled'] }, 1, 0] } },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          active:    { $sum: { $cond: [{ $eq: ['$status', 'in_progress'] }, 1, 0] } },
        },
      },
    ]);

    const taskMap = {};
    for (const t of taskCounts) taskMap[t._id.toString()] = t;

    const result = employees.map(emp => {
      const rec   = recordMap[emp._id.toString()];
      const tasks = taskMap[emp._id.toString()] || { total: 0, completed: 0, active: 0 };
      const isOnlineNow = rec?.isOnline ?? false;
      return {
        employee: {
          _id:         emp._id,
          username:    emp.username,
          fullName:    emp.fullName,
          profilePicture: emp.profilePicture,
          department:  emp.department,
          designation: emp.designation,
          isOnline: isOnlineNow,
        },
        attendance: rec
          ? {
              isOnline:       rec.isOnline,
              totalMinutes:   rec.totalMinutes,
              totalFormatted: rec.totalFormatted,
              sessions:       rec.sessions.length,
              firstOnline:    rec.sessions[0]?.startTime ?? null,
            }
          : { isOnline: false, totalMinutes: 0, sessions: 0 },
        taskStats: {
          total:     tasks.total,
          completed: tasks.completed,
          active:    tasks.active,
          completionRate: tasks.total > 0
            ? Math.round((tasks.completed / tasks.total) * 100)
            : 0,
        },
      };
    });

    // Summary counts
    const onlineCount = result.filter(r => r.employee.isOnline).length;
    const offlineCount = result.length - onlineCount;

    res.json({
      success: true,
      message: 'ok',
      data: {
        employees: result,
        summary: {
          total:   result.length,
          online:  onlineCount,
          offline: offlineCount,
          date:    start,
        },
      },
    });
  } catch (err) {
    console.error('org-today error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/attendance/employee/:id   [Manager only]
//  Manager views a specific employee's history + stats.
//  Query params: month (YYYY-MM) | from + to (YYYY-MM-DD)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/employee/:id', async (req, res) => {
  try {
    if (req.user.role !== 'manager') {
      return res.status(403).json({ success: false, message: 'Manager access only' });
    }
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid employee ID' });
    }

    const employee = await User.findOne({
      _id:          req.params.id,
      organization: req.user.organization,
      role:         'employee',
    }).select('username fullName profilePicture department designation isOnline employeeId');

    if (!employee) {
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }

    let dateQuery = {};
    if (req.query.from && req.query.to) {
      const from = new Date(req.query.from); from.setHours(0, 0, 0, 0);
      const to   = new Date(req.query.to);   to.setHours(23, 59, 59, 999);
      dateQuery = { $gte: from, $lte: to };
    } else if (req.query.month) {
      // BUG-FIX: Flutter sends ?month=YYYY-MM — handle it so navigating to
      // previous months actually queries the right data.
      const [year, month] = req.query.month.split('-').map(Number);
      dateQuery = {
        $gte: new Date(year, month - 1, 1),
        $lt:  new Date(year, month, 1),
      };
    } else {
      // Default: current month
      const now   = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const end   = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      dateQuery = { $gte: start, $lt: end };
    }

    const [records, taskStats] = await Promise.all([
      Attendance.find({
        employee:     req.params.id,
        organization: req.user.organization,
        workDate:     dateQuery,
      }).sort({ workDate: -1 }),

      Task.aggregate([
        {
          $match: {
            assignedTo:   employee._id,
            organization: req.user.organization,
          },
        },
        {
          $group: {
            _id:       null,
            total: { $sum: { $cond: [{ $ne: ['$status', 'cancelled'] }, 1, 0] } },
            completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
            active:    { $sum: { $cond: [{ $eq: ['$status', 'in_progress'] }, 1, 0] } },
            pending:   { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
          },
        },
      ]),
    ]);

    // Period aggregate
    const agg = await Attendance.aggregate([
      {
        $match: {
          employee:     employee._id,
          organization: req.user.organization,
          workDate:     dateQuery,
        },
      },
      {
        $group: {
          _id:          null,
          totalMinutes: { $sum: '$totalMinutes' },
        //   presentDays:  { $sum: { $cond: [{ $gt: ['$totalMinutes', 0] }, 1, 0] } },
        // BUG-FIX: also count today if session is still open (isOnline=true, totalMinutes=0)
          presentDays:  { $sum: { $cond: [{ $or: [{ $gt: ['$totalMinutes', 0] }, { $eq: ['$isOnline', true] }] }, 1, 0] } },
          totalDays:    { $sum: 1 },
        },
      },
    ]);

    const periodSummary = agg[0] || { totalMinutes: 0, presentDays: 0, totalDays: 0 };
    const tasks         = taskStats[0] || { total: 0, completed: 0, active: 0, pending: 0 };

    res.json({
      success: true,
      message: 'ok',
      data: {
        employee,
        records,
        periodSummary: {
          totalDays:      periodSummary.totalDays,
          presentDays:    periodSummary.presentDays,
          absentDays:     periodSummary.totalDays - periodSummary.presentDays,
          totalMinutes:   Math.round(periodSummary.totalMinutes),
          totalHours:     parseFloat((periodSummary.totalMinutes / 60).toFixed(2)),
          avgHoursPerDay: periodSummary.presentDays > 0
            ? parseFloat((periodSummary.totalMinutes / 60 / periodSummary.presentDays).toFixed(2))
            : 0,
        },
        taskStats: {
          total:          tasks.total,
          completed:      tasks.completed,
          active:         tasks.active,
          pending:        tasks.pending,
          completionRate: tasks.total > 0
            ? Math.round((tasks.completed / tasks.total) * 100)
            : 0,
        },
      },
    });
  } catch (err) {
    console.error('attendance/employee/:id error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;