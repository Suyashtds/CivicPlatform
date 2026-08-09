const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const db = require('../db');
const { sendOTPEmail } = require('../services/emailService');

const MAX_OTP_ATTEMPTS = 3; // lock OTP after 3 wrong tries

// ── Validation rules ─────────────────────────────────────────
const registerRules = [
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('email').isEmail().normalizeEmail(),
  body('phone').optional().isMobilePhone(),
  body('password').isLength({ min: 6 }).withMessage('Password min 6 chars'),
  body('role').optional().isIn(['citizen', 'admin', 'department']),
];

const loginRules = [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
];

// ── Helpers ──────────────────────────────────────────────────
const signToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });

const generateOTP = () =>
  Math.floor(100000 + Math.random() * 900000).toString();

const saveOTP = async (email, type) => {
  const otp_code   = generateOTP();
  const expires_at = new Date(Date.now() + 10 * 60 * 1000);

  // Delete old unused OTPs for this email + type
  await db.query(
    'DELETE FROM otp_verifications WHERE email = $1 AND type = $2 AND used = FALSE',
    [email, type]
  );

  await db.query(
    `INSERT INTO otp_verifications (email, otp_code, type, expires_at, attempts)
     VALUES ($1, $2, $3, $4, 0)`,
    [email, otp_code, type, expires_at]
  );

  return otp_code;
};

const verifyOTPCode = async (email, otp_code, type) => {
  // Find the latest valid OTP for this email+type
  const { rows } = await db.query(
    `SELECT * FROM otp_verifications
      WHERE email = $1
        AND type  = $2
        AND used  = FALSE
        AND expires_at > NOW()
      ORDER BY created_at DESC
      LIMIT 1`,
    [email, type]
  );

  if (!rows.length) {
    return { success: false, error: 'OTP expired or not found. Please request a new one.' };
  }

  const record = rows[0];

  // Check if already exceeded max attempts
  if (record.attempts >= MAX_OTP_ATTEMPTS) {
    // Mark as used so they must request a new OTP
    await db.query('UPDATE otp_verifications SET used = TRUE WHERE id = $1', [record.id]);
    return { success: false, error: `OTP locked after ${MAX_OTP_ATTEMPTS} failed attempts. Please request a new code.` };
  }

  // Wrong OTP — increment attempts
  if (record.otp_code !== otp_code) {
    const newAttempts = record.attempts + 1;
    await db.query(
      'UPDATE otp_verifications SET attempts = $1 WHERE id = $2',
      [newAttempts, record.id]
    );

    const remaining = MAX_OTP_ATTEMPTS - newAttempts;
    if (remaining <= 0) {
      await db.query('UPDATE otp_verifications SET used = TRUE WHERE id = $1', [record.id]);
      return { success: false, error: `Incorrect OTP. OTP locked. Please request a new code.` };
    }
    return { success: false, error: `Incorrect OTP. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.` };
  }

  // Correct OTP — mark as used
  await db.query('UPDATE otp_verifications SET used = TRUE WHERE id = $1', [record.id]);
  return { success: true, record };
};

