const multer   = require('multer');
const cloudinary = require('../config/cloudinary');

const ALLOWED_TYPES = ['image/jpeg', 'image/png'];
const MAX_SIZE      = 10 * 1024 * 1024; // 10MB
const MIN_SIZE      = 200 * 1024;       // 200KB — mirrors ml-service validate_file()

// ── Store in memory, upload to Cloudinary manually ───────────
const memStorage = multer.memoryStorage();

const imageFilter = (_req, file, cb) => {
  if (!ALLOWED_TYPES.includes(file.mimetype)) {
    return cb(new Error('Only jpg or png images allowed'), false);
  }
  cb(null, true);
};

// ── Helper: upload a buffer directly to Cloudinary ───────────
const uploadToCloudinary = (buffer, folder, options = {}) => {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: `civic-platform/${folder}`,
        ...options,
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );
    stream.end(buffer);
  });
};

// ── Helper: delete a file from Cloudinary by public_id ───────
const deleteFromCloudinary = async (publicId) => {
  if (!publicId) return null;
  return cloudinary.uploader.destroy(publicId);
};

// ── Helper: extract public_id from Cloudinary URL ────────────
const extractPublicId = (url) => {
  if (!url) return null;
  const parts    = url.split('/');
  const uploadIdx = parts.indexOf('upload');
  if (uploadIdx === -1) return null;
  const pathParts = parts.slice(uploadIdx + 2); // skip version
  return pathParts.join('/').replace(/\.[^/.]+$/, '');
};

// ── Multer instances ─────────────────────────────────────────
const uploadComplaintImage = multer({
  storage:    memStorage,
  fileFilter: imageFilter,
  limits:     { fileSize: MAX_SIZE },
}).single('image');

const uploadProofImage = multer({
  storage:    memStorage,
  fileFilter: imageFilter,
  limits:     { fileSize: MAX_SIZE },
}).single('proof_image');

const uploadAvatar = multer({
  storage:    memStorage,
  fileFilter: imageFilter,
  limits:     { fileSize: 5 * 1024 * 1024 },
}).single('avatar');

// ── Error handler ────────────────────────────────────────────
const handleUploadError = (err, _req, res, next) => {
  if (err instanceof multer.MulterError) {
    const messages = {
      LIMIT_FILE_SIZE:       'File too large. Max size is 10MB.',
      LIMIT_UNEXPECTED_FILE: 'Unexpected field name in upload.',
    };
    return res.status(400).json({ error: messages[err.code] || err.message });
  }
  if (err) return res.status(400).json({ error: err.message });
  next();
};

module.exports = {
  uploadComplaintImage,
  uploadProofImage,
  uploadAvatar,
  handleUploadError,
  uploadToCloudinary,
  deleteFromCloudinary,
  extractPublicId,
  MIN_SIZE,
};