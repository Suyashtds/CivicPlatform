const rateLimit = require('express-rate-limit');

// ── Login rate limiter ───────────────────────────────────────
// Max 5 login attempts per 15 minutes per IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── OTP verification rate limiter ────────────────────────────
// Max 5 OTP verification attempts per 10 minutes per IP
// Prevents brute-forcing the 6-digit OTP code
const otpVerifyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 5,
  message: { error: 'Too many OTP attempts. Please request a new code.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── OTP resend rate limiter ──────────────────────────────────
// Max 3 resend requests per 10 minutes per IP — prevents email spam
const otpResendLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 3,
  message: { error: 'Too many OTP resend requests. Please wait before trying again.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Registration rate limiter ────────────────────────────────
// Max 10 registration attempts per hour per IP — prevents account spam
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: { error: 'Too many registration attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── General API rate limiter ─────────────────────────────────
// Applied globally — max 200 requests per 15 minutes per IP
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Image verification upload limiter ────────────────────────
// Max 15 photo submissions per 10 minutes per IP — /complaints/verified
// triggers a Cloudinary upload + ML inference call per request.
const imageVerificationLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 15,
  message: { error: 'Too many photo submissions. Please wait before uploading more.' },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = {
  loginLimiter,
  otpVerifyLimiter,
  otpResendLimiter,
  registerLimiter,
  generalLimiter,
  imageVerificationLimiter,
};
