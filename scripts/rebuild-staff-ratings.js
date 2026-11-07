// Recomputes every stylist's stored rating totals from approved booking reviews.
// Run once after deploying stored ratings, or any time the totals need to be re-derived. Safe to repeat.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const mongoose = require('mongoose');
const { Booking, StaffProfile, StaffRatingSummary } = require('../src/models');
const { refreshStaffRatingSummaries } = require('../src/services/staff-ratings');

const BATCH_SIZE = 200;

async function rebuildStaffRatings() {
  const [profileIds, reviewedIds, storedIds] = await Promise.all([
    StaffProfile.distinct('id'),
    Booking.distinct('staffId', { review: { $exists: true } }),
    StaffRatingSummary.distinct('staffId'),
  ]);
  const ids = [...new Set([...profileIds, ...reviewedIds, ...storedIds].map(String).filter(Boolean))];
  for (let index = 0; index < ids.length; index += BATCH_SIZE) {
    await refreshStaffRatingSummaries(ids.slice(index, index + BATCH_SIZE));
  }
  return ids.length;
}

async function run() {
  const uri = String(process.env.MONGODB_URI || '').trim();
  if (!uri) throw new Error('MONGODB_URI is required');
  await mongoose.connect(uri);
  try {
    await StaffRatingSummary.createIndexes();
    const count = await rebuildStaffRatings();
    console.log(`Rebuilt stored ratings for ${count} stylists.`);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { rebuildStaffRatings };
