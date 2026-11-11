const { Booking, ClientUser } = require('../models');
const { normalizeUserId, userIdAliases } = require('./auth');
const { publicReviewFromBooking } = require('./salon');
const { readReviewListStats } = require('./staff-ratings');
const { salonReviewStats } = require('./salon-ratings');

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

const EMPTY_STATS = { counts: { all: 0, negative: 0, neutral: 0, photos: 0 }, reviewTags: [] };

// One page of approved reviews, newest first: for a salon (anything with an id) every review of a booking made
// there, including those of stylists who have left; otherwise the reviews of the given stylists.
// Counts and tag counts come from stored statistics; the page itself is read through the
// { salonId | staffId, review.reviewStatus, review.createdAt, _id } index, so a page never scans the other reviews.
// A salon must have been read with SALON_RATING_STATS_SELECTION, or its counts are reported as zero.
async function getSalonReviewsPage(salon, pagination, filter) {
  const salonId = String(salon.id || '').trim();
  const staffIds = salonId ? [] : uniqueIds(salon.staffIds);
  const scope = salonId ? { salonId } : { staffId: { $in: staffIds } };
  const [bookings, { counts, reviewTags }] = salonId || staffIds.length ? await Promise.all([
    Booking.find({
      ...scope,
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
    salonId ? salonReviewStats(salon) : readReviewListStats(staffIds),
  ]) : [[], EMPTY_STATS];
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
