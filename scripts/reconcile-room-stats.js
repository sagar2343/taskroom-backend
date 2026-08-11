/**
 * ONE-OFF fix for room.stats drift (e.g. the "Tasks" room showing -3/-6
 * Active tasks). Recomputes stats.{totalTasks, activeTasks, completedTasks}
 * directly from the real Task collection for one room, or every room.
 *
 * Usage:
 *   node scripts/reconcile-room-stats.js <roomId>      # fix one room
 *   node scripts/reconcile-room-stats.js --all         # fix every room
 *
 * Run from inside your backend project folder (reuses your existing .env).
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { reconcileRoomStats, reconcileAllRoomStats } = require('../services/roomStatsReconcileService');

async function main() {
  const arg = process.argv[2];

  if (!arg) {
    console.error('Usage: node scripts/reconcile-room-stats.js <roomId>  |  --all');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to DB.');

  if (arg === '--all') {
    const summary = await reconcileAllRoomStats();
    console.log(`\nChecked ${summary.totalRoomsChecked} rooms, fixed ${summary.roomsFixed}.\n`);
    for (const r of summary.fixed) {
      console.log(`✅ ${r.roomName} (${r.roomId})`);
      console.log(`   totalTasks:     ${r.before.totalTasks} → ${r.after.totalTasks}`);
      console.log(`   activeTasks:    ${r.before.activeTasks} → ${r.after.activeTasks}`);
      console.log(`   completedTasks: ${r.before.completedTasks} → ${r.after.completedTasks}\n`);
    }
  } else {
    const result = await reconcileRoomStats(arg);
    if (!result) {
      console.error('Room not found.');
      process.exit(1);
    }
    console.log(`\nRoom: ${result.roomName} (${result.roomId})`);
    console.log(`totalTasks:     ${result.before.totalTasks} → ${result.after.totalTasks}`);
    console.log(`activeTasks:    ${result.before.activeTasks} → ${result.after.activeTasks}`);
    console.log(`completedTasks: ${result.before.completedTasks} → ${result.after.completedTasks}`);
    console.log(result.changed ? '\n✅ Fixed.' : '\n✅ Already correct — no change needed.');
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('❌ Error:', err);
  process.exit(1);
});