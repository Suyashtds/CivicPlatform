// ============================================================
// RBAC — Permission Matrix
// ------------------------------------------------------------
// Complements (does not replace) the existing requireRole() guard
// in middleware/auth.js. Where requireRole checks the coarse `role`
// column, requirePermission checks a specific named action against
// a role+rank matrix — used by the new governance endpoints where
// "department" alone isn't granular enough (e.g. only a
// department_head or commissioner should approve escalations).
// ============================================================

// role -> officer_rank -> Set of permitted actions.
// 'admin' and 'citizen' have no officer_rank, so they key on role only.
const PERMISSION_MATRIX = {
  admin: ['*'], // full access
  citizen: [
    'complaint.create', 'complaint.view_own', 'complaint.upvote',
    'complaint.comment', 'complaint.bookmark', 'complaint.feedback',
    'complaint.citizen_verify', 'complaint.reopen',
  ],
  officer: {
    officer:          ['complaint.accept', 'complaint.work_started', 'complaint.submit_inspection', 'evidence.upload', 'leave.request'],
    senior_officer:   ['complaint.accept', 'complaint.work_started', 'complaint.submit_inspection', 'evidence.upload', 'leave.request', 'complaint.reassign', 'leave.approve'],
    department_head:  ['complaint.assign', 'complaint.reassign', 'leave.approve', 'escalation.view', 'department.view_efficiency', 'officer.manage'],
    commissioner:     ['complaint.assign', 'complaint.reassign', 'leave.approve', 'escalation.view', 'escalation.resolve', 'department.view_efficiency', 'officer.manage', 'analytics.view_all'],
  },
  department: [ // legacy role, kept working as a generic department-level operator
    'complaint.assign', 'complaint.status_update', 'analytics.view_department',
  ],
};

function roleHasPermission(user, action) {
  if (!user) return false;
  if (user.role === 'admin') return true;

  const entry = PERMISSION_MATRIX[user.role];
  if (!entry) return false;

  if (Array.isArray(entry)) return entry.includes(action);
  // officer role: keyed by rank
  const rankPerms = entry[user.officer_rank] || [];
  return rankPerms.includes(action);
}

const requirePermission = (action) => (req, res, next) => {
  if (!roleHasPermission(req.user, action)) {
    return res.status(403).json({ error: `Access denied — missing permission '${action}'` });
  }
  next();
};

module.exports = { PERMISSION_MATRIX, roleHasPermission, requirePermission };
