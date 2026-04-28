const express                = require('express');
const authMiddleware         = require('../middleware/auth');
const upload                 = require('../middleware/multerUpload');
const { uploadToCloudinary } = require('../services/cloudinaryService');
const User                   = require('../models/User');

const router = express.Router();
router.use(authMiddleware);

// ─────────────────────────────────────────────────────────────────────────────
//  multerSingle — wraps upload.single() so multer errors return JSON.
//
//  By default, multer calls next(err) on failure which hits Express's built-in
//  error handler and returns an HTML 500 page. This wrapper intercepts that
//  and converts it to a proper { success: false, message } JSON response.
// ─────────────────────────────────────────────────────────────────────────────
const multerSingle = (fieldName) => (req, res, next) => {
  upload.single(fieldName)(req, res, (err) => {
    if (!err) return next();

    console.error('[Multer error]', err.message);

    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        success: false,
        message: 'Image too large. Maximum allowed size is 5 MB.',
      });
    }
    return res.status(400).json({
      success: false,
      message: err.message || 'File upload error',
    });
  });
};

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/upload/health
//  Hit this in a browser to verify Cloudinary credentials work.
//  Does not require a file — just pings the Cloudinary API.
//  e.g. https://taskroom-backend.onrender.com/api/upload/health
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/upload/profile-picture
//  Accepts:     multipart/form-data  field name: "image"
//  Returns:     { success, data: { url } }
//  Side-effect: updates User.profilePicture in MongoDB
//  Optimised:   400×400 face-crop → ~15-30 KB WebP on Android
// ─────────────────────────────────────────────────────────────────────────────
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
        public_id:      `user_${req.userId}`,   // one slot per user → auto-overwrites
        overwrite:      true,
        transformation: [
          { width: 400, height: 400, crop: 'fill', gravity: 'face' },
        ],
      }
    );

    await User.findByIdAndUpdate(req.userId, { profilePicture: url });

    res.json({
      success: true,
      message: 'Profile picture uploaded successfully',
      data:    { url },
    });
  } catch (err) {
    console.error('[Upload] profile-picture error:', err.message, '\n', err.stack);
    res.status(500).json({ success: false, message: err.message || 'Upload failed' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/upload/step-photo
//  Accepts:  multipart/form-data  field name: "image"
//            optional body fields: taskId, stepId
//  Returns:  { success, data: { url } }
//  Caller:   passes the returned url as photoUrl to POST /api/tasks/steps/complete
//  Optimised: max 1280px wide → ~80-150 KB WebP on Android (was 3-8 MB raw)
// ─────────────────────────────────────────────────────────────────────────────
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
          { width: 1280, height: 1280, crop: 'limit' },  // never upscales
        ],
      }
    );

    res.json({
      success: true,
      message: 'Photo uploaded successfully',
      data:    { url },
    });
  } catch (err) {
    console.error('[Upload] step-photo error:', err.message, '\n', err.stack);
    res.status(500).json({ success: false, message: err.message || 'Upload failed' });
  }
});

module.exports = router;