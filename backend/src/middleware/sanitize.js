const sanitizeHtml = require('sanitize-html');

// ── Strip all HTML tags and scripts from a string ────────────
// Allows plain text only — no <script>, <img onerror>, <a href="javascript:">, etc.
const cleanText = (value) => {
  if (typeof value !== 'string') return value;
  return sanitizeHtml(value, {
    allowedTags: [],       // no HTML tags allowed at all
    allowedAttributes: {}, // no attributes allowed
    disallowedTagsMode: 'discard',
  }).trim();
};

// ── Recursively sanitize all string fields in req.body ───────
const sanitizeBody = (req, _res, next) => {
  if (req.body && typeof req.body === 'object') {
    for (const key of Object.keys(req.body)) {
      const value = req.body[key];

      if (typeof value === 'string') {
        req.body[key] = cleanText(value);
      } else if (Array.isArray(value)) {
        req.body[key] = value.map(v => typeof v === 'string' ? cleanText(v) : v);
      }
      // Numbers, booleans, nested objects (rare in this API) pass through unchanged
    }
  }
  next();
};

module.exports = { sanitizeBody, cleanText };
