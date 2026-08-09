const nodemailer = require('nodemailer');

const EMAIL_MODE = (process.env.EMAIL_MODE || 'smtp').toLowerCase();

// ── Transporter ──────────────────────────────────────────────
let transporter;
if (EMAIL_MODE === 'console') {
  transporter = {
    sendMail: async (mailOptions) => {
      console.log('📧 [EMAIL MODE=console] sendMail called with:');
      console.log(JSON.stringify({
        from: mailOptions.from,
        to: mailOptions.to,
        subject: mailOptions.subject,
        html: mailOptions.html ? mailOptions.html.replace(/\s+/g, ' ').trim() : undefined,
      }, null, 2));
      return { accepted: [mailOptions.to || (Array.isArray(mailOptions.to) ? mailOptions.to.join(', ') : undefined)].filter(Boolean) };
    },
  };
} else {
  transporter = nodemailer.createTransport({
    host:   'smtp.gmail.com',
    port:   465,
    secure: true,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
    tls: {
      rejectUnauthorized: false,
    },
  });
}

// ── Verify connection on startup ─────────────────────────────
if (typeof transporter.verify === 'function') {
  transporter.verify((err) => {
    if (err) {
      console.error('❌ Email service error:', err.message);
    } else {
      console.log('✅ Email service ready');
    }
  });
} else {
  console.log('✅ Email service ready (console mode)');
}

