const { Booking, ClientUser } = require('../models');
const { normalizeUserId, userIdAliases } = require('./auth');
const { publicReviewFromBooking } = require('./salon');
const { readReviewListStats } = require('./staff-ratings');

const RATING_FILTERS = Object.freeze({
  latest: { $gte: 1, $lte: 5 },
  negative: { $gte: 1, $lt: 3 },
  neutral: { $gte: 3, $lt: 4 },
  photos: { $gte: 1, $lte: 5 },
});

const uniqueIds = (staffIds = []) => [...new Set(staffIds.map(String).filter(Boolean))];

// Tag counts over the approved reviews of these stylists, in the configured display order.
async function getApprovedReviewTagCountsByStaffIds(staffIds = []) {
  return (await readReviewListStats(staffIds)).reviewTags;
}

// One page of approved reviews for a salon (or any group of stylists), newest first.
// Counts and tag counts come from stored stylist statistics; the page itself is read through the
// { staffId, review.reviewStatus, review.createdAt, _id } index, so a page never scans the other reviews.
async function getSalonReviewsPage(salon, pagination, filter) {
  const staffIds = uniqueIds(salon.staffIds);
  const [bookings, { counts, reviewTags }] = staffIds.length ? await Promise.all([
    Booking.find({
      staffId: { $in: staffIds },
      'review.reviewStatus': 'approved',
      'review.rating': RATING_FILTERS[filter] || RATING_FILTERS.latest,
      ...(filter === 'photos' ? { 'review.imageUrls.0': { $exists: true } } : {}),
    })
      .sort({ 'review.createdAt': -1, _id: -1 })
      .skip(pagination.skip)
      .limit(pagination.limit)
      .select('id userId staffId staffName review')
      .maxTimeMS(5000)
      .lean(),
    readReviewListStats(staffIds),
  ]) : [[], { counts: { all: 0, negative: 0, neutral: 0, photos: 0 }, reviewTags: [] }];
  const userIds = [...new Set(bookings.flatMap(booking => userIdAliases(booking.userId)))];
  const users = userIds.length
    ? await ClientUser.find({ id: { $in: userIds } }).select('id avatarUrl').lean()
    : [];
  const avatars = new Map(users.map(user => [normalizeUserId(user.id), user.avatarUrl]));
  const total = counts[filter === 'latest' ? 'all' : filter] || 0;
  return {
    items: bookings.map(booking => publicReviewFromBooking(booking, avatars.get(normalizeUserId(booking.userId)) || '')),
    page: pagination.page,
    limit: pagination.limit,
    total,
    hasMore: pagination.skip + bookings.length < total,
    counts,
    reviewTags,
  };
}

module.exports = { getSalonReviewsPage, getApprovedReviewTagCountsByStaffIds };
