const { Booking, StaffRatingSummary } = require('../models');
const { ratingSummary, REVIEW_TAGS } = require('./salon');

const uniqueIds = (staffIds = []) => [...new Set(staffIds.map(String).filter(Boolean))];

const validTechnique = { $and: [
  { $isNumber: '$review.ratings.technique' },
  { $gte: ['$review.ratings.technique', 1] },
  { $lte: ['$review.ratings.technique', 5] },
] };
const countWhen = condition => ({ $sum: { $cond: [condition, 1, 0] } });

const STAT_FIELDS = 'staffId reviewCount ratingTotal techniqueCount techniqueTotal negativeCount neutralCount photoCount tagCounts';

// Recomputes the stored review statistics of these stylists from their approved reviews: rating totals, the
// review list filter counts and tag counts. Call it after any write that changes which reviews are approved or
// what an approved review contains. Recomputing (rather than incrementing) makes it idempotent, so a retry or a
// rebuild always converges on the bookings.
async function refreshStaffRatingSummaries(staffIds = []) {
  const ids = uniqueIds(staffIds);
  if (!ids.length) return;
  const computedAt = new Date();
  const [result] = await Booking.aggregate([
    { $match: { staffId: { $in: ids }, 'review.reviewStatus': 'approved' } },
    { $facet: {
      ratings: [
        { $match: { 'review.rating': { $gte: 1, $lte: 5 } } },
        { $group: {
          _id: '$staffId',
          reviewCount: { $sum: 1 },
          ratingTotal: { $sum: '$review.rating' },
          techniqueCount: countWhen(validTechnique),
          techniqueTotal: { $sum: { $cond: [validTechnique, '$review.ratings.technique', 0] } },
          negativeCount: countWhen({ $lt: ['$review.rating', 3] }),
          neutralCount: countWhen({ $and: [{ $gte: ['$review.rating', 3] }, { $lt: ['$review.rating', 4] }] }),
          photoCount: countWhen({ $gt: [{ $size: { $ifNull: ['$review.imageUrls', []] } }, 0] }),
        } },
      ],
      tags: [
        { $unwind: '$review.tags' },
        { $match: { 'review.tags': { $in: REVIEW_TAGS } } },
        { $group: { _id: { staffId: '$staffId', name: '$review.tags' }, count: { $sum: 1 } } },
      ],
    } },
  ]);
  const totals = new Map((result?.ratings || []).map(row => [String(row._id), row]));
  const tagsByStaff = new Map();
  for (const row of result?.tags || []) {
    const staffId = String(row._id.staffId);
    if (!tagsByStaff.has(staffId)) tagsByStaff.set(staffId, new Map());
    tagsByStaff.get(staffId).set(row._id.name, row.count);
  }
  await Promise.all(ids.map(async (staffId) => {
    const row = totals.get(staffId) || {};
    const tags = tagsByStaff.get(staffId) || new Map();
    try {
      await StaffRatingSummary.updateOne(
        // Only replace statistics computed from an older snapshot; a concurrent, newer refresh wins.
        { staffId, computedAt: { $lt: computedAt } },
        { $set: {
          reviewCount: row.reviewCount || 0,
          ratingTotal: row.ratingTotal || 0,
          techniqueCount: row.techniqueCount || 0,
          techniqueTotal: row.techniqueTotal || 0,
          negativeCount: row.negativeCount || 0,
          neutralCount: row.neutralCount || 0,
          photoCount: row.photoCount || 0,
          tagCounts: REVIEW_TAGS.filter(name => tags.get(name)).map(name => ({ name, count: tags.get(name) })),
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

const readStaffReviewStats = async (staffIds = []) => {
  const ids = uniqueIds(staffIds);
  if (!ids.length) return [];
  return StaffRatingSummary.find({ staffId: { $in: ids } }).select(STAT_FIELDS).lean();
};

// Public rating summaries keyed by staff id, in the shape the payload builders expect.
async function readStaffRatingSummaries(staffIds = []) {
  const rows = await readStaffReviewStats(staffIds);
  return Object.fromEntries(rows.filter(row => row.reviewCount > 0).map(row => [row.staffId, {
    ...ratingSummary(row.reviewCount, row.ratingTotal),
    techniqueRating: ratingSummary(row.techniqueCount, row.techniqueTotal).rating,
  }]));
}

// Review list counts and tag counts for a group of stylists (a salon, or one stylist).
async function readReviewListStats(staffIds = []) {
  const rows = await readStaffReviewStats(staffIds);
  const counts = { all: 0, negative: 0, neutral: 0, photos: 0 };
  const tags = new Map();
  for (const row of rows) {
    counts.all += row.reviewCount || 0;
    counts.negative += row.negativeCount || 0;
    counts.neutral += row.neutralCount || 0;
    counts.photos += row.photoCount || 0;
    for (const tag of row.tagCounts || []) tags.set(tag.name, (tags.get(tag.name) || 0) + tag.count);
  }
  return { counts, reviewTags: REVIEW_TAGS.filter(name => tags.get(name)).map(name => ({ name, count: tags.get(name) })) };
}

module.exports = { refreshStaffRatingSummaries, readStaffRatingSummaries, readReviewListStats };
