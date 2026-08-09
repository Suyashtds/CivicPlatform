const cloudinary = require('../config/cloudinary');
const db         = require('../db');
const {
  uploadToCloudinary,
  deleteFromCloudinary,
  extractPublicId,
} = require('../middleware/upload');

// ── POST /upload/complaint-image ─────────────────────────────
const uploadComplaintImage = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image file provided' });
  }
  try {
    const result = await uploadToCloudinary(
      req.file.buffer,
      'complaints',
      {
        transformation: [
          { width: 1200, crop: 'limit' },
          { quality: 'auto:good' },
          { fetch_format: 'auto' },
        ],
      }
    );

    res.status(201).json({
      message:   'Complaint image uploaded successfully',
      image_url: result.secure_url,
      public_id: result.public_id,
      width:     result.width,
      height:    result.height,
      format:    result.format,
      bytes:     result.bytes,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Image upload failed' });
  }
};

// ── POST /upload/proof-image/:complaintId ────────────────────
const uploadProofImage = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No proof image provided' });
  }

  const { complaintId } = req.params;
  const { remarks }     = req.body;

  try {
    // Check complaint exists
    const comp = await db.query(
      'SELECT id, status FROM complaints WHERE id = $1',
      [complaintId]
    );
    if (!comp.rows.length) {
      return res.status(404).json({ error: 'Complaint not found' });
    }

    // Upload proof to Cloudinary
    const result = await uploadToCloudinary(
      req.file.buffer,
      'proofs',
      {
        transformation: [
          { width: 1200, crop: 'limit' },
          { quality: 'auto:good' },
        ],
      }
    );

    const proof_url = result.secure_url;

    // Mark complaint resolved
    await db.query(
      `UPDATE complaints SET status = 'resolved', updated_at = NOW() WHERE id = $1`,
      [complaintId]
    );

    // Save to status history
    await db.query(
      `INSERT INTO status_history (complaint_id, status, updated_by, remarks, proof_image_url)
       VALUES ($1, 'resolved', $2, $3, $4)`,
      [complaintId, req.user.id, remarks || 'Issue resolved', proof_url]
    );

    res.json({
      message:         'Proof uploaded and complaint marked resolved',
      proof_image_url: proof_url,
      complaint_id:    complaintId,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── POST /upload/avatar ──────────────────────────────────────
const uploadAvatar = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No avatar image provided' });
  }

  try {
    // Delete old avatar if exists
    const { rows } = await db.query(
      'SELECT avatar_url FROM users WHERE id = $1',
      [req.user.id]
    );
    const oldUrl = rows[0]?.avatar_url;
    if (oldUrl) {
      const oldPublicId = extractPublicId(oldUrl);
      if (oldPublicId) {
        await deleteFromCloudinary(oldPublicId).catch(() => {});
      }
    }

    // Upload new avatar
    const result = await uploadToCloudinary(
      req.file.buffer,
      'avatars',
      {
        transformation: [
          { width: 400, height: 400, crop: 'fill', gravity: 'face' },
          { quality: 'auto:good' },
        ],
      }
    );

    // Save URL to user
    await db.query(
      'UPDATE users SET avatar_url = $1, updated_at = NOW() WHERE id = $2',
      [result.secure_url, req.user.id]
    );

    res.json({
      message:    'Avatar updated successfully',
      avatar_url: result.secure_url,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── DELETE /upload/complaint-image/:complaintId ──────────────
const deleteComplaintImage = async (req, res) => {
  const { complaintId } = req.params;

  try {
    const { rows } = await db.query(
      'SELECT user_id, image_url FROM complaints WHERE id = $1',
      [complaintId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Complaint not found' });

    const isOwner = rows[0].user_id === req.user.id;
    const isAdmin = req.user.role === 'admin';
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const publicId = extractPublicId(rows[0].image_url);
    if (publicId) {
      await deleteFromCloudinary(publicId);
    }

    await db.query(
      'UPDATE complaints SET image_url = NULL, updated_at = NOW() WHERE id = $1',
      [complaintId]
    );

    res.json({ message: 'Image deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── GET /upload/complaint-images/:complaintId ────────────────
const getComplaintImages = async (req, res) => {
  const { complaintId } = req.params;

  try {
    const comp = await db.query(
      'SELECT image_url FROM complaints WHERE id = $1',
      [complaintId]
    );
    if (!comp.rows.length) return res.status(404).json({ error: 'Complaint not found' });

    const history = await db.query(
      `SELECT proof_image_url, status, created_at
         FROM status_history
        WHERE complaint_id = $1 AND proof_image_url IS NOT NULL
        ORDER BY created_at ASC`,
      [complaintId]
    );

    res.json({
      complaint_image: comp.rows[0].image_url,
      proof_images:    history.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  uploadComplaintImage,
  uploadProofImage,
  uploadAvatar,
  deleteComplaintImage,
  getComplaintImages,
};