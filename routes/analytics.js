'use strict';
// routes/analytics.js
//
// Productivity scores and manager dashboard data.
// Mounted at /api/analytics in server.js

const express      = require('express');
const mongoose     = require('mongoose');
const Attendance   = require('../models/Attendance');
const Task         = require('../models/Task');
const User         = require('../models/User');
const Organization = require('../models/Organization');
const authMiddleware  = require('../middleware/auth');
const { isManager }   = require('../middleware/roleCheck');
const { requireFeature } = require('../middleware/planGate');

const router = express.Router();
router.use(authMiddleware, isManager);

// ─── Helpers ───────────────────────────────────────────────────────────────────
const weekStart = () => {
  const d = new Date();
  d.setDate(d.getDate() - d.getDay() + (d.getDay() === 0 ? -6 : 1)); // Mon
  d.setHours(0, 0, 0, 0);
  return d;
};
const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); d.setHours(0, 0, 0, 0); return d; };

// ─── Productivity score formula ────────────────────────────────────────────────
// Score (0–100) = 50% task completion rate + 50% hours worked (capped at 9h/day = 100%)
function calcScore(tasksCompleted, tasksAssigned, totalMinutes, daysPresent) {
  const taskRate  = tasksAssigned > 0 ? Math.min(tasksCompleted / tasksAssigned, 1) : 0;
  const avgHrs    = daysPresent > 0 ? (totalMinutes / 60) / daysPresent : 0;
  const hoursRate = Math.min(avgHrs / 9, 1);
  return Math.round((taskRate * 50) + (hoursRate * 50));
}

