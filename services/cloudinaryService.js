const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Ping Cloudinary to verify credentials are loaded correctly.
 * Call this once at server startup.
 */
const verifyCloudinaryConnection = async () => {
  try {
    await cloudinary.api.ping();
    console.log('✅ Cloudinary connected — cloud:', process.env.CLOUDINARY_CLOUD_NAME);
  } catch (err) {
    console.error('❌ Cloudinary connection FAILED:', err.message);
    console.error('   Check CLOUDINARY_CLOUD_NAME / API_KEY / API_SECRET in .env');
  }
};

/**
 * Upload a Buffer to Cloudinary using base64 data URI.
 * Only uses confirmed-valid top-level params: quality + fetch_format.
 * Transformation array handles geometric resizing only.
 */
const uploadToCloudinary = async (buffer, mimeType = 'image/jpeg', options = {}) => {
  const b64     = Buffer.from(buffer).toString('base64');
  const dataUri = `data:${mimeType};base64,${b64}`;

  console.log(`[Cloudinary] Uploading ${(buffer.length / 1024).toFixed(1)} KB (${mimeType})`);

  const result = await cloudinary.uploader.upload(dataUri, {
    resource_type: 'image',
    quality:       'auto:eco',   // smallest file that still looks sharp
    fetch_format:  'auto',       // WebP on Android (~30% smaller than JPEG)
    ...options,
  });

  console.log(`[Cloudinary] Done → ${result.secure_url}`);
  console.log(`[Cloudinary] Original: ${result.bytes} bytes | Format: ${result.format}`);
  return result.secure_url;
};

module.exports = { uploadToCloudinary, verifyCloudinaryConnection };