// routes/fcmToken.js
//
// Routes for registering / removing device FCM tokens.
// Mount in server.js:   app.use('/api/user', require('./routes/fcmToken'));
// (Sits alongside the existing /api/user routes — same prefix.)
//
// Endpoints:
//   POST   /api/fcm/fcm-token    — save token after app login or token refresh
//   DELETE /api/fcm/fcm-token    — clear token on logout
//   GET    /api/fcm/fcm-token    — (dev only) check current stored token

const express    = require('express');
const User       = require('../models/User');
const authMiddleware = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// ─── POST /api/fcm/fcm-token ─────────────────────────────────────────────────
// Call this:
//   • Once after login (pass the token you got from FirebaseMessaging.getToken())
//   • Again whenever FirebaseMessaging.onTokenRefresh() fires
//
// Body: { token: "<FCM_TOKEN>" }
// Response: { success: true, message: "FCM token saved" }
router.post('/fcm-token', async (req, res) => {
  try {
    const { token } = req.body;

    if (!token || typeof token !== 'string' || token.trim().length < 20) {
      return res.status(400).json({
        success: false,
        message: 'A valid FCM token is required',
      });
    }

    // Update the token — upsert-style so it works regardless of previous state
    await User.findByIdAndUpdate(req.userId, {
      fcmToken: token.trim(),
    });

    console.log(`[FCM] Token saved for user ${req.userId}`);

    return res.json({
      success: true,
      message: 'FCM token saved',
    });

  } catch (err) {
    console.error('[FCM] Save token error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── DELETE /api/fcm/fcm-token ───────────────────────────────────────────────
// Call this on logout so we stop sending notifications to the device.
router.delete('/fcm-token', async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.userId, {
      $unset: { fcmToken: '' },
    });

    console.log(`[FCM] Token cleared for user ${req.userId}`);

    return res.json({
      success: true,
      message: 'FCM token removed',
    });

  } catch (err) {
    console.error('[FCM] Remove token error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /api/fcm/fcm-token ──────────────────────────────────────────────────
// Dev helper — returns masked token to confirm it's stored.
// Remove or protect with an env guard before going to production.
router.get('/fcm-token', async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('fcmToken');
    const raw  = user?.fcmToken;
    return res.json({
      success: true,
      hasToken: !!raw,
      maskedToken: raw ? `${raw.slice(0, 12)}…${raw.slice(-6)}` : null,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;