// ── POST /auth/register ──────────────────────────────────────
const register = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

  const { name, email, phone, password, role = 'citizen', city, ward, city_id, ward_id } = req.body;

  try {
    const existing = await db.query(
      'SELECT id, is_verified FROM users WHERE email = $1', [email]
    );

    if (existing.rows.length && existing.rows[0].is_verified) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const password_hash = await bcrypt.hash(password, 12);

    if (existing.rows.length && !existing.rows[0].is_verified) {
      await db.query(
        `UPDATE users SET name=$1, password_hash=$2, phone=$3, city=$4, ward=$5,
          city_id=$6, ward_id=$7, updated_at=NOW() WHERE email=$8`,
        [name, password_hash, phone, city, ward, city_id, ward_id, email]
      );
    } else {
      await db.query(
        `INSERT INTO users (name, email, phone, password_hash, role, city, ward, city_id, ward_id, is_verified)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, FALSE)`,
        [name, email, phone, password_hash, role, city, ward, city_id, ward_id]
      );
    }

    const otp = await saveOTP(email, 'register');
    await sendOTPEmail({ to: email, name, otp, type: 'register' });

    res.status(200).json({
      message: `OTP sent to ${email}. Please verify to activate your account.`,
      email,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── POST /auth/verify-otp ────────────────────────────────────
const verifyRegistrationOTP = async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ error: 'email and otp are required' });

  try {
    const result = await verifyOTPCode(email, otp, 'register');
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    const { rows } = await db.query(
      `UPDATE users SET is_verified = TRUE, updated_at = NOW()
        WHERE email = $1 RETURNING id, name, email, role, city, ward`,
      [email]
    );

    if (!rows.length) return res.status(404).json({ error: 'User not found' });

    const token = signToken(rows[0].id);
    res.json({ message: 'Account verified successfully!', token, user: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── POST /auth/login ─────────────────────────────────────────
const login = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

  const { email, password } = req.body;

  try {
    const { rows } = await db.query(
      'SELECT id, name, email, password_hash, role, is_verified FROM users WHERE email = $1',
      [email]
    );

    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });

    const user = rows[0];

    if (!user.is_verified) {
      return res.status(401).json({
        error: 'Account not verified. Please check your email for OTP.',
      });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const otp = await saveOTP(email, 'login');
    await sendOTPEmail({ to: email, name: user.name, otp, type: 'login' });

    res.json({
      message: `OTP sent to ${email}. Please enter it to complete login.`,
      email,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── POST /auth/verify-login-otp ──────────────────────────────
const verifyLoginOTP = async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ error: 'email and otp are required' });

  try {
    const result = await verifyOTPCode(email, otp, 'login');
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    const { rows } = await db.query(
      'SELECT id, name, email, role, city, ward FROM users WHERE email = $1',
      [email]
    );

    if (!rows.length) return res.status(404).json({ error: 'User not found' });

    const token = signToken(rows[0].id);
    res.json({ message: 'Login successful!', token, user: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── POST /auth/resend-otp ────────────────────────────────────
const resendOTP = async (req, res) => {
  const { email, type } = req.body;
  if (!email || !type) return res.status(400).json({ error: 'email and type are required' });
  if (!['register', 'login'].includes(type)) {
    return res.status(400).json({ error: 'type must be register or login' });
  }

  try {
    const { rows } = await db.query(
      'SELECT name, is_verified FROM users WHERE email = $1', [email]
    );
    if (!rows.length) return res.status(404).json({ error: 'Email not found' });

    const otp = await saveOTP(email, type);
    await sendOTPEmail({ to: email, name: rows[0].name, otp, type });

    res.json({ message: `OTP resent to ${email}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── POST /auth/logout ────────────────────────────────────────
const logout = async (req, res) => {
  try {
    const { token, tokenExp, user } = req;
    const expires_at = new Date(tokenExp * 1000);

    await db.query(
      `INSERT INTO token_blacklist (token, user_id, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (token) DO NOTHING`,
      [token, user.id, expires_at]
    );

    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── Cleanup expired blacklist entries ────────────────────────
const cleanupExpiredBlacklist = async () => {
  try {
    const result = await db.query(
      'DELETE FROM token_blacklist WHERE expires_at < NOW()'
    );
    if (result.rowCount > 0) {
      console.log(`🧹 Cleaned up ${result.rowCount} expired blacklist entries`);
    }
  } catch (err) {
    console.error('Blacklist cleanup error:', err.message);
  }
};

// ── Google OAuth Callback ────────────────────────────────────
const googleCallback = (req, res) => {
  try {
    const token = signToken(req.user.id);
    const redirectUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    res.redirect(`${redirectUrl}/oauth-success?token=${token}`);
  } catch (err) {
    console.error(err);
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/oauth-error`);
  }
};

const googleCallbackJSON = (req, res) => {
  try {
    const token = signToken(req.user.id);
    res.json({
      message: 'Google login successful!',
      token,
      user: {
        id:         req.user.id,
        name:       req.user.name,
        email:      req.user.email,
        role:       req.user.role,
        avatar_url: req.user.avatar_url,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Google authentication failed' });
  }
};

module.exports = {
  register, registerRules,
  verifyRegistrationOTP,
  login, loginRules,
  verifyLoginOTP,
  resendOTP,
  logout,
  cleanupExpiredBlacklist,
  googleCallback,
  googleCallbackJSON,
};

// ── GET /auth/me ─────────────────────────────────────────────
// Returns current logged-in user profile
const getMe = async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, name, email, role, city, ward, avatar_url, is_verified, created_at
         FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ user: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

module.exports.getMe = getMe;
