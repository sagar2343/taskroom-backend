const admin = require('firebase-admin');

// ── Initialise once ───────────────────────────────────────────────────────────
// Guard prevents re-initialisation on hot-reload in dev
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // .env stores \n literally — replace so the key parses correctly
      privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

const messaging = admin.messaging();

// ── Notification catalogue ────────────────────────────────────────────────────
// Every event type that the app sends. Add new types here — never scatter
// title/body strings across route files.

const NOTIFICATIONS = {

  // ── Manager → Employee ────────────────────────────────────────────────────

  TASK_ASSIGNED: (taskTitle, managerName) => ({
    title: '📋 New Task Assigned',
    body:  `${managerName} assigned you "${taskTitle}"`,
    sound: 'default',
  }),

  TASK_UPDATED: (taskTitle, managerName) => ({
    title: '✏️ Task Updated',
    body:  `${managerName} updated your task "${taskTitle}"`,
    sound: 'default',
  }),

  TASK_CANCELLED: (taskTitle, reason) => ({
    title: '❌ Task Cancelled',
    body:  reason
      ? `"${taskTitle}" was cancelled: ${reason}`
      : `Your task "${taskTitle}" has been cancelled`,
    sound: 'default',
  }),

  STEP_ADDED: (taskTitle, stepTitle) => ({
    title: '➕ New Step Added',
    body:  `A new step "${stepTitle}" was added to "${taskTitle}"`,
    sound: 'default',
  }),

  STEP_UPDATED: (taskTitle, stepTitle) => ({
    title: '✏️ Step Updated',
    body:  `Step "${stepTitle}" in "${taskTitle}" was updated`,
    sound: 'default',
  }),

  // ── Employee → Manager ────────────────────────────────────────────────────

  TASK_STARTED: (employeeName, taskTitle) => ({
    title: '🚀 Task Started',
    body:  `${employeeName} started "${taskTitle}"`,
    sound: 'default',
  }),

  STEP_STARTED: (employeeName, taskTitle, stepTitle) => ({
    title: '▶️ Step Started',
    body:  `${employeeName} started step "${stepTitle}" in "${taskTitle}"`,
    sound: 'default',
  }),

  STEP_REACHED: (employeeName, taskTitle, stepTitle) => ({
    title: '📍 Destination Reached',
    body:  `${employeeName} reached the destination for "${stepTitle}" in "${taskTitle}"`,
    sound: 'default',
  }),

  STEP_COMPLETED: (employeeName, taskTitle, stepTitle, isLast) => ({
    title: isLast ? '✅ All Steps Done!' : '✅ Step Completed',
    body:  isLast
      ? `${employeeName} completed all steps in "${taskTitle}" 🎉`
      : `${employeeName} completed "${stepTitle}" in "${taskTitle}"`,
    sound: 'default',
  }),

  TASK_COMPLETED: (employeeName, taskTitle) => ({
    title: '🎉 Task Completed!',
    body:  `${employeeName} has completed "${taskTitle}"`,
    sound: 'default',
  }),
};

// ── Low-level send ────────────────────────────────────────────────────────────

/**
 * Send a push notification to a single FCM token.
 *
 * @param {string}  fcmToken   - Device FCM token stored on the User document
 * @param {object}  notification  - { title, body, sound? }
 * @param {object}  data       - Key-value string pairs (extras for the app)
 * @returns {Promise<{success:boolean, messageId?:string, error?:string}>}
 */
async function sendToToken(fcmToken, notification, data = {}) {
  if (!fcmToken) {
    return { success: false, error: 'No FCM token' };
  }

  // Stringify all data values — FCM requires strings
  const stringData = {};
  for (const [k, v] of Object.entries(data)) {
    stringData[k] = String(v ?? '');
  }

  const message = {
    token: fcmToken,
    notification: {
      title: notification.title,
      body:  notification.body,
    },
    // Android config — high priority wakes the device even in Doze
    android: {
      priority: 'high',
      notification: {
        sound:       notification.sound ?? 'default',
        channelId:   'fieldwork_tasks',   // must match the channel created in Flutter
        clickAction: 'FLUTTER_NOTIFICATION_CLICK',
      },
    },
    // APNs config for iOS
    apns: {
      payload: {
        aps: {
          sound: notification.sound ?? 'default',
          badge: 1,
          contentAvailable: true,
        },
      },
      headers: {
        'apns-priority': '10',
      },
    },
    data: stringData,
  };

  try {
    const messageId = await messaging.send(message);
    console.log(`[FCM] ✅ Sent to ${fcmToken.slice(0, 20)}… — ${messageId}`);
    return { success: true, messageId };
  } catch (err) {
    // FCM error codes that mean the token is stale — auto-clear them
    const staleErrors = [
      'messaging/registration-token-not-registered',
      'messaging/invalid-registration-token',
    ];
    const isStale = staleErrors.includes(err.code);
    console.error(`[FCM] ❌ Send failed (${err.code}): ${err.message}`);
    return { success: false, error: err.message, staleToken: isStale };
  }
}

/**
 * Send a notification to a User document directly.
 * Handles the DB lookup, stale-token cleanup, and logging.
 *
 * @param {object}  user         - Mongoose User document (must have fcmToken field)
 * @param {string}  type         - Key from NOTIFICATIONS catalogue
 * @param {Array}   args         - Arguments forwarded to the catalogue function
 * @param {object}  data         - Extra data payload for the Flutter app
 */
async function sendToUser(user, type, args = [], data = {}) {
  if (!user?.fcmToken) return;

  const builder = NOTIFICATIONS[type];
  if (!builder) {
    console.warn(`[FCM] Unknown notification type: ${type}`);
    return;
  }

  const notification = builder(...args);
  const result = await sendToToken(user.fcmToken, notification, data);

  // If the token is stale, clear it from the DB to save future attempts
  if (result.staleToken) {
    try {
      await user.constructor.findByIdAndUpdate(user._id, { $unset: { fcmToken: '' } });
      console.log(`[FCM] Cleared stale token for user ${user._id}`);
    } catch (_) { /* non-critical */ }
  }
}

/**
 * Send the same notification to multiple users in parallel.
 * Silently skips users without a token.
 */
async function sendToUsers(users, type, args = [], data = {}) {
  if (!users?.length) return;
  await Promise.allSettled(
    users.map(u => sendToUser(u, type, args, data))
  );
}

module.exports = {
  NOTIFICATIONS,
  sendToToken,
  sendToUser,
  sendToUsers,
};