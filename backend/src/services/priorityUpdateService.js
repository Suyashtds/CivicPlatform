const axios = require('axios');
const db    = require('../db');

const ML_URL = () => process.env.ML_SERVICE_URL || 'http://localhost:8000';

// ── Recalculate priority for all unresolved complaints ───────
// Called once daily via setInterval in index.js
const recalculateAllPriorities = async () => {
  console.log('🔄 Starting daily priority score recalculation...');

  try {
    // Fetch all unresolved complaints with their current data
    const { rows } = await db.query(
      `SELECT id, severity_score, upvote_count, ward_id, created_at
         FROM complaints
        WHERE status NOT IN ('resolved', 'rejected')
        ORDER BY created_at ASC`
    );

    if (!rows.length) {
      console.log('✅ No unresolved complaints to update.');
      return;
    }

    let updated = 0;
    let failed  = 0;

    for (const complaint of rows) {
      try {
        // Calculate age in hours since complaint was created
        const ageMs    = Date.now() - new Date(complaint.created_at).getTime();
        const ageHours = ageMs / (1000 * 60 * 60);

        // Call ML service to recalculate priority
        const { data } = await axios.post(
          `${ML_URL()}/ml/recalculate-priority/${complaint.id}`,
          null,
          {
            params: {
              severity:    complaint.severity_score || 0.5,
              upvotes:     complaint.upvote_count   || 0,
              age_hours:   Math.round(ageHours),
              ward_id:     complaint.ward_id,
            },
            timeout: 3000,
          }
        );

        // Update priority score in DB
        await db.query(
          `UPDATE complaints SET priority_score = $1, updated_at = NOW() WHERE id = $2`,
          [data.priority_score, complaint.id]
        );

        updated++;
      } catch (err) {
        console.warn(`Failed to update priority for complaint ${complaint.id}:`, err.message);
        failed++;
      }
    }

    console.log(`✅ Priority recalculation complete — ${updated} updated, ${failed} failed.`);
  } catch (err) {
    console.error('Priority recalculation error:', err.message);
  }
};

module.exports = { recalculateAllPriorities };
