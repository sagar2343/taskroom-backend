'use strict';

const Task = require('../models/Task');
const Room = require('../models/Room');
const User = require('../models/User');
const { sendToUser } = require('./notificationService');

// Your business "day" is India-local (IST = UTC+5:30), regardless of what
// timezone the server itself happens to run in (most hosts default to UTC).
// This returns the UTC instant that corresponds to today's 12:00 AM IST.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function getStartOfTodayIST() {
  const now = new Date();
  const shifted = new Date(now.getTime() + IST_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0); // midnight, in the shifted (IST) frame
  return new Date(shifted.getTime() - IST_OFFSET_MS); // back to a real UTC instant
}

/**
 * Finds every task across every organization whose end DATE (not just end
 * time) has fully passed — i.e. the task's endDatetime falls on a calendar
 * day before today (IST) — and which was never completed/cancelled, and
 * auto-cancels it.
 *
 * Example: a task ending 7 Aug 6:00 PM stays untouched all through 7 Aug,
 * even after 6 PM passes. It only gets cancelled once the sweep runs on or
 * after 8 Aug 12:00 AM IST.
 *
 * Safe to call repeatedly (idempotent) — only ever touches tasks currently
 * in 'pending' or 'in_progress', so a task already cancelled/completed is
 * never re-processed.
 *
 * Returns a small summary object, useful both for server logs and for the
 * JSON response of the cron-triggered API endpoint.
 */
async function runTaskAutoCancelSweep() {
  const startOfTodayIST = getStartOfTodayIST();
  const summary = { checked: 0, cancelled: 0, failed: 0, errors: [] };

  const overdueTasks = await Task.find({
    status: { $in: ['pending', 'in_progress'] },
    endDatetime: { $lt: startOfTodayIST }, // ended on a day before today
  }).select('_id title room assignedTo status endDatetime');

  summary.checked = overdueTasks.length;

  for (const task of overdueTasks) {
    try {
      task.status = 'cancelled';
      task.cancelledAt = new Date();
      task.cancelledBy = null; // null = system/auto, not a manager action
      task.cancellationReason = 'Auto-cancelled: task end date passed without completion';
      await task.save();

      await Room.findByIdAndUpdate(task.room, {
        $inc: { 'stats.activeTasks': -1 },
      });

      // Notify the employee it was assigned to, if any
      if (task.assignedTo) {
        const employee = await User.findById(task.assignedTo).select('fcmToken');
        if (employee) {
          sendToUser(employee, 'TASK_CANCELLED', [task.title, 'Task expired'], {
            type: 'task_cancelled',
            taskId: task._id.toString(),
            reason: 'auto_expired',
          });
        }
      }

      summary.cancelled += 1;
    } catch (err) {
      summary.failed += 1;
      summary.errors.push({ taskId: task._id.toString(), message: err.message });
      console.error(`[AutoCancelSweep] Failed to cancel task ${task._id}:`, err.message);
    }
  }

  if (summary.cancelled > 0 || summary.failed > 0) {
    console.log(`[AutoCancelSweep] checked=${summary.checked} cancelled=${summary.cancelled} failed=${summary.failed}`);
  }

  return summary;
}

module.exports = { runTaskAutoCancelSweep };