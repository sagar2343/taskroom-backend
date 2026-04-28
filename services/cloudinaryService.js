const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Upload a Buffer to Cloudinary with size optimisation.
 *
 * Valid top-level delivery params used:
 *   quality:      'auto:eco'  → smallest file that still looks sharp
 *   fetch_format: 'auto'      → WebP on Android (~30% smaller than JPEG)
 *   flags:        'progressive:strip_icc'
 *                              → progressive JPEG + strips ICC/colour profile
 *                                (ICC profiles alone add 3–60 KB per image)
 *
 * Metadata/EXIF stripping is done via the 'strip_icc' flag (valid) — full EXIF
 * stripping requires Cloudinary's "metadata" add-on or is handled automatically
 * when the image is re-encoded (quality + format change always drops raw EXIF).
 */
const uploadToCloudinary = async (buffer, mimeType = 'image/jpeg', options = {}) => {
  const b64     = Buffer.from(buffer).toString('base64');
  const dataUri = `data:${mimeType};base64,${b64}`;

  const result = await cloudinary.uploader.upload(dataUri, {
    resource_type: 'image',
    quality:       'auto:eco',
    fetch_format:  'auto',
    flags:         'progressive:strip_icc',  // valid flag — strips ICC colour profiles
    ...options,                              // caller options last (override above if needed)
  });

  return result.secure_url;
};

module.exports = { uploadToCloudinary };