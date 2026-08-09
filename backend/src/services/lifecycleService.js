// ============================================================
// Lifecycle Service
// ------------------------------------------------------------
// Defines the full complaint governance lifecycle and validates
// transitions between states. Legacy statuses ('reported',
// 'in_progress') are kept as first-class nodes so every complaint
// created before this upgrade — and every existing API caller —
// keeps working unchanged.
//
//   reported → verified → assigned → accepted → work_started
//     → under_inspection → resolved → citizen_verification → closed
//                                            ↳ reopened → assigned
//
//   Legacy shortcut still valid: reported → verified → assigned
//     → in_progress → resolved (skips the granular officer steps)
// ============================================================

const STATUS_FLOW = {
  reported:              ['verified', 'rejected'],
  verified:              ['assigned', 'rejected'],
  assigned:              ['accepted', 'in_progress', 'verified', 'rejected'],
  accepted:              ['work_started', 'assigned'],
  work_started:          ['under_inspection', 'resolved'],
  under_inspection:      ['resolved', 'work_started'],
  in_progress:           ['resolved', 'under_inspection'], // legacy alias of work_started
  resolved:              ['citizen_verification', 'closed'],
  citizen_verification:  ['closed', 'reopened'],
  reopened:              ['assigned', 'verified'],
  closed:                [],
  rejected:              [],
};

const ALL_STATUSES = Object.keys(STATUS_FLOW);

/** Returns true if `from` -> `to` is an allowed transition. */
function canTransition(from, to) {
  if (!STATUS_FLOW[from]) return false;
  return STATUS_FLOW[from].includes(to);
}

/** Returns the list of statuses a complaint in `status` can move to next. */
function nextAllowed(status) {
  return STATUS_FLOW[status] || [];
}

/** Human-readable label for a status, used by timeline/UI consumers. */
const STATUS_LABELS = {
  reported:              'Submitted',
  verified:              'Verified',
  assigned:              'Assigned',
  accepted:              'Accepted by Officer',
  work_started:          'Work Started',
  in_progress:           'Work In Progress',
  under_inspection:      'Under Inspection',
  resolved:              'Resolved',
  citizen_verification:  'Awaiting Citizen Verification',
  closed:                'Closed',
  reopened:              'Reopened',
  rejected:              'Rejected',
};

module.exports = { STATUS_FLOW, ALL_STATUSES, STATUS_LABELS, canTransition, nextAllowed };
