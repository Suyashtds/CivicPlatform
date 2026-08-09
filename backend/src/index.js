require('dotenv').config();
const express     = require('express');
const cors        = require('cors');
const helmet      = require('helmet');
const compression = require('compression');
const passport = require('./config/passport');
const routes   = require('./routes');
const { generalLimiter }           = require('./middleware/rateLimiter');
const { sanitizeBody }             = require('./middleware/sanitize');
const { cleanupExpiredBlacklist }  = require('./controllers/authController');
const { recalculateAllPriorities } = require('./services/priorityUpdateService');
const { checkSlaBreaches }         = require('./services/slaService');
const { snapshotAllWards }         = require('./services/civicHealthService');

// ── Socket.IO + Swagger (additive) ───────────────────────────
const http = require('http');
const { initSocket } = require('./realtime/socket');
const { setupSwagger } = require('./swagger');

const app  = express();
const PORT = process.env.PORT || 5000;

// ── CORS ─────────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
  .split(',').map(o => o.trim());

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) callback(null, true);
    else callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

// ── Security & performance middleware ───────────────────────
app.use(helmet());
app.use(compression());

// ── Global middleware ────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(sanitizeBody);
app.use(passport.initialize());
app.use('/api', generalLimiter);

// ── Request logger (dev) ─────────────────────────────────────
if (process.env.NODE_ENV !== 'production') {
  app.use((req, _res, next) => {
    console.log(`${req.method} ${req.path}`);
    next();
  });
}

// ── Swagger / OpenAPI docs (additive) ─────────────────────────
setupSwagger(app);

// ── Routes ───────────────────────────────────────────────────
app.use('/api', routes);

// ── Health check ─────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date() }));

// ── Metrics (lightweight, no external monitoring dependency) ──
app.get('/metrics', async (_req, res) => {
  try {
    const db = require('./db');
    const [complaints, escalated, officers] = await Promise.all([
      db.query(`SELECT COUNT(*) FROM complaints WHERE status NOT IN ('resolved','closed','rejected')`),
      db.query(`SELECT COUNT(*) FROM complaints WHERE escalation_level > 0`),
      db.query(`SELECT COUNT(*) FROM users WHERE role = 'officer' AND is_available = TRUE`),
    ]);
    res.json({
      uptime_seconds: Math.round(process.uptime()),
      memory: process.memoryUsage(),
      pending_complaints: parseInt(complaints.rows[0].count),
      escalated_complaints: parseInt(escalated.rows[0].count),
      available_officers: parseInt(officers.rows[0].count),
    });
  } catch (err) {
    res.status(500).json({ error: 'Metrics unavailable', detail: err.message });
  }
});

// ── 404 ──────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));

// ── Global error handler ─────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error(err);
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  res.status(500).json({ error: 'Internal server error' });
});

// ── HTTP server wrapper (needed for Socket.IO to share the same port) ──
const httpServer = http.createServer(app);
initSocket(httpServer);

httpServer.listen(PORT, () => {
  console.log(`✅  Civic Platform API running on http://localhost:${PORT}`);
  console.log(`🔌  Socket.IO attached on the same port`);
  console.log(`📖  Swagger docs at http://localhost:${PORT}/api-docs`);

  // ── Background jobs ──────────────────────────────────────
  // 1. JWT blacklist cleanup — every 6 hours
  cleanupExpiredBlacklist();
  setInterval(cleanupExpiredBlacklist, 6 * 60 * 60 * 1000);

  // 2. Priority score recalculation — every 24 hours
  // Run once 30 seconds after startup, then every 24 hours
  setTimeout(() => {
    recalculateAllPriorities();
    setInterval(recalculateAllPriorities, 24 * 60 * 60 * 1000);
  }, 30 * 1000);

  // 3. SLA breach scan + auto-escalation — every 15 minutes
  setTimeout(() => {
    checkSlaBreaches();
    setInterval(checkSlaBreaches, 15 * 60 * 1000);
  }, 45 * 1000);

  // 4. Civic Health Index daily snapshot — once a day
  setTimeout(() => {
    snapshotAllWards().then((n) => console.log(`🏙️  Civic Health snapshot: ${n} wards recorded.`)).catch(console.error);
    setInterval(() => {
      snapshotAllWards().catch(console.error);
    }, 24 * 60 * 60 * 1000);
  }, 60 * 1000);
});
