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
 * day before today (IST) — and which was never completed, and marks it
 * 'expired'.
 *
 * 'expired' is a distinct status from 'cancelled':
 *   - 'cancelled'  → a manager deliberately called the cancel endpoint.
 *   - 'expired'    → nobody acted; the deadline simply passed. This is
 *                    what this sweep sets, and it's what counts against an
 *                    employee's performance stats (see routes/attendance.js).
 *
 * Example: a task ending 7 Aug 6:00 PM stays untouched all through 7 Aug,
 * even after 6 PM passes. It only becomes 'expired' once the sweep runs on
 * or after 8 Aug 12:00 AM IST.
 *
 * CONCURRENCY SAFETY: this uses an atomic findOneAndUpdate per task, guarded
 * by `status: { $in: ['pending','in_progress'] }` at write time — not just
 * at the initial find. If this sweep somehow runs twice at once (e.g. an
 * old and new server instance briefly overlapping during a Render deploy
 * that lands near midnight, or a race against a manager manually
 * cancelling/completing the same task), only the FIRST write to reach Mongo
 * for a given task succeeds; the second one's guard condition no longer
 * matches (status is already 'expired'), so it's a no-op — Room.stats is
 * only ever decremented once per task, never twice. This is what actually
 * prevents the "activeTasks went negative" bug, regardless of what
 * triggered a double-run.
 *
 * Returns a small summary object, useful both for server logs and for the
 * JSON response of the cron-triggered API endpoint.
 */
async function runTaskAutoCancelSweep() {
  const startOfTodayIST = getStartOfTodayIST();
  const summary = { checked: 0, expired: 0, skippedAlreadyHandled: 0, failed: 0, errors: [] };

  const overdueTasks = await Task.find({
    status: { $in: ['pending', 'in_progress'] },
    endDatetime: { $lt: startOfTodayIST }, // ended on a day before today
  }).select('_id title room assignedTo createdBy status endDatetime');

  summary.checked = overdueTasks.length;

  for (const task of overdueTasks) {
    try {
      // Atomic compare-and-swap: only actually update if this task is
      // STILL pending/in_progress at the moment of the write (not just at
      // the moment of the earlier find above). This is what makes the
      // whole operation safe against concurrent sweep executions.
      const updated = await Task.findOneAndUpdate(
        { _id: task._id, status: { $in: ['pending', 'in_progress'] } },
        {
          $set: {
            status: 'expired',
            cancelledAt: new Date(), // reused field — see models/Task.js comment
            cancelledBy: null,       // null = system, not a manager action
            cancellationReason: 'Auto-expired: task end date passed without completion',
          },
        },
        { new: false } // we want the pre-update doc back, to know it existed
      );

      if (!updated) {
        // Another process (a concurrent sweep run, or a manager's manual
        // cancel/complete action) already changed this task's status
        // between our find() above and this write. Correctly do nothing —
        // whichever write got there first already handled Room.stats.
        summary.skippedAlreadyHandled += 1;
        continue;
      }

      await Room.findByIdAndUpdate(task.room, {
        $inc: { 'stats.activeTasks': -1 },
      });

      // Notify both sides — the employee who missed it, and the manager
      // who assigned it — so nobody is left wondering what happened.
      const notifyIds = [task.assignedTo, task.createdBy].filter(Boolean);
      const recipients = await User.find({ _id: { $in: notifyIds } }).select('fcmToken');
      for (const recipient of recipients) {
        sendToUser(recipient, 'TASK_EXPIRED', [task.title], {
          type: 'task_expired',
          taskId: task._id.toString(),
        });
      }

      summary.expired += 1;
    } catch (err) {
      summary.failed += 1;
      summary.errors.push({ taskId: task._id.toString(), message: err.message });
      console.error(`[AutoCancelSweep] Failed to expire task ${task._id}:`, err.message);
    }
  }

  if (summary.expired > 0 || summary.failed > 0 || summary.skippedAlreadyHandled > 0) {
    console.log(
      `[AutoCancelSweep] checked=${summary.checked} expired=${summary.expired} ` +
      `skippedAlreadyHandled=${summary.skippedAlreadyHandled} failed=${summary.failed}`
    );
  }

  return summary;
}

module.exports = { runTaskAutoCancelSweep };