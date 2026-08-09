// ============================================================
// BullMQ + Redis queue setup
// ------------------------------------------------------------
// Additive: the app already runs SLA breach scanning via a plain
// setInterval in src/index.js (services/slaService.js). This gives
// the same job a proper, durable, retryable queue for deployments
// that want Redis-backed scheduling instead of an in-process timer.
// Both can run side by side; index.js is unchanged.
// ============================================================
const { Queue, QueueEvents } = require('bullmq');
const IORedis = require('ioredis');

const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null, // required by BullMQ
});

const SLA_QUEUE_NAME = 'sla-escalation';

const slaQueue = new Queue(SLA_QUEUE_NAME, { connection });
const slaQueueEvents = new QueueEvents(SLA_QUEUE_NAME, { connection });

/** Registers the repeatable job — call once at startup (see slaEscalationJob.js). */
async function scheduleSlaEscalationJob() {
  await slaQueue.add(
    'scan-sla-breaches',
    {},
    {
      repeat: { every: 15 * 60 * 1000 }, // every 15 minutes
      removeOnComplete: 50,
      removeOnFail: 100,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    }
  );
}

module.exports = { connection, slaQueue, slaQueueEvents, SLA_QUEUE_NAME, scheduleSlaEscalationJob };
