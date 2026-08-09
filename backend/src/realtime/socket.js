// ============================================================
// Socket.IO real-time layer
// ------------------------------------------------------------
// Additive module — attaches to the existing http.Server created in
// src/index.js (which is patched to wrap the Express app so both
// app.listen-style behavior and Socket.IO can coexist).
// ============================================================
const { Server } = require('socket.io');

let io = null;

function initSocket(httpServer) {
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173')
    .split(',').map((o) => o.trim());

  io = new Server(httpServer, {
    cors: { origin: allowedOrigins, credentials: true },
  });

  io.on('connection', (socket) => {
    // Clients join a room per ward or per user so events can be scoped
    // instead of broadcast to everyone (e.g. officer dashboards only
    // caring about their own ward).
    socket.on('join_ward', (wardId) => socket.join(`ward:${wardId}`));
    socket.on('join_user', (userId) => socket.join(`user:${userId}`));

    socket.on('disconnect', () => {});
  });

  return io;
}

function getIO() {
  if (!io) throw new Error('Socket.IO not initialized — call initSocket(httpServer) first');
  return io;
}

// ── Event emitters used by controllers/services ───────────────
function emitComplaintCreated(complaint) {
  if (!io) return;
  io.emit('complaint_created', complaint);
  if (complaint.ward_id) io.to(`ward:${complaint.ward_id}`).emit('complaint_created', complaint);
}

function emitComplaintStatusUpdated(complaintId, status, remarks) {
  if (!io) return;
  io.emit('complaint_status_updated', { complaintId, status, remarks });
}

function emitComplaintEscalated(complaintId, level, reason) {
  if (!io) return;
  io.emit('complaint_escalated', { complaintId, level, reason });
}

module.exports = {
  initSocket, getIO,
  emitComplaintCreated, emitComplaintStatusUpdated, emitComplaintEscalated,
};
