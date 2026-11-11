// Drops the analytics event indexes that no query uses (name, userId, salonId, bookingId).
// Removing an index from the schema does not remove it from MongoDB, so run this once after deploying the
// schema change. Safe to repeat: indexes that are already gone are skipped. Pass --dry-run to only list them.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const mongoose = require('mongoose');
const { AnalyticsEvent } = require('../src/models');

const UNUSED_INDEX_KEYS = [{ name: 1 }, { userId: 1 }, { salonId: 1 }, { bookingId: 1 }];

// Matched by key rather than by name, so an index is dropped only if it is exactly the single-field one.
const unusedIndexNames = indexes => indexes
  .filter(index => !index.unique && index.expireAfterSeconds === undefined
    && UNUSED_INDEX_KEYS.some(keys => JSON.stringify(keys) === JSON.stringify(index.key)))
  .map(index => index.name);

async function run({ dryRun = process.argv.includes('--dry-run') } = {}) {
  const uri = String(process.env.MONGODB_URI || '').trim();
  if (!uri) throw new Error('MONGODB_URI is required');
  await mongoose.connect(uri);
  try {
    const names = unusedIndexNames(await AnalyticsEvent.collection.indexes());
    if (!dryRun) {
      for (const name of names) await AnalyticsEvent.collection.dropIndex(name);
    }
    console.log(JSON.stringify({ event: 'analytics_unused_indexes', dryRun, dropped: dryRun ? [] : names, found: names }));
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error('Dropping unused analytics indexes failed:', error.message);
    process.exit(1);
  });
}

module.exports = { unusedIndexNames };