// ═══════════════════════════════════════════════════════════════════════════════
//  GET /api/analytics/overview
//  Manager dashboard — today's snapshot
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/overview', async (req, res) => {
  try {
    const orgId   = req.user.organization;
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayEnd   = new Date(); todayEnd.setHours(23, 59, 59, 999);

    const [
      totalEmployees,
      onlineNow,
      todayAttendance,
      tasksToday,
      overdueTasks,
    ] = await Promise.all([
      User.countDocuments({ organization: orgId, role: 'employee' }),
      // onlineNow: employees with an active open session right now
      Attendance.countDocuments({ organization: orgId, workDate: { $gte: todayStart }, isOnline: true }),
      // todayAttendance: employees who clocked in at any point today (including those now offline)
      Attendance.countDocuments({ organization: orgId, workDate: { $gte: todayStart } }),
      Task.countDocuments({ organization: orgId, createdAt: { $gte: todayStart, $lte: todayEnd } }),
      Task.countDocuments({
        organization: orgId,
        status: { $in: ['pending', 'in_progress'] },
        endDatetime: { $lt: new Date() },
      }),
    ]);

    // Task breakdown for today
    const taskBreakdown = await Task.aggregate([
      { $match: { organization: new mongoose.Types.ObjectId(orgId), createdAt: { $gte: todayStart } } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);
    const taskMap = Object.fromEntries(taskBreakdown.map(t => [t._id, t.count]));

    res.json({
      success: true,
      data: {
        timestamp:      new Date(),
        totalEmployees,
        onlineNow,
        attendanceToday:  todayAttendance,
        attendanceRate:   totalEmployees ? Math.round((todayAttendance / totalEmployees) * 100) : 0,
        tasksToday,
        overdueTasks,
        taskBreakdown: {
          pending:     taskMap.pending     || 0,
          in_progress: taskMap.in_progress || 0,
          completed:   taskMap.completed   || 0,
          cancelled:   taskMap.cancelled   || 0,
        },
      },
    });
  } catch (err) {
    console.error('analytics/overview error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  GET /api/analytics/productivity
//  Weekly productivity scores per employee (requires pro+)
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/productivity', requireFeature('performanceDashboard'), async (req, res) => {
  try {
    const orgId = new mongoose.Types.ObjectId(req.user.organization);

    // Default: current week. Support ?from=&to= for custom range
    const from = req.query.from ? new Date(req.query.from) : weekStart();
    const to   = req.query.to   ? new Date(req.query.to)   : new Date();
    to.setHours(23, 59, 59, 999);

    // Aggregate attendance stats per employee
    const attStats = await Attendance.aggregate([
      { $match: { organization: orgId, workDate: { $gte: from, $lte: to } } },
      { $group: {
          _id:            '$employee',
          totalMinutes:   { $sum: '$totalMinutes' },
          daysPresent:    { $sum: { $cond: [{ $gt: ['$totalMinutes', 0] }, 1, 0] } },
          tasksCompleted: { $sum: '$tasksCompleted' },
          tasksAssigned:  { $sum: '$tasksAssigned' },
      }},
    ]);

    // Fetch all org employees
    const employees = await User.find({ organization: req.user.organization, role: 'employee' })
      .select('fullName username employeeId department designation profilePicture isOnline');

    const empMap = Object.fromEntries(attStats.map(a => [a._id.toString(), a]));

    const scores = employees.map(emp => {
      const stats = empMap[emp._id.toString()] || {};
      const score = calcScore(
        stats.tasksCompleted || 0,
        stats.tasksAssigned  || 0,
        stats.totalMinutes   || 0,
        stats.daysPresent    || 0,
      );

      return {
        employeeId:     emp._id,
        fullName:       emp.fullName || emp.username,
        empIdCode:      emp.employeeId,
        department:     emp.department,
        designation:    emp.designation,
        profilePicture: emp.profilePicture,
        isOnline:       emp.isOnline,
        stats: {
          daysPresent:    stats.daysPresent    || 0,
          totalHours:     parseFloat(((stats.totalMinutes || 0) / 60).toFixed(1)),
          avgHoursPerDay: stats.daysPresent
            ? parseFloat(((stats.totalMinutes || 0) / 60 / stats.daysPresent).toFixed(1))
            : 0,
          tasksCompleted: stats.tasksCompleted || 0,
          tasksAssigned:  stats.tasksAssigned  || 0,
          completionRate: stats.tasksAssigned
            ? Math.round((stats.tasksCompleted / stats.tasksAssigned) * 100)
            : 0,
        },
        score,
        grade: score >= 80 ? 'A' : score >= 60 ? 'B' : score >= 40 ? 'C' : 'D',
      };
    });

    // Sort by score desc
    scores.sort((a, b) => b.score - a.score);

    res.json({
      success: true,
      data: {
        period: { from, to },
        scores,
        summary: {
          avgScore:     scores.length ? Math.round(scores.reduce((s, e) => s + e.score, 0) / scores.length) : 0,
          topPerformer: scores[0] || null,
          gradeDistribution: scores.reduce((m, e) => { m[e.grade] = (m[e.grade] || 0) + 1; return m; }, {}),
        },
      },
    });
  } catch (err) {
    console.error('analytics/productivity error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  GET /api/analytics/employee/:id
//  Single employee detail card (30-day view)
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/employee/:id', async (req, res) => {
  try {
    const orgId = req.user.organization;
    const empId = req.params.id;

    if (!mongoose.Types.ObjectId.isValid(empId)) {
      return res.status(400).json({ success: false, message: 'Invalid employee ID' });
    }

    const emp = await User.findOne({ _id: empId, organization: orgId, role: 'employee' })
      .select('-password');
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

    const from = daysAgo(30);
    const to   = new Date();
    to.setHours(23, 59, 59, 999);

    const [attendance, tasks] = await Promise.all([
      Attendance.find({ employee: empId, workDate: { $gte: from } }).sort({ workDate: -1 }).limit(30),
      Task.find({ assignedTo: empId, organization: orgId, createdAt: { $gte: from } }).sort({ createdAt: -1 }),
    ]);

    const totalMinutes  = attendance.reduce((s, a) => s + (a.totalMinutes || 0), 0);
    const daysPresent   = attendance.filter(a => a.totalMinutes > 0).length;
    const tasksDone     = tasks.filter(t => t.status === 'completed').length;
    const tasksTotal    = tasks.filter(t => t.status !== 'cancelled').length;
    const score         = calcScore(tasksDone, tasksTotal, totalMinutes, daysPresent);

    // Daily chart data (last 14 days)
    const chartData = Array.from({ length: 14 }, (_, i) => {
      const d = daysAgo(13 - i);
      const rec = attendance.find(a => {
        const wd = new Date(a.workDate);
        return wd.toDateString() === d.toDateString();
      });
      return {
        date:    d.toISOString().slice(0, 10),
        hours:   rec ? parseFloat((rec.totalMinutes / 60).toFixed(1)) : 0,
        tasks:   rec ? rec.tasksCompleted : 0,
        present: !!rec && rec.totalMinutes > 0,
      };
    });

    res.json({
      success: true,
      data: {
        employee: emp,
        period:   { from, to },
        summary: {
          daysPresent,
          totalHours:    parseFloat((totalMinutes / 60).toFixed(1)),
          avgHoursPerDay: daysPresent ? parseFloat((totalMinutes / 60 / daysPresent).toFixed(1)) : 0,
          tasksCompleted: tasksDone,
          tasksAssigned:  tasksTotal,
          completionRate: tasksTotal ? Math.round((tasksDone / tasksTotal) * 100) : 0,
          score,
          grade: score >= 80 ? 'A' : score >= 60 ? 'B' : score >= 40 ? 'C' : 'D',
        },
        chartData,
        recentTasks: tasks.slice(0, 10).map(t => ({
          id:       t._id,
          title:    t.title,
          status:   t.status,
          priority: t.priority,
          dueDate:  t.endDatetime,
        })),
      },
    });
  } catch (err) {
    console.error('analytics/employee error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  GET /api/analytics/trends?days=7|14|30
//  Org-level trend data for charts
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/trends', async (req, res) => {
  try {
    const orgId  = new mongoose.Types.ObjectId(req.user.organization);
    const days   = Math.min(parseInt(req.query.days) || 14, 30);
    const from   = daysAgo(days - 1);

    const [attDaily, taskDaily] = await Promise.all([
      Attendance.aggregate([
        { $match: { organization: orgId, workDate: { $gte: from } } },
        { $group: {
            _id:       { $dateToString: { format: '%Y-%m-%d', date: '$workDate' } },
            present:   { $sum: { $cond: [{ $gt: ['$totalMinutes', 0] }, 1, 0] } },
            totalHrs:  { $sum: { $divide: ['$totalMinutes', 60] } },
            tasksDone: { $sum: '$tasksCompleted' },
        }},
        { $sort: { _id: 1 } },
      ]),
      Task.aggregate([
        { $match: { organization: orgId, createdAt: { $gte: from } } },
        { $group: {
            _id:       { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            created:   { $sum: 1 },
            completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
        }},
        { $sort: { _id: 1 } },
      ]),
    ]);

    // Fill in gaps so chart has a point for every day
    const attMap  = Object.fromEntries(attDaily.map(d => [d._id, d]));
    const taskMap = Object.fromEntries(taskDaily.map(d => [d._id, d]));

    const trendData = Array.from({ length: days }, (_, i) => {
      const d   = daysAgo(days - 1 - i);
      const key = d.toISOString().slice(0, 10);
      const a   = attMap[key]  || {};
      const t   = taskMap[key] || {};
      return {
        date:       key,
        present:    a.present   || 0,
        totalHrs:   parseFloat((a.totalHrs || 0).toFixed(1)),
        tasksDone:  a.tasksDone || 0,
        created:    t.created   || 0,
        completed:  t.completed || 0,
      };
    });

    res.json({ success: true, data: { days, trendData } });
  } catch (err) {
    console.error('analytics/trends error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
