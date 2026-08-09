const db = require('../db');
const {
  sendComplaintSubmitted,
  sendStatusUpdate,
  sendComplaintResolved,
  sendFeedbackReminder,
  sendUpvoteConfirmation,
} = require('../services/emailService');

// ── Helper: get user email + name by user_id ─────────────────
const getUserInfo = async (userId) => {
  const { rows } = await db.query(
    'SELECT name, email FROM users WHERE id = $1',
    [userId]
  );
  return rows[0] || null;
};

// ── Helper: get complaint info by complaint_id ────────────────
const getComplaintInfo = async (complaintId) => {
  const { rows } = await db.query(
    `SELECT c.id, c.title, c.category, c.status, c.priority_score,
            c.user_id, c.assigned_department_id,
            d.name AS department_name
       FROM complaints c
       LEFT JOIN departments d ON d.id = c.assigned_department_id
      WHERE c.id = $1`,
    [complaintId]
  );
  return rows[0] || null;
};

// ── POST /notifications/test ──────────────────────────────────
// Send a test email to verify Nodemailer is working
const sendTestEmail = async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'Recipient email (to) is required' });

  try {
    await sendComplaintSubmitted({
      to,
      name:          'Test User',
      complaintId:   'TEST-001',
      title:         'Test Pothole on Main Road',
      category:      'pothole',
      priorityScore: 28,
    });

    res.json({ message: `Test email sent to ${to}` });
  } catch (err) {
    console.error('Test email error:', err);
    res.status(500).json({ error: err.message });
  }
};

// ── Trigger: Complaint Submitted ──────────────────────────────
// Called internally after a complaint is created
const notifyComplaintSubmitted = async (complaintId) => {
  try {
    const complaint = await getComplaintInfo(complaintId);
    if (!complaint) return;

    const user = await getUserInfo(complaint.user_id);
    if (!user?.email) return;

    await sendComplaintSubmitted({
      to:            user.email,
      name:          user.name,
      complaintId:   complaint.id,
      title:         complaint.title,
      category:      complaint.category,
      priorityScore: complaint.priority_score,
    });

    console.log(`📧 Submission email sent to ${user.email}`);
  } catch (err) {
    console.error('notifyComplaintSubmitted error:', err.message);
  }
};

// ── Trigger: Status Updated ───────────────────────────────────
// Called internally when admin updates complaint status
const notifyStatusUpdate = async (complaintId, status, remarks) => {
  try {
    const complaint = await getComplaintInfo(complaintId);
    if (!complaint) return;

    const user = await getUserInfo(complaint.user_id);
    if (!user?.email) return;

    // Use resolved-specific email for resolved status
    if (status === 'resolved') {
      await sendComplaintResolved({
        to:          user.email,
        name:        user.name,
        complaintId: complaint.id,
        title:       complaint.title,
        remarks,
      });
    } else {
      await sendStatusUpdate({
        to:             user.email,
        name:           user.name,
        complaintId:    complaint.id,
        title:          complaint.title,
        status,
        remarks,
        departmentName: complaint.department_name,
      });
    }

    console.log(`📧 Status update email (${status}) sent to ${user.email}`);
  } catch (err) {
    console.error('notifyStatusUpdate error:', err.message);
  }
};

// ── Trigger: Upvote Confirmation ──────────────────────────────
// Called internally when citizen upvotes a complaint
const notifyUpvote = async (complaintId, userId) => {
  try {
    const complaint = await getComplaintInfo(complaintId);
    if (!complaint) return;

    const user = await getUserInfo(userId);
    if (!user?.email) return;

    await sendUpvoteConfirmation({
      to:          user.email,
      name:        user.name,
      complaintId: complaint.id,
      title:       complaint.title,
    });

    console.log(`📧 Upvote confirmation email sent to ${user.email}`);
  } catch (err) {
    console.error('notifyUpvote error:', err.message);
  }
};

