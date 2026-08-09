const { body, validationResult } = require('express-validator');

// ── Complaint validation rules ───────────────────────────────
const complaintRules = [
  body('title')
    .trim()
    .notEmpty().withMessage('Title is required')
    .isLength({ max: 200 }).withMessage('Title must be under 200 characters'),

  body('description')
    .trim()
    .notEmpty().withMessage('Description is required')
    .isLength({ min: 10 }).withMessage('Description must be at least 10 characters'),

  body('latitude')
    .notEmpty().withMessage('Latitude is required')
    .isFloat({ min: -90, max: 90 }).withMessage('Latitude must be between -90 and 90'),

  body('longitude')
    .notEmpty().withMessage('Longitude is required')
    .isFloat({ min: -180, max: 180 }).withMessage('Longitude must be between -180 and 180'),

  body('ward_id')
    .optional()
    .isInt({ min: 1 }).withMessage('ward_id must be a positive integer'),

  body('city_id')
    .optional()
    .isInt({ min: 1 }).withMessage('city_id must be a positive integer'),
];

// ── Status update validation rules ───────────────────────────
const statusUpdateRules = [
  body('status')
    .notEmpty().withMessage('Status is required')
    .isIn(['verified','assigned','in_progress','resolved','rejected'])
    .withMessage('Invalid status value'),

  body('remarks')
    .optional()
    .isLength({ max: 500 }).withMessage('Remarks must be under 500 characters'),
];

// ── Feedback validation rules ─────────────────────────────────
const feedbackRules = [
  body('rating')
    .notEmpty().withMessage('Rating is required')
    .isInt({ min: 1, max: 5 }).withMessage('Rating must be between 1 and 5'),

  body('comment')
    .optional()
    .isLength({ max: 500 }).withMessage('Comment must be under 500 characters'),
];

// ── Middleware: return errors if validation fails ─────────────
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({
      error: 'Validation failed',
      details: errors.array().map(e => ({ field: e.path, message: e.msg }))
    });
  }
  next();
};

module.exports = { complaintRules, statusUpdateRules, feedbackRules, validate };
