'use strict';

const Attendance = require('../models/Attendance');
const Task = require('../models/Task');
const User = require('../models/User');

/**
 * Runs at midnight (right after the task auto-expire sweep — see
 * services/taskAutoCancelService.js — so this sees the up-to-date task
 * statuses for the day that just ended).
 *
 * Finds every employee who is still marked "online" (an open attendance
 * session from yesterday that was never manually closed — e.g. they forgot
 * to tap "Go Offline", or the app was killed) and closes their session,
 * EXCEPT employees who currently have a task with status 'in_progress'
 * assigned to them — those are genuinely still working and must stay
 * online uninterrupted.
 *
 * This does NOT touch employees who are already offline, and it does NOT
 * touch anyone's task data — it only closes attendance sessions.
 *
 * Safe to call repeatedly (idempotent) — only ever acts on records where
 * isOnline is currently true.
 */
async function runIdleAttendanceSweep() {
  const summary = { checked: 0, forcedOffline: 0, skippedActive: 0, failed: 0, errors: [] };

  // Every attendance record anywhere still showing an open session.
  const onlineRecords = await Attendance.find({ isOnline: true });
  summary.checked = onlineRecords.length;

  if (onlineRecords.length === 0) return summary;

  const employeeIds = onlineRecords.map((r) => r.employee);

  // Employees who currently have ANY in-progress task — these must be
  // left online no matter what.
  const activeTaskEmployeeIds = await Task.distinct('assignedTo', {
    assignedTo: { $in: employeeIds },
    status: 'in_progress',
  });
  const activeSet = new Set(activeTaskEmployeeIds.map((id) => id.toString()));

  for (const record of onlineRecords) {
    const empId = record.employee.toString();

    if (activeSet.has(empId)) {
      summary.skippedActive += 1;
      continue;
    }

    try {
      await record.goOffline(); // closes the open session, recomputes totalMinutes
      await User.findByIdAndUpdate(record.employee, { isOnline: false });
      summary.forcedOffline += 1;
    } catch (err) {
      summary.failed += 1;
      summary.errors.push({ employeeId: empId, message: err.message });
      console.error(`[IdleAttendanceSweep] Failed to close session for ${empId}:`, err.message);
    }
  }

  if (summary.forcedOffline > 0 || summary.failed > 0) {
    console.log(
      `[IdleAttendanceSweep] checked=${summary.checked} forcedOffline=${summary.forcedOffline} ` +
      `skippedActive=${summary.skippedActive} failed=${summary.failed}`
    );
  }

  return summary;
}

module.exports = { runIdleAttendanceSweep };