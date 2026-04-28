const express            = require('express');
const authMiddleware     = require('../middleware/auth');
const upload             = require('../middleware/multerUpload');
const { uploadToCloudinary } = require('../services/cloudinaryService');
const User               = require('../models/User');

const router = express.Router();
router.use(authMiddleware);

// ── POST /api/upload/profile-picture ──────────────────────────────────────────
// Optimised: 400×400 face-crop  →  ~15-30 KB WebP on Android
router.post('/profile-picture', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No image provided' });
    }

    const url = await uploadToCloudinary(
      req.file.buffer,
      req.file.mimetype,
      {
        folder:    'fieldwork/profiles',
        public_id: `user_${req.userId}`,
        overwrite: true,
        transformation: [
          // 1. Resize: cap to 400×400 with smart face-detection crop
          { width: 400, height: 400, crop: 'fill', gravity: 'face' },
        ],
      }
    );

    await User.findByIdAndUpdate(req.userId, { profilePicture: url });

    res.json({
      success: true,
      message: 'Profile picture uploaded',
      data: { url },
    });
  } catch (err) {
    console.error('Profile picture upload error:', err.message);
    res.status(500).json({ success: false, message: err.message || 'Upload failed' });
  }
});

// ── POST /api/upload/step-photo ───────────────────────────────────────────────
// Optimised: max 1280px wide  →  ~80-150 KB WebP on Android (was often 3-8 MB raw)
router.post('/step-photo', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No image provided' });
    }

    const { taskId = 'unknown', stepId = 'unknown' } = req.body;

    const url = await uploadToCloudinary(
      req.file.buffer,
      req.file.mimetype,
      {
        folder:    'fieldwork/step-photos',
        public_id: `step_${taskId}_${stepId}_${Date.now()}`,
        transformation: [
          // 1. Resize: cap longest side to 1280px, never upscale
          { width: 1280, height: 1280, crop: 'limit' },
        ],
      }
    );

    res.json({
      success: true,
      message: 'Photo uploaded',
      data: { url },
    });
  } catch (err) {
    console.error('Step photo upload error:', err.message);
    res.status(500).json({ success: false, message: err.message || 'Upload failed' });
  }
});

module.exports = router;