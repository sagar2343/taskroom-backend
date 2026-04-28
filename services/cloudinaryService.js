const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Upload a Buffer to Cloudinary using a base64 data URI.
 * More reliable than upload_stream — no piping, no stream lifecycle issues.
 *
 * @param {Buffer} buffer       - image buffer from multer memoryStorage
 * @param {string} mimeType     - e.g. 'image/jpeg', 'image/png'
 * @param {Object} options      - cloudinary upload options (folder, public_id, transformation, etc.)
 * @returns {Promise<string>}   - secure_url of the uploaded image
 */
const uploadToCloudinary = async (buffer, mimeType = 'image/jpeg', options = {}) => {
  // Convert buffer → base64 data URI (Cloudinary accepts this directly)
  const b64     = Buffer.from(buffer).toString('base64');
  const dataUri = `data:${mimeType};base64,${b64}`;

  const result = await cloudinary.uploader.upload(dataUri, {
    resource_type: 'image',
    // quality + fetch_format are TOP-LEVEL delivery params, NOT inside transformation[]
    quality:      'auto',
    fetch_format: 'auto',
    ...options,
  });

  return result.secure_url;
};

module.exports = { uploadToCloudinary };