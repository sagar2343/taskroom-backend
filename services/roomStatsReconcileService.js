'use strict';

const Room = require('../models/Room');
const Task = require('../models/Task');

/**
 * Room.stats.{totalTasks, activeTasks, completedTasks} are DENORMALIZED
 * counters — maintained by scattered +1/-1 $inc calls across task creation,
 * cancellation, completion, auto-expiry, and admin deletion. That's fast to
 * read, but it means any historical bug, race condition, or edge case in
 * ANY of those code paths can leave the stored number permanently wrong —
 * nothing ever re-derives it from the real Task documents on its own.
 *
 * This function is the fix for that: it recomputes the three stats directly
 * from Task.aggregate() (the actual source of truth) and overwrites
 * whatever's currently stored, regardless of how it got wrong.
 *
 *   totalTasks     = every task ever created in this room, any status
 *   activeTasks    = status is 'pending' or 'in_progress' (genuinely live)
 *   completedTasks = status is 'completed'
 *
 * ('cancelled' and 'expired' tasks count toward totalTasks but not
 * activeTasks/completedTasks — same convention the increment code already
 * used, just now guaranteed correct instead of hoped correct.)
 */
async function reconcileRoomStats(roomId) {
  const room = await Room.findById(roomId);
  if (!room) return null;

  const counts = await Task.aggregate([
    { $match: { room: room._id } },
    {
      $group: {
        _id: null,
        totalTasks: { $sum: 1 },
        activeTasks: {
          $sum: { $cond: [{ $in: ['$status', ['pending', 'in_progress']] }, 1, 0] },
        },
        completedTasks: {
          $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] },
        },
      },
    },
  ]);

  const c = counts[0] || { totalTasks: 0, activeTasks: 0, completedTasks: 0 };

  const before = {
    totalTasks: room.stats.totalTasks,
    activeTasks: room.stats.activeTasks,
    completedTasks: room.stats.completedTasks,
  };

  room.stats.totalTasks = c.totalTasks;
  room.stats.activeTasks = c.activeTasks;
  room.stats.completedTasks = c.completedTasks;
  await room.save();

  return {
    roomId: room._id.toString(),
    roomName: room.name,
    before,
    after: { totalTasks: c.totalTasks, activeTasks: c.activeTasks, completedTasks: c.completedTasks },
    changed:
      before.totalTasks !== c.totalTasks ||
      before.activeTasks !== c.activeTasks ||
      before.completedTasks !== c.completedTasks,
  };
}

/** Reconciles every room platform-wide. Returns a summary + per-room results for any room that actually changed. */
async function reconcileAllRoomStats() {
  const rooms = await Room.find().select('_id');
  const results = [];

  for (const r of rooms) {
    try {
      const result = await reconcileRoomStats(r._id);
      if (result?.changed) results.push(result);
    } catch (err) {
      console.error(`[RoomStatsReconcile] Failed for room ${r._id}:`, err.message);
    }
  }

  return { totalRoomsChecked: rooms.length, roomsFixed: results.length, fixed: results };
}

module.exports = { reconcileRoomStats, reconcileAllRoomStats };