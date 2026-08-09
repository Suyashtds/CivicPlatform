const express  = require('express');
const passport = require('../config/passport');
const router   = express.Router();

const { authenticate, requireRole } = require('../middleware/auth');
const {
  uploadComplaintImage: multerComplaint,
  uploadProofImage:     multerProof,
  uploadAvatar:         multerAvatar,
  handleUploadError,
} = require('../middleware/upload');
const {
  loginLimiter, otpVerifyLimiter,
  otpResendLimiter, registerLimiter,
  imageVerificationLimiter,
} = require('../middleware/rateLimiter');
const {
  complaintRules, statusUpdateRules,
  feedbackRules, validate,
} = require('../middleware/validators');
const { sanitizeBody } = require('../middleware/sanitize');

const auth         = require('../controllers/authController');
const complaints   = require('../controllers/complaintsController');
const admin        = require('../controllers/adminController');
const upload       = require('../controllers/uploadController');
const notification = require('../controllers/notificationController');

// ── Auth ──────────────────────────────────────────────────────
router.post('/auth/register',          registerLimiter, auth.registerRules, auth.register);
router.post('/auth/verify-otp',        otpVerifyLimiter, auth.verifyRegistrationOTP);
router.post('/auth/login',             loginLimiter, auth.loginRules, auth.login);
router.post('/auth/verify-login-otp',  otpVerifyLimiter, auth.verifyLoginOTP);
router.post('/auth/resend-otp',        otpResendLimiter, auth.resendOTP);
router.post('/auth/logout',            authenticate, auth.logout);
router.get('/auth/me',                 authenticate, auth.getMe);

// ── Auth — Google OAuth ───────────────────────────────────────
router.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'], session: false })
);
router.get('/auth/google/callback',
  passport.authenticate('google', { session: false, failureRedirect: '/api/auth/google/failed' }),
  auth.googleCallbackJSON
);
router.get('/auth/google/failed', (_req, res) => {
  res.status(401).json({ error: 'Google authentication failed' });
});

// ── Complaints ────────────────────────────────────────────────
// ⚠️ /my, /search and /public must come BEFORE /:id to avoid route conflict
// Public Feed (NO auth required) — social/public browsing view
router.get('/complaints/public', complaints.publicFeed);

router.get('/complaints/my',
  authenticate, complaints.myComplaints);

router.get('/complaints/search',
  authenticate, complaints.searchComplaints);

router.post('/complaints',
  authenticate, complaintRules, validate, complaints.createComplaint);

router.get('/complaints',
  authenticate, complaints.listComplaints);

router.get('/complaints/:id',
  authenticate, complaints.getComplaint);

router.put('/complaints/:id',
  authenticate, complaints.editComplaint);

router.delete('/complaints/:id',
  authenticate, complaints.deleteComplaint);

router.put('/complaints/:id/status',
  authenticate, requireRole('admin','department'), statusUpdateRules, validate, complaints.updateStatus);

router.post('/complaints/:id/upvote',
  authenticate, complaints.upvoteComplaint);

// Updated feedback — validates complaint is resolved first
router.post('/complaints/:id/feedback',
  authenticate, feedbackRules, validate, complaints.submitFeedbackValidated);

// ── Upload ────────────────────────────────────────────────────
router.post('/upload/complaint-image',
  authenticate, multerComplaint, handleUploadError, upload.uploadComplaintImage);
router.post('/upload/proof-image/:complaintId',
  authenticate, requireRole('admin','department'), multerProof, handleUploadError, upload.uploadProofImage);
router.post('/upload/avatar',
  authenticate, multerAvatar, handleUploadError, upload.uploadAvatar);
router.get('/upload/complaint-images/:complaintId',
  authenticate, upload.getComplaintImages);
router.delete('/upload/complaint-image/:complaintId',
  authenticate, upload.deleteComplaintImage);

// ── Notifications ─────────────────────────────────────────────
router.post('/notifications/test',
  authenticate, requireRole('admin'), notification.sendTestEmail);
router.post('/notifications/feedback-reminder/:complaintId',
  authenticate, requireRole('admin'), notification.sendFeedbackReminderManual);

// ── Admin ─────────────────────────────────────────────────────
router.get('/admin/dashboard',
  authenticate, requireRole('admin'), admin.getDashboard);
router.put('/admin/complaints/:id/assign',
  authenticate, requireRole('admin'), admin.assignComplaint);
router.get('/admin/departments',
  authenticate, requireRole('admin','department'), admin.listDepartments);
router.get('/admin/ml-status',
  authenticate, requireRole('admin'), admin.getMLStatus);
router.post('/admin/recalculate-priorities',
  authenticate, requireRole('admin'), admin.recalculatePriorities);
router.get('/analytics/city',
  authenticate, requireRole('admin','department'), admin.getCityAnalytics);

// ================================================================
// GOVERNANCE UPGRADE — additive routes only, nothing above is changed
// ================================================================
const lifecycle    = require('../controllers/lifecycleController');
const officers      = require('../controllers/officerController');
const evidence      = require('../controllers/evidenceController');
const community     = require('../controllers/communityController');
const citizen       = require('../controllers/citizenController');
const audit         = require('../controllers/auditController');
const geo           = require('../controllers/geoController');
const govAnalytics  = require('../controllers/govAnalyticsController');
const globalSearch  = require('../controllers/globalSearchController');
const notif         = require('../controllers/notificationController');
const { requirePermission } = require('../middleware/rbac');

// ── Complaint lifecycle (granular governance transitions) ──────
router.get('/complaints/:id/allowed-transitions',
  authenticate, lifecycle.getAllowedTransitions);
