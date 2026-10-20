const { Booking, ClientUser } = require('../models');
const { normalizeUserId, userIdAliases } = require('./auth');
const { publicReviewFromBooking, REVIEW_TAGS } = require('./salon');

async function getApprovedReviewTagCountsByStaffIds(staffIds = []) {
  const ids = [...new Set(staffIds.map(String).filter(Boolean))];
  if (!ids.length) return [];
  const rows = await Booking.aggregate([
    { $match: { staffId: { $in: ids }, 'review.reviewStatus': 'approved' } },
    { $unwind: '$review.tags' },
    { $match: { 'review.tags': { $in: REVIEW_TAGS } } },
    { $group: { _id: '$review.tags', count: { $sum: 1 } } },
  ]);
  const counts = Object.fromEntries(rows.map(row => [String(row._id), Number(row.count) || 0]));
  return REVIEW_TAGS.filter(name => counts[name]).map(name => ({ name, count: counts[name] }));
}

async function getSalonReviewsPage(salon, pagination, filter) {
  const ratingFilter = filter === 'negative' ? { $gte: 1, $lt: 3 }
    : filter === 'neutral' ? { $gte: 3, $lt: 4 } : { $gte: 1, $lte: 5 };
  const hasPhotos = { $gt: [{ $size: { $ifNull: ['$review.imageUrls', []] } }, 0] };
  const [rows, reviewTags] = await Promise.all([Booking.aggregate([
    { $match: {
      staffId: { $in: salon.staffIds || [] },
      'review.reviewStatus': 'approved',
      'review.rating': { $gte: 1, $lte: 5 },
    } },
    { $facet: {
      items: [
        { $match: { 'review.rating': ratingFilter } },
        ...(filter === 'photos' ? [{ $match: { $expr: hasPhotos } }] : []),
        { $set: { reviewCreatedAt: { $ifNull: [
          '$review.createdAt',
          { $convert: { input: '$review.date', to: 'date', onError: '$updatedAt', onNull: '$updatedAt' } },
        ] } } },
        { $sort: { reviewCreatedAt: -1, _id: -1 } },
        { $skip: pagination.skip },
        { $limit: pagination.limit },
        { $project: { id: 1, userId: 1, staffId: 1, staffName: 1, review: 1 } },
      ],
      counts: [{ $group: {
        _id: null,
        all: { $sum: 1 },
        photos: { $sum: { $cond: [hasPhotos, 1, 0] } },
        negative: { $sum: { $cond: [{ $lt: ['$review.rating', 3] }, 1, 0] } },
        neutral: { $sum: { $cond: [{ $and: [
          { $gte: ['$review.rating', 3] }, { $lt: ['$review.rating', 4] },
        ] }, 1, 0] } },
      } }],
    } },
  ]).option({ maxTimeMS: 5000, allowDiskUse: true }), getApprovedReviewTagCountsByStaffIds(salon.staffIds)]);
  const [result] = rows;
  const bookings = result?.items || [];
  const userIds = [...new Set(bookings.flatMap(booking => userIdAliases(booking.userId)))];
  const users = userIds.length
    ? await ClientUser.find({ id: { $in: userIds } }).select('id avatarUrl').lean()
    : [];
  const avatars = new Map(users.map(user => [normalizeUserId(user.id), user.avatarUrl]));
  const summary = result?.counts?.[0];
  const counts = { all: summary?.all || 0, negative: summary?.negative || 0, neutral: summary?.neutral || 0, photos: summary?.photos || 0 };
  const total = counts[filter === 'latest' ? 'all' : filter];
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