// ── Base HTML template ───────────────────────────────────────
const baseTemplate = (content) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body        { font-family: Arial, sans-serif; background: #f4f6f9; margin: 0; padding: 0; }
    .container  { max-width: 600px; margin: 30px auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    .header     { background: #1F5C99; padding: 28px 32px; text-align: center; }
    .header h1  { color: #ffffff; margin: 0; font-size: 22px; }
    .header p   { color: #c8dcf0; margin: 6px 0 0; font-size: 13px; }
    .body       { padding: 32px; color: #333333; }
    .body p     { font-size: 15px; line-height: 1.6; margin: 0 0 16px; }
    .badge      { display: inline-block; padding: 6px 16px; border-radius: 20px; font-size: 13px; font-weight: bold; margin: 8px 0 20px; }
    .info-box   { background: #f0f5ff; border-left: 4px solid #1F5C99; padding: 16px 20px; border-radius: 4px; margin: 20px 0; }
    .info-box p { margin: 4px 0; font-size: 14px; }
    .info-box strong { color: #1F5C99; }
    .btn        { display: inline-block; background: #1F5C99; color: #ffffff !important; text-decoration: none; padding: 12px 28px; border-radius: 6px; font-size: 15px; font-weight: bold; margin: 16px 0; }
    .footer     { background: #f0f4f8; padding: 20px 32px; text-align: center; font-size: 12px; color: #888888; }
    .divider    { border: none; border-top: 1px solid #eeeeee; margin: 24px 0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🏙️ Civic Issue Platform</h1>
      <p>Localized Civic Complaint Management</p>
    </div>
    <div class="body">
      ${content}
    </div>
    <div class="footer">
      <p>This is an automated notification from Civic Issue Platform.</p>
      <p>Please do not reply to this email.</p>
    </div>
  </div>
</body>
</html>
`;

// ── Status badge colors ───────────────────────────────────────
const STATUS_COLORS = {
  reported:    { bg: '#e3f2fd', color: '#1565c0' },
  verified:    { bg: '#e8f5e9', color: '#2e7d32' },
  assigned:    { bg: '#fff3e0', color: '#e65100' },
  in_progress: { bg: '#f3e5f5', color: '#6a1b9a' },
  resolved:    { bg: '#e8f5e9', color: '#1b5e20' },
  rejected:    { bg: '#ffebee', color: '#b71c1c' },
};

const STATUS_LABELS = {
  reported:    'Reported',
  verified:    'Verified ✓',
  assigned:    'Assigned',
  in_progress: 'In Progress 🔧',
  resolved:    'Resolved ✅',
  rejected:    'Rejected',
};

// ── Email: Complaint Submitted ────────────────────────────────
const sendComplaintSubmitted = async ({ to, name, complaintId, title, category, priorityScore }) => {
  const content = `
    <p>Hi <strong>${name}</strong>,</p>
    <p>Your complaint has been successfully submitted to the Civic Issue Platform. Our team will review it shortly.</p>
    <div class="info-box">
      <p><strong>Complaint ID:</strong> ${complaintId}</p>
      <p><strong>Title:</strong> ${title}</p>
      <p><strong>Category:</strong> ${category || 'Under review'}</p>
      <p><strong>Priority Score:</strong> ${priorityScore} / 100</p>
      <p><strong>Status:</strong> Reported</p>
    </div>
    <p>You will receive email updates as your complaint progresses through verification, assignment, and resolution.</p>
    <hr class="divider">
    <p style="font-size:13px; color:#666;">Track your complaint using ID: <strong>${complaintId}</strong></p>
  `;

  return transporter.sendMail({
    from:    process.env.EMAIL_FROM,
    to,
    subject: `✅ Complaint Submitted — ${title}`,
    html:    baseTemplate(content),
  });
};

// ── Email: Status Update ──────────────────────────────────────
const sendStatusUpdate = async ({ to, name, complaintId, title, status, remarks, departmentName }) => {
  const colors = STATUS_COLORS[status] || { bg: '#f5f5f5', color: '#333333' };
  const label  = STATUS_LABELS[status]  || status;

  const deptLine = departmentName
    ? `<p><strong>Assigned To:</strong> ${departmentName}</p>`
    : '';

  const remarksLine = remarks
    ? `<p><strong>Remarks:</strong> ${remarks}</p>`
    : '';

  const content = `
    <p>Hi <strong>${name}</strong>,</p>
    <p>There has been an update on your complaint:</p>
    <span class="badge" style="background:${colors.bg}; color:${colors.color};">
      ${label}
    </span>
    <div class="info-box">
      <p><strong>Complaint ID:</strong> ${complaintId}</p>
      <p><strong>Title:</strong> ${title}</p>
      <p><strong>New Status:</strong> ${label}</p>
      ${deptLine}
      ${remarksLine}
    </div>
    <p>We will keep you informed as work progresses on your complaint.</p>
  `;

  return transporter.sendMail({
    from:    process.env.EMAIL_FROM,
    to,
    subject: `🔔 Complaint Update — ${label} | ${title}`,
    html:    baseTemplate(content),
  });
};

// ── Email: Complaint Resolved ─────────────────────────────────
const sendComplaintResolved = async ({ to, name, complaintId, title, remarks }) => {
  const content = `
    <p>Hi <strong>${name}</strong>,</p>
    <p>Great news! Your complaint has been <strong>resolved</strong> by the concerned department.</p>
    <div class="info-box">
      <p><strong>Complaint ID:</strong> ${complaintId}</p>
      <p><strong>Title:</strong> ${title}</p>
      <p><strong>Status:</strong> Resolved ✅</p>
      ${remarks ? `<p><strong>Resolution Note:</strong> ${remarks}</p>` : ''}
    </div>
    <p>We would love to hear your feedback. Please rate the resolution to help us improve our services.</p>
    <hr class="divider">
    <p style="font-size:13px; color:#666;">Thank you for using Civic Issue Platform and helping improve your city!</p>
  `;

  return transporter.sendMail({
    from:    process.env.EMAIL_FROM,
    to,
    subject: `🎉 Complaint Resolved — ${title}`,
    html:    baseTemplate(content),
  });
};

// ── Email: Feedback Reminder ──────────────────────────────────
const sendFeedbackReminder = async ({ to, name, complaintId, title }) => {
  const content = `
    <p>Hi <strong>${name}</strong>,</p>
    <p>Your complaint was resolved a while ago. We noticed you haven't submitted your feedback yet.</p>
    <div class="info-box">
      <p><strong>Complaint ID:</strong> ${complaintId}</p>
      <p><strong>Title:</strong> ${title}</p>
    </div>
    <p>Your rating (1–5 stars) helps authorities understand service quality and improve response times.</p>
    <p>It only takes 10 seconds!</p>
    <hr class="divider">
    <p style="font-size:13px; color:#666;">Use the app to rate your complaint resolution experience.</p>
  `;

  return transporter.sendMail({
    from:    process.env.EMAIL_FROM,
    to,
    subject: `⭐ Rate Your Experience — ${title}`,
    html:    baseTemplate(content),
  });
};

// ── Email: Upvote Confirmation ────────────────────────────────
const sendUpvoteConfirmation = async ({ to, name, complaintId, title }) => {
  const content = `
    <p>Hi <strong>${name}</strong>,</p>
    <p>You have successfully supported an existing complaint on Civic Issue Platform.</p>
    <div class="info-box">
      <p><strong>Complaint ID:</strong> ${complaintId}</p>
      <p><strong>Title:</strong> ${title}</p>
    </div>
    <p>Your support increases the priority of this complaint and helps it get resolved faster. Thank you for participating!</p>
  `;

  return transporter.sendMail({
    from:    process.env.EMAIL_FROM,
    to,
    subject: `👍 You Supported a Complaint — ${title}`,
    html:    baseTemplate(content),
  });
};

module.exports = {
  sendComplaintSubmitted,
  sendStatusUpdate,
  sendComplaintResolved,
  sendFeedbackReminder,
  sendUpvoteConfirmation,
};

// ── Email: OTP Verification ───────────────────────────────────
const sendOTPEmail = async ({ to, name, otp, type }) => {
  const isRegister = type === 'register';
  const title   = isRegister ? 'Verify Your Account' : 'Login Verification Code';
  const message = isRegister
    ? 'Thank you for registering on Civic Issue Platform. Use the OTP below to verify your account.'
    : 'Someone is trying to log in to your Civic Issue Platform account. Use the OTP below to complete login.';

  const content = `
    <p>Hi <strong>${name}</strong>,</p>
    <p>${message}</p>
    <div style="text-align:center; margin: 32px 0;">
      <div style="display:inline-block; background:#f0f5ff; border: 2px dashed #1a4f8a;
                  border-radius: 12px; padding: 20px 48px;">
        <p style="margin:0; font-size:13px; color:#666; letter-spacing:1px;">YOUR OTP CODE</p>
        <p style="margin:8px 0 0; font-size:42px; font-weight:bold; color:#1a4f8a;
                  letter-spacing:12px;">${otp}</p>
      </div>
    </div>
    <p style="text-align:center; color:#e53935; font-size:13px;">
      ⏱ This OTP is valid for <strong>10 minutes</strong> only.
    </p>
    <hr class="divider">
    <p style="font-size:12px; color:#999;">
      If you did not request this, please ignore this email. Do not share this OTP with anyone.
    </p>
  `;

  return transporter.sendMail({
    from:    process.env.EMAIL_FROM,
    to,
    subject: `${otp} is your Civic Platform ${isRegister ? 'verification' : 'login'} code`,
    html:    baseTemplate(content),
  });
};

module.exports.sendOTPEmail = sendOTPEmail;

// ── Email: Generic Governance Notification (escalation / assignment) ──
// Reused for the new escalation engine and officer-assignment flow so we
// don't need a bespoke template per new governance event.
const sendGovernanceNotification = async ({ to, name, subject, heading, message, complaintId }) => {
  const content = `
    <p>Hi <strong>${name}</strong>,</p>
    <p>${message}</p>
    ${complaintId ? `
    <div class="info-box">
      <p><strong>Complaint ID:</strong> ${complaintId}</p>
    </div>` : ''}
    <hr class="divider">
    <p style="font-size:12px; color:#999;">This is an automated governance notification from Civic Platform.</p>
  `;

  return transporter.sendMail({
    from:    process.env.EMAIL_FROM,
    to,
    subject,
    html:    baseTemplate(`<h2 style="color:#1F5C99; margin-top:0;">${heading}</h2>${content}`),
  });
};

module.exports.sendGovernanceNotification = sendGovernanceNotification;

// ── Email: Verified Complaint Auto-Notification (image pipeline) ──
// Sent to the routed ward officer the moment an image-verified
// complaint (trust_score >= 80) is auto-approved and created.
const sendVerifiedComplaintEmail = async ({ to, complaint, ward, severity, trust_score }) => {
  if (!to) return null;

  const dashboardLink = `${process.env.DASHBOARD_BASE_URL || process.env.FRONTEND_URL || ''}/officer/complaints/${complaint.id}`;

  const content = `
    <p>A new civic complaint has been <strong>auto-verified</strong> and assigned to your ward.</p>
    <div style="text-align:center; margin: 20px 0;">
      <span class="badge" style="background:#e8f5e9; color:#2e7d32;">${severity} SEVERITY</span>
    </div>
    <div class="info-box">
      <p><strong>Complaint ID:</strong> ${complaint.id}</p>
      <p><strong>Issue type:</strong> ${complaint.category || 'unclassified'}</p>
      <p><strong>Ward:</strong> ${ward?.name || 'Unassigned'}</p>
      <p><strong>Location:</strong> ${complaint.latitude}, ${complaint.longitude}</p>
      <p><strong>Trust score:</strong> ${trust_score}/100</p>
    </div>
    ${complaint.image_url ? `<div style="text-align:center; margin:20px 0;"><img src="${complaint.image_url}" alt="Complaint photo" style="max-width:100%; border-radius:8px;"/></div>` : ''}
    <div style="text-align:center;">
      <a class="btn" href="${dashboardLink}">View on Dashboard</a>
    </div>
  `;

  return transporter.sendMail({
    from:    process.env.EMAIL_FROM,
    to,
    subject: `[${severity}] New verified complaint in ${ward?.name || 'your ward'}`,
    html:    baseTemplate(`<h2 style="color:#1F5C99; margin-top:0;">New Verified Complaint</h2>${content}`),
  });
};

module.exports.sendVerifiedComplaintEmail = sendVerifiedComplaintEmail;

// ── Email: Review Queue Notification ─────────────────────────
// Sent when a borderline-trust upload (60-79) lands in the manual
// review queue instead of being auto-created.
const sendReviewQueueEmail = async ({ to, queueEntry, ward, severity }) => {
  if (!to) return null;

  const dashboardLink = `${process.env.DASHBOARD_BASE_URL || process.env.FRONTEND_URL || ''}/admin/review-queue`;

  const content = `
    <p>A citizen photo needs manual verification before it becomes a live complaint.</p>
    <div class="info-box">
      <p><strong>Review queue ID:</strong> ${queueEntry.id}</p>
      <p><strong>Suggested type:</strong> ${queueEntry.issue_type || 'unclassified'}</p>
      <p><strong>Ward:</strong> ${ward?.name || 'Unassigned'}</p>
      <p><strong>Trust score:</strong> ${queueEntry.trust_score}/100</p>
    </div>
    <div style="text-align:center;">
      <a class="btn" href="${dashboardLink}">Open Review Queue</a>
    </div>
  `;

  return transporter.sendMail({
    from:    process.env.EMAIL_FROM,
    to,
    subject: `Review needed: possible ${severity.toLowerCase()} issue in ${ward?.name || 'your ward'}`,
    html:    baseTemplate(`<h2 style="color:#1F5C99; margin-top:0;">Manual Review Needed</h2>${content}`),
  });
};

module.exports.sendReviewQueueEmail = sendReviewQueueEmail;
