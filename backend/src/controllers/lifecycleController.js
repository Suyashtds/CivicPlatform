// ============================================================
// Lifecycle Controller
// ------------------------------------------------------------
// Granular governance transitions on top of the existing
// PUT /complaints/:id/status endpoint (which is left completely
// untouched). These new endpoints validate every transition against
// services/lifecycleService.js and keep status_history + audit_logs
// in sync, and drive the officer-assignment / escalation engines.
// ============================================================
const db = require('../db');
const { canTransition, nextAllowed, STATUS_LABELS } = require('../services/lifecycleService');
const { logAction } = require('../services/auditService');
const { findLeastLoadedOfficer } = require('../services/officerAssignmentService');
const { notifyOfficerAssigned } = require('./notificationController');

async function getComplaintOr404(id, res) {
  const { rows } = await db.query('SELECT * FROM complaints WHERE id = $1', [id]);
  if (!rows.length) { res.status(404).json({ error: 'Complaint not found' }); return null; }
  return rows[0];
}

async function transitionTo(complaintId, newStatus, actor, remarks, extraFields = {}) {
  const setClauses = ['status = $1', 'updated_at = NOW()'];
  const values = [newStatus];
  let idx = 2;
  for (const [col, val] of Object.entries(extraFields)) {
    setClauses.push(`${col} = $${idx++}`);
    values.push(val);
  }
  values.push(complaintId);

  const { rows } = await db.query(
    `UPDATE complaints SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  await db.query(
    `INSERT INTO status_history (complaint_id, status, updated_by, remarks) VALUES ($1,$2,$3,$4)`,
    [complaintId, newStatus, actor?.id || null, remarks || STATUS_LABELS[newStatus]]
  );
  await logAction({ action: 'complaint.status_changed', entityType: 'complaint', entityId: complaintId, actor, metadata: { to: newStatus, remarks } });
  return rows[0];
}

// ── PUT /complaints/:id/assign-officer ──────────────────────
// Admin/department head assigns (or auto-assigns) an officer.
const assignOfficer = async (req, res) => {
  const { officer_id } = req.body;
  const complaint = await getComplaintOr404(req.params.id, res);
  if (!complaint) return;

  try {
    let officer = null;
    if (officer_id) {
      const { rows } = await db.query(`SELECT id, name, department_id FROM users WHERE id = $1 AND role = 'officer'`, [officer_id]);
      if (!rows.length) return res.status(404).json({ error: 'Officer not found' });
      officer = rows[0];
    } else {
      if (!complaint.assigned_department_id) {
        return res.status(400).json({ error: 'Complaint has no department assigned yet — cannot auto-pick an officer' });
      }
      officer = await findLeastLoadedOfficer(complaint.assigned_department_id);
      if (!officer) return res.status(409).json({ error: 'No available officer with free capacity in this department' });
    }

    if (!canTransition(complaint.status, 'assigned') && complaint.status !== 'assigned') {
      return res.status(400).json({
        error: `Cannot assign an officer while complaint is '${complaint.status}'`,
        allowed_next: nextAllowed(complaint.status),
      });
    }

    const updated = await transitionTo(complaint.id, 'assigned', req.user, `Assigned to officer ${officer.name}`, {
      assigned_officer_id: officer.id,
    });

    notifyOfficerAssigned(complaint.id, officer.id).catch(() => {});
    res.json({ complaint: updated, officer });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── PUT /complaints/:id/reassign ────────────────────────────
const reassignComplaint = async (req, res) => {
  const { officer_id, reason } = req.body;
  if (!officer_id) return res.status(400).json({ error: 'officer_id is required' });

  const complaint = await getComplaintOr404(req.params.id, res);
  if (!complaint) return;

  try {
    const { rows } = await db.query(`SELECT id, name FROM users WHERE id = $1 AND role = 'officer'`, [officer_id]);
    if (!rows.length) return res.status(404).json({ error: 'Officer not found' });

    await db.query(
      `UPDATE complaints SET assigned_officer_id = $1, updated_at = NOW() WHERE id = $2`,
      [officer_id, complaint.id]
    );
    await db.query(
      `INSERT INTO status_history (complaint_id, status, updated_by, remarks) VALUES ($1,$2,$3,$4)`,
      [complaint.id, complaint.status, req.user.id, `Reassigned to ${rows[0].name}. Reason: ${reason || 'not specified'}`]
    );
    await logAction({ action: 'complaint.reassigned', entityType: 'complaint', entityId: complaint.id, actor: req.user, metadata: { officer_id, reason } });

    notifyOfficerAssigned(complaint.id, officer_id).catch(() => {});
    res.json({ message: 'Complaint reassigned', officer: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── PUT /complaints/:id/accept ───────────────────────────────
// Officer accepts an assignment
const acceptComplaint = async (req, res) => {
  const complaint = await getComplaintOr404(req.params.id, res);
  if (!complaint) return;
  if (complaint.assigned_officer_id !== req.user.id) {
    return res.status(403).json({ error: 'Only the assigned officer can accept this complaint' });
  }
  if (!canTransition(complaint.status, 'accepted')) {
    return res.status(400).json({ error: `Cannot accept from status '${complaint.status}'`, allowed_next: nextAllowed(complaint.status) });
  }
  const updated = await transitionTo(complaint.id, 'accepted', req.user, 'Accepted by officer');
  res.json({ complaint: updated });
};

// ── PUT /complaints/:id/start-work ───────────────────────────
const startWork = async (req, res) => {
  const complaint = await getComplaintOr404(req.params.id, res);
  if (!complaint) return;
  if (!canTransition(complaint.status, 'work_started')) {
    return res.status(400).json({ error: `Cannot start work from status '${complaint.status}'`, allowed_next: nextAllowed(complaint.status) });
  }
  const updated = await transitionTo(complaint.id, 'work_started', req.user, req.body.remarks || 'Work started on site');
  res.json({ complaint: updated });
};

// ── PUT /complaints/:id/submit-inspection ────────────────────
const submitForInspection = async (req, res) => {
  const complaint = await getComplaintOr404(req.params.id, res);
  if (!complaint) return;
  if (!canTransition(complaint.status, 'under_inspection')) {
    return res.status(400).json({ error: `Cannot submit for inspection from status '${complaint.status}'`, allowed_next: nextAllowed(complaint.status) });
  }
  const updated = await transitionTo(complaint.id, 'under_inspection', req.user, req.body.remarks || 'Submitted for inspection');
  res.json({ complaint: updated });
};

// ── PUT /complaints/:id/resolve ──────────────────────────────
// Requires at least one 'after' evidence image on file.
const resolveComplaint = async (req, res) => {
  const complaint = await getComplaintOr404(req.params.id, res);
  if (!complaint) return;
  if (!canTransition(complaint.status, 'resolved')) {
    return res.status(400).json({ error: `Cannot resolve from status '${complaint.status}'`, allowed_next: nextAllowed(complaint.status) });
  }

  try {
    const afterEvidence = await db.query(
      `SELECT id FROM evidence WHERE complaint_id = $1 AND type = 'after'`,
      [complaint.id]
    );
    if (!afterEvidence.rows.length && !req.body.proof_image_url) {
      return res.status(400).json({ error: "At least one 'after' evidence image is required to resolve a complaint." });
    }

    const slaMet = complaint.sla_resolution_due_at ? new Date() <= new Date(complaint.sla_resolution_due_at) : null;
    const updated = await transitionTo(complaint.id, 'resolved', req.user, req.body.remarks || 'Marked resolved', {
      sla_resolution_met: slaMet,
    });
    res.json({ complaint: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── PUT /complaints/:id/citizen-verify ───────────────────────
// Citizen confirms fix (-> closed) or disputes it (-> reopened)
const citizenVerify = async (req, res) => {
  const { confirmed, remarks } = req.body; // confirmed: boolean
  const complaint = await getComplaintOr404(req.params.id, res);
  if (!complaint) return;

  if (complaint.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Only the citizen who filed this complaint can verify its resolution' });
  }
  if (complaint.status !== 'resolved' && complaint.status !== 'citizen_verification') {
    return res.status(400).json({ error: `Cannot verify from status '${complaint.status}'` });
  }

  try {
    if (confirmed) {
      const updated = await transitionTo(complaint.id, 'closed', req.user, remarks || 'Citizen confirmed resolution', {
        citizen_verified_at: new Date(), closed_at: new Date(),
      });
      return res.json({ complaint: updated });
    }

    const updated = await transitionTo(complaint.id, 'reopened', req.user, remarks || 'Citizen disputed resolution — reopened', {
      reopened_count: complaint.reopened_count + 1,
    });
    const { escalateComplaint } = require('../services/escalationService');
    await escalateComplaint(complaint.id, 'Citizen reopened complaint after resolution');
    res.json({ complaint: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── GET /complaints/:id/allowed-transitions ──────────────────
const getAllowedTransitions = async (req, res) => {
  const complaint = await getComplaintOr404(req.params.id, res);
  if (!complaint) return;
  res.json({ current_status: complaint.status, allowed_next: nextAllowed(complaint.status) });
};

module.exports = {
  assignOfficer, reassignComplaint, acceptComplaint, startWork,
  submitForInspection, resolveComplaint, citizenVerify, getAllowedTransitions,
};