router.put('/complaints/:id/assign-officer',
  authenticate, requireRole('admin','department','officer'), lifecycle.assignOfficer);
router.put('/complaints/:id/reassign',
  authenticate, requireRole('admin','department','officer'), lifecycle.reassignComplaint);
router.put('/complaints/:id/accept',
  authenticate, requireRole('officer'), lifecycle.acceptComplaint);
router.put('/complaints/:id/start-work',
  authenticate, requireRole('officer','admin'), lifecycle.startWork);
router.put('/complaints/:id/submit-inspection',
  authenticate, requireRole('officer','admin'), lifecycle.submitForInspection);
router.put('/complaints/:id/resolve',
  authenticate, requireRole('officer','admin','department'), lifecycle.resolveComplaint);
router.put('/complaints/:id/citizen-verify',
  authenticate, lifecycle.citizenVerify);

// ── Evidence (before/after images, GPS + timestamp verified) ───
router.post('/complaints/:id/evidence',
  authenticate, requireRole('officer','admin','department'), evidence.uploadEvidence);
router.get('/complaints/:id/evidence',
  authenticate, evidence.listEvidence);

// ── Community verification ──────────────────────────────────────
router.post('/complaints/:id/comments',    authenticate, community.addComment);
router.get('/complaints/:id/comments',     authenticate, community.listComments);
router.post('/complaints/:id/bookmark',    authenticate, community.toggleBookmark);
router.get('/citizen/bookmarks',           authenticate, community.listBookmarks);
router.get('/citizen/nearby',              authenticate, community.nearbyComplaints);

// ── Citizen dashboard ────────────────────────────────────────────
router.get('/citizen/dashboard', authenticate, citizen.getDashboard);

// ── Officer management ────────────────────────────────────────────
router.post('/officers',
  authenticate, requireRole('admin','department'), officers.createOfficer);
router.get('/officers',
  authenticate, requireRole('admin','department','officer'), officers.listOfficers);
router.get('/officers/:id/workload',
  authenticate, requireRole('admin','department','officer'), officers.getWorkload);
router.get('/officers/:id/performance',
  authenticate, requireRole('admin','department','officer'), officers.getPerformance);
router.put('/officers/:id/availability',
  authenticate, requireRole('admin','department','officer'), officers.setAvailability);
router.post('/officers/leave',
  authenticate, requireRole('officer'), officers.requestLeave);
router.get('/officers/leave',
  authenticate, requireRole('admin','department','officer'), officers.listLeaves);
router.put('/officers/leave/:id/review',
  authenticate, requireRole('admin','department','officer'), officers.reviewLeave);

// ── Audit logs (append-only, admin visibility) ───────────────────
router.get('/admin/audit-logs', authenticate, requireRole('admin'), audit.listAuditLogs);

// ── GIS / map data ─────────────────────────────────────────────
router.get('/geo/complaints',      authenticate, geo.getComplaintsGeoJSON);
router.get('/geo/heatmap',         authenticate, geo.getHeatmapPoints);
router.get('/geo/ward-stats',      authenticate, geo.getWardStats);
router.get('/geo/search-address',  authenticate, geo.searchAddress);

// ── Governance analytics: Civic Health Index, Dept Efficiency, Hotspots, Trust ──
router.get('/analytics/civic-health',            authenticate, requireRole('admin','department','officer'), govAnalytics.getCivicHealthIndex);
router.get('/analytics/civic-health/history',    authenticate, requireRole('admin','department','officer'), govAnalytics.getCivicHealthHistory);
router.get('/analytics/department-efficiency',   authenticate, requireRole('admin','department','officer'), govAnalytics.getDepartmentEfficiency);
router.get('/analytics/hotspots',                authenticate, requireRole('admin','department','officer'), govAnalytics.getHotspots);
router.get('/analytics/trust-score',             authenticate, govAnalytics.getTrustScore);
router.get('/analytics/export.csv',              authenticate, requireRole('admin','department'), govAnalytics.exportComplaintsCsv);

// ── Global cross-entity search ────────────────────────────────────
router.get('/search/global', authenticate, requireRole('admin','department','officer'), globalSearch.globalSearch);

// ── In-app notifications (history + read/unread) ──────────────────
router.get('/notifications',              authenticate, notif.listNotifications);
router.put('/notifications/:id/read',     authenticate, notif.markNotificationRead);
router.put('/notifications/read-all',     authenticate, notif.markAllNotificationsRead);

// ================================================================
// IMAGE VERIFICATION + GEO-ROUTING PIPELINE — additive routes only
// ================================================================
const imageVerification = require('../controllers/imageVerificationController');
const reviewQueue        = require('../controllers/reviewQueueController');

// New parallel complaint-creation path used when the citizen attaches a
// photo — runs Cloudinary upload -> ML /analyze -> trust score gating ->
// PostGIS ward routing -> email, before creating the complaint (or
// filing it into review_queue / rejecting it outright).
// Existing POST /complaints above is completely unchanged.
router.post('/complaints/verified',
  authenticate,
  imageVerificationLimiter,
  multerComplaint,
  handleUploadError,
  sanitizeBody,
  complaintRules,
  validate,
  imageVerification.createVerifiedComplaint);

// Manual review queue (60-79 trust score band)
router.get('/admin/review-queue',
  authenticate, requireRole('admin','department'), reviewQueue.listReviewQueue);
router.post('/admin/review-queue/:id/approve',
  authenticate, requireRole('admin','department'), reviewQueue.approveReviewItem);
router.post('/admin/review-queue/:id/reject',
  authenticate, requireRole('admin','department'), reviewQueue.rejectReviewItem);

module.exports = router;
