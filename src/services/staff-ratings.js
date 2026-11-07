const { Booking, StaffRatingSummary } = require('../models');
const { ratingSummary } = require('./salon');

const uniqueIds = (staffIds = []) => [...new Set(staffIds.map(String).filter(Boolean))];

const validTechnique = { $and: [
  { $isNumber: '$review.ratings.technique' },
  { $gte: ['$review.ratings.technique', 1] },
  { $lte: ['$review.ratings.technique', 5] },
] };

// Recomputes the stored totals of these stylists from their approved reviews. Call it after any write that
// changes which reviews are approved or what an approved review scores. Recomputing (rather than incrementing)
// makes it idempotent, so a retry or a rebuild always converges on the bookings.
async function refreshStaffRatingSummaries(staffIds = []) {
  const ids = uniqueIds(staffIds);
  if (!ids.length) return;
  const computedAt = new Date();
  const rows = await Booking.aggregate([
    { $match: { staffId: { $in: ids }, 'review.reviewStatus': 'approved', 'review.rating': { $gte: 1, $lte: 5 } } },
    { $group: {
      _id: '$staffId',
      reviewCount: { $sum: 1 },
      ratingTotal: { $sum: '$review.rating' },
      techniqueCount: { $sum: { $cond: [validTechnique, 1, 0] } },
      techniqueTotal: { $sum: { $cond: [validTechnique, '$review.ratings.technique', 0] } },
    } },
  ]);
  const totals = new Map(rows.map(row => [String(row._id), row]));
  await Promise.all(ids.map(async (staffId) => {
    const row = totals.get(staffId) || {};
    try {
      await StaffRatingSummary.updateOne(
        // Only replace totals computed from an older snapshot; a concurrent, newer refresh wins.
        { staffId, computedAt: { $lt: computedAt } },
        { $set: {
          reviewCount: row.reviewCount || 0,
          ratingTotal: row.ratingTotal || 0,
          techniqueCount: row.techniqueCount || 0,
          techniqueTotal: row.techniqueTotal || 0,
          computedAt,
        } },
        { upsert: true },
      );
    } catch (error) {
      // The upsert collides with the unique staffId only when a newer refresh already stored this stylist.
      if (error?.code !== 11000) throw error;
    }
  }));
}

// Public rating summaries keyed by staff id, in the shape the payload builders expect.
async function readStaffRatingSummaries(staffIds = []) {
  const ids = uniqueIds(staffIds);
  if (!ids.length) return {};
  const rows = await StaffRatingSummary.find({ staffId: { $in: ids } })
    .select('staffId reviewCount ratingTotal techniqueCount techniqueTotal').lean();
  return Object.fromEntries(rows.filter(row => row.reviewCount > 0).map(row => [row.staffId, {
    ...ratingSummary(row.reviewCount, row.ratingTotal),
    techniqueRating: ratingSummary(row.techniqueCount, row.techniqueTotal).rating,
  }]));
}

module.exports = { refreshStaffRatingSummaries, readStaffRatingSummaries };
