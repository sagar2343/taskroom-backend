const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ─────────────────────────────────────────────────────────────────────────────
//  verifyCloudinaryConnection
//  Called once at server startup — prints ✅ or ❌ to Render logs so you know
//  immediately whether the env vars are loaded correctly.
// ─────────────────────────────────────────────────────────────────────────────
const verifyCloudinaryConnection = async () => {
  try {
    await cloudinary.api.ping();
    console.log('✅ Cloudinary connected — cloud:', process.env.CLOUDINARY_CLOUD_NAME);
  } catch (err) {
    console.error('❌ Cloudinary connection FAILED:', err.message);
    console.error('   Check CLOUDINARY_CLOUD_NAME / API_KEY / API_SECRET in Render env vars');
  }
};

// ─────────────────────────────────────────────────────────────────────────────
//  uploadToCloudinary
//  Converts a multer memory Buffer to a base64 data URI and uploads it.
//  Using upload() instead of upload_stream — simpler, no stream lifecycle issues.
//
//  Compression strategy (no visible quality loss):
//    quality: 'auto:eco'  → Cloudinary picks the smallest quality that looks sharp
//    fetch_format: 'auto' → serves WebP to Android (~30% smaller than JPEG)
//    transformation[]     → only geometric ops (resize/crop) — no delivery params here
// ─────────────────────────────────────────────────────────────────────────────
const uploadToCloudinary = async (buffer, mimeType = 'image/jpeg', options = {}) => {
  const b64     = Buffer.from(buffer).toString('base64');
  const dataUri = `data:${mimeType};base64,${b64}`;

  console.log(`[Cloudinary] Uploading ${(buffer.length / 1024).toFixed(1)} KB (${mimeType})`);

  const result = await cloudinary.uploader.upload(dataUri, {
    resource_type: 'image',
    quality:       'auto:eco',
    fetch_format:  'auto',
    ...options,          // caller options last so they can override defaults above
  });

  console.log(`[Cloudinary] ✅ Done → ${result.secure_url}`);
  console.log(`[Cloudinary]    Size: ${(result.bytes / 1024).toFixed(1)} KB | Format: ${result.format}`);

  return result.secure_url;
};

module.exports = { uploadToCloudinary, verifyCloudinaryConnection };