// ── POST /notifications/feedback-reminder ────────────────────
// Admin manually triggers feedback reminder for a resolved complaint
const sendFeedbackReminderManual = async (req, res) => {
  const { complaintId } = req.params;

  try {
    const complaint = await getComplaintInfo(complaintId);
    if (!complaint) return res.status(404).json({ error: 'Complaint not found' });

    if (complaint.status !== 'resolved') {
      return res.status(400).json({ error: 'Complaint is not resolved yet' });
    }

    const user = await getUserInfo(complaint.user_id);
    if (!user?.email) return res.status(404).json({ error: 'User email not found' });

    await sendFeedbackReminder({
      to:          user.email,
      name:        user.name,
      complaintId: complaint.id,
      title:       complaint.title,
    });

    res.json({ message: `Feedback reminder sent to ${user.email}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  sendTestEmail,
  notifyComplaintSubmitted,
  notifyStatusUpdate,
  notifyUpvote,
  sendFeedbackReminderManual,
};

// ============================================================
// In-app notifications — history + read/unread tracking
// (additive: existing email notification functions above are untouched)
// ============================================================
const { sendGovernanceNotification } = require('../services/emailService');

// Internal helper: write an in-app notification row (never throws upward)
const createInAppNotification = async ({ userId, type, title, message, complaintId = null }) => {
  try {
    await db.query(
      `INSERT INTO notifications (user_id, type, title, message, complaint_id)
       VALUES ($1,$2,$3,$4,$5)`,
      [userId, type, title, message, complaintId]
    );
  } catch (err) {
    console.error('createInAppNotification error:', err.message);
  }
};

// ── Trigger: Escalation ────────────────────────────────────────
// Called by escalationService when a complaint moves up the hierarchy
const notifyEscalation = async (complaintId, level, reason) => {
  try {
    const complaint = await getComplaintInfo(complaintId);
    if (!complaint) return;

    const { rows } = await db.query(
      `SELECT assigned_officer_id, escalated_to FROM complaints WHERE id = $1`,
      [complaintId]
    );
    const targetId = rows[0]?.escalated_to;
    if (!targetId) return;

    const officer = await getUserInfo(targetId);

    await createInAppNotification({
      userId: targetId,
      type: 'escalation',
      title: `Complaint escalated to ${level.replace('_', ' ')}`,
      message: `"${complaint.title}" has been escalated to you. Reason: ${reason}`,
      complaintId,
    });

    if (officer?.email) {
      await sendGovernanceNotification({
        to: officer.email,
        name: officer.name,
        subject: `⚠️ Escalated: ${complaint.title}`,
        heading: 'A complaint has been escalated to you',
        message: `The complaint "<strong>${complaint.title}</strong>" (category: ${complaint.category || 'uncategorized'}) has been escalated to the <strong>${level.replace('_', ' ')}</strong> tier. Reason: ${reason}`,
        complaintId,
      }).catch((e) => console.warn('Escalation email failed:', e.message));
    }
  } catch (err) {
    console.error('notifyEscalation error:', err.message);
  }
};

// ── Trigger: Officer Assignment ────────────────────────────────
const notifyOfficerAssigned = async (complaintId, officerId) => {
  try {
    const complaint = await getComplaintInfo(complaintId);
    if (!complaint) return;
    const officer = await getUserInfo(officerId);

    await createInAppNotification({
      userId: officerId,
      type: 'assignment',
      title: 'New complaint assigned to you',
      message: `"${complaint.title}" has been assigned to you.`,
      complaintId,
    });

    if (officer?.email) {
      await sendGovernanceNotification({
        to: officer.email,
        name: officer.name,
        subject: `📋 New assignment: ${complaint.title}`,
        heading: 'A new complaint has been assigned to you',
        message: `You have been assigned "<strong>${complaint.title}</strong>" (category: ${complaint.category || 'uncategorized'}). Please review and accept it from your officer dashboard.`,
        complaintId,
      }).catch((e) => console.warn('Assignment email failed:', e.message));
    }
  } catch (err) {
    console.error('notifyOfficerAssigned error:', err.message);
  }
};

// ── GET /notifications ──────────────────────────────────────────
const listNotifications = async (req, res) => {
  const { unread_only, page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;
  const conditions = ['user_id = $1'];
  const values = [req.user.id];
  let idx = 2;

  if (unread_only === 'true') conditions.push('is_read = FALSE');

  try {
    const { rows } = await db.query(
      `SELECT * FROM notifications WHERE ${conditions.join(' AND ')}
        ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      [...values, limit, offset]
    );
    const unreadCount = await db.query(
      `SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = FALSE`,
      [req.user.id]
    );
    res.json({
      notifications: rows,
      unread_count: parseInt(unreadCount.rows[0].count),
      page: Number(page), limit: Number(limit),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── PUT /notifications/:id/read ─────────────────────────────────
const markNotificationRead = async (req, res) => {
  try {
    const { rows } = await db.query(
      `UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2 RETURNING *`,
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Notification not found' });
    res.json({ notification: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── PUT /notifications/read-all ──────────────────────────────────
const markAllNotificationsRead = async (req, res) => {
  try {
    await db.query(`UPDATE notifications SET is_read = TRUE WHERE user_id = $1 AND is_read = FALSE`, [req.user.id]);
    res.json({ message: 'All notifications marked as read' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

module.exports.notifyEscalation = notifyEscalation;
module.exports.notifyOfficerAssigned = notifyOfficerAssigned;
module.exports.createInAppNotification = createInAppNotification;
module.exports.listNotifications = listNotifications;
module.exports.markNotificationRead = markNotificationRead;
module.exports.markAllNotificationsRead = markAllNotificationsRead;
