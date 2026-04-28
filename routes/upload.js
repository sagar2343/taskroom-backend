const express                = require('express');
const authMiddleware         = require('../middleware/auth');
const upload                 = require('../middleware/multerUpload');
const { uploadToCloudinary } = require('../services/cloudinaryService');
const User                   = require('../models/User');

const router = express.Router();
router.use(authMiddleware);

// ── Helper: wraps multer so its errors return JSON instead of Express HTML page ──
// multer calls next(err) on failure which hits Express's default HTML handler.
// This wrapper intercepts that and converts it to a proper JSON response.
const multerSingle = (fieldName) => (req, res, next) => {
  upload.single(fieldName)(req, res, (err) => {
    if (!err) return next();             // success — continue to route handler

    console.error('[Multer error]', err.message);

    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        success: false,
        message: 'Image too large. Maximum size is 5 MB.',
      });
    }
    return res.status(400).json({
      success: false,
      message: err.message || 'File upload error',
    });
  });
};

// ── GET /api/upload/health ─────────────────────────────────────────────────────
// Quick sanity-check: confirms Cloudinary credentials work.
// Hit this in Postman/browser to verify before testing from the app.
router.get('/health', async (req, res) => {
  try {
    const cloudinary = require('cloudinary').v2;
    const result     = await cloudinary.api.ping();
    res.json({
      success: true,
      message: 'Cloudinary connected',
      status:  result.status,
      cloud:   process.env.CLOUDINARY_CLOUD_NAME,
    });
  } catch (err) {
    console.error('[Health] Cloudinary ping failed:', err.message);
    res.status(500).json({
      success: false,
      message: 'Cloudinary connection failed: ' + err.message,
    });
  }
});

// ── POST /api/upload/profile-picture ──────────────────────────────────────────
router.post('/profile-picture', multerSingle('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No image provided' });
    }

    console.log('[Upload] profile-picture → size:', req.file.size, 'mime:', req.file.mimetype);

    const url = await uploadToCloudinary(
      req.file.buffer,
      req.file.mimetype,
      {
        folder:         'fieldwork/profiles',
        public_id:      `user_${req.userId}`,
        overwrite:      true,
        transformation: [
          { width: 400, height: 400, crop: 'fill', gravity: 'face' },
        ],
      }
    );

    await User.findByIdAndUpdate(req.userId, { profilePicture: url });

    res.json({ success: true, message: 'Profile picture uploaded', data: { url } });
  } catch (err) {
    console.error('[Upload] profile-picture error:', err.message, err.stack);
    res.status(500).json({ success: false, message: err.message || 'Upload failed' });
  }
});

// ── POST /api/upload/step-photo ───────────────────────────────────────────────
router.post('/step-photo', multerSingle('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No image provided' });
    }

    const { taskId = 'unknown', stepId = 'unknown' } = req.body;
    console.log('[Upload] step-photo → taskId:', taskId, 'stepId:', stepId,
                'size:', req.file.size, 'mime:', req.file.mimetype);

    const url = await uploadToCloudinary(
      req.file.buffer,
      req.file.mimetype,
      {
        folder:         'fieldwork/step-photos',
        public_id:      `step_${taskId}_${stepId}_${Date.now()}`,
        transformation: [
          { width: 1280, height: 1280, crop: 'limit' },
        ],
      }
    );

    res.json({ success: true, message: 'Photo uploaded', data: { url } });
  } catch (err) {
    console.error('[Upload] step-photo error:', err.message, err.stack);
    res.status(500).json({ success: false, message: err.message || 'Upload failed' });
  }
});

module.exports = router;