const { Salon } = require('../models');
const { ratingSummary } = require('./salon');
const { EMPTY_REVIEW_STATS, aggregateReviewStats, reviewListStats } = require('./staff-ratings');

const uniqueIds = (salonIds = []) => [...new Set(salonIds.map(id => String(id || '').trim()).filter(Boolean))];

// A salon's rating covers every approved review of a booking made at the salon, including those of stylists who
// have since left, so removing a stylist can neither change the salon's rating nor hide its reviews. The
// statistics are stored on the salon (Salon.ratingStats) so lists can sort by rating without recomputing it and
// a salon read carries its own rating. Call this after any write that changes which reviews are approved or what
// an approved review contains. Recomputing (rather than incrementing) makes it idempotent.
async function refreshSalonRatingSummaries(salonIds = []) {
  const ids = uniqueIds(salonIds);
  if (!ids.length) return;
  const computedAt = new Date();
  const statsById = await aggregateReviewStats('salonId', ids);
  await Promise.all(ids.map((salonId) => {
    const { techniqueCount, techniqueTotal, ...stats } = statsById.get(salonId) || EMPTY_REVIEW_STATS;
    return Salon.updateOne(
      // Only replace statistics computed from an older snapshot; a concurrent, newer refresh wins.
      { id: salonId, $or: [
        { 'ratingStats.computedAt': { $lt: computedAt } },
        { 'ratingStats.computedAt': { $exists: false } },
      ] },
      { $set: { ratingStats: { ...stats, computedAt } } },
      // Not a content change: keep updatedAt, which versions the public detail cache and dates content submissions.
      { timestamps: false },
    );
  }));
}

// Salon.ratingStats is not selected by default. A query whose result feeds the two readers below must add this
// to its projection; without it they report the salon as unrated.
const SALON_RATING_STATS_SELECTION = '+ratingStats';

// Public rating of a salon read with SALON_RATING_STATS_SELECTION: { rating, reviewCount }, rating null if unrated.
const salonRatingSummary = (salon) => {
  const { rating, reviewCount } = ratingSummary(salon?.ratingStats?.reviewCount, salon?.ratingStats?.ratingTotal);
  return { rating, reviewCount };
};

// Everything a salon's review list and detail page show besides the reviews themselves.
const salonReviewStats = salon => ({
  ...reviewListStats([salon?.ratingStats || EMPTY_REVIEW_STATS]),
  ...salonRatingSummary(salon),
});

module.exports = {
  SALON_RATING_STATS_SELECTION,
  refreshSalonRatingSummaries,
  salonRatingSummary,
  salonReviewStats,
};
