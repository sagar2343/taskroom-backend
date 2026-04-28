const express  = require('express');
const authMiddleware      = require('../middleware/auth');
const upload              = require('../middleware/multerUpload');
const { uploadToCloudinary } = require('../services/cloudinaryService');
const User = require('../models/User');

const router = express.Router();
router.use(authMiddleware);

// ── POST /api/upload/profile-picture ──────────────────────────────────────────
// Accepts:  multipart/form-data  field name: "image"
// Returns:  { success, data: { url } }
// Side-effect: updates User.profilePicture in DB
router.post('/profile-picture', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No image provided' });
    }

    const url = await uploadToCloudinary(req.file.buffer, {
      folder: 'fieldwork/profiles',
      public_id: `user_${req.userId}`,   // one permanent slot per user → auto-overwrite
      overwrite: true,
      transformation: [
        { width: 400, height: 400, crop: 'fill', gravity: 'face' },
        { quality: 'auto', fetch_format: 'auto' },
      ],
    });

    // Persist in DB so GET /api/user/profile returns the updated picture
    await User.findByIdAndUpdate(req.userId, { profilePicture: url });

    res.json({
      success: true,
      message: 'Profile picture uploaded',
      data: { url },
    });
  } catch (err) {
    console.error('Profile picture upload error:', err);
    res.status(500).json({ success: false, message: 'Upload failed' });
  }
});

// ── POST /api/upload/step-photo ───────────────────────────────────────────────
// Accepts:  multipart/form-data  field name: "image"
//           optional body fields: taskId, stepId  (forwarded for naming)
// Returns:  { success, data: { url } }
// The caller then passes the url as `photoUrl` to POST /api/tasks/steps/complete
router.post('/step-photo', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No image provided' });
    }

    const { taskId = 'unknown', stepId = 'unknown' } = req.body;

    const url = await uploadToCloudinary(req.file.buffer, {
      folder: 'fieldwork/step-photos',
      public_id: `step_${taskId}_${stepId}_${Date.now()}`,
      transformation: [
        { width: 1280, crop: 'limit' },
        { quality: 'auto', fetch_format: 'auto' },
      ],
    });

    res.json({
      success: true,
      message: 'Photo uploaded',
      data: { url },
    });
  } catch (err) {
    console.error('Step photo upload error:', err);
    res.status(500).json({
    success: false,
    message: err.message || 'Upload failed',
  });
  }
});

module.exports = router;