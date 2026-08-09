// ============================================================
// SLA Escalation Job (BullMQ, Redis-backed)
// ------------------------------------------------------------
// Repeatable job (every 15 minutes) that reuses the existing
// services/slaService.js::checkSlaBreaches() logic — no duplicate
// escalation logic, just a durable Redis-backed scheduler wrapped
// around the same function src/index.js currently calls via
// setInterval.
//
// Run standalone with: npm run worker:sla
// (keeps the web process and the worker process separate, which is
// the standard BullMQ deployment pattern — see docker-compose.yml)
// ============================================================
require('dotenv').config();
const { Worker } = require('bullmq');
const { connection, SLA_QUEUE_NAME, scheduleSlaEscalationJob } = require('./queue');
const { checkSlaBreaches } = require('../services/slaService');

const worker = new Worker(
  SLA_QUEUE_NAME,
  async (job) => {
    console.log(`[sla-worker] running job ${job.id} (${job.name})`);
    await checkSlaBreaches();
    return { ranAt: new Date().toISOString() };
  },
  {
    connection,
    concurrency: 1, // SLA scans should not overlap
  }
);

worker.on('completed', (job) => {
  console.log(`[sla-worker] job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  console.error(`[sla-worker] job ${job?.id} failed:`, err.message);
});

// Ensure the repeatable schedule is registered, then let the worker run.
scheduleSlaEscalationJob()
  .then(() => console.log('[sla-worker] repeatable job scheduled (every 15 min, 3 retries, exponential backoff)'))
  .catch((err) => console.error('[sla-worker] failed to schedule repeatable job:', err.message));

module.exports = worker;
