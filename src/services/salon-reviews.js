const { Booking, ClientUser } = require('../models');
const { normalizeUserId, userIdAliases } = require('./auth');
const { publicReviewFromBooking } = require('./salon');

async function getSalonReviewsPage(salon, pagination, filter) {
  const ratingFilter = filter === 'negative' ? { $gte: 1, $lt: 3 }
    : filter === 'neutral' ? { $gte: 3, $lt: 4 } : { $gte: 1, $lte: 5 };
  const [result] = await Booking.aggregate([
    { $match: {
      staffId: { $in: salon.staffIds || [] },
      'review.reviewStatus': 'approved',
      'review.rating': { $gte: 1, $lte: 5 },
    } },
    { $facet: {
      items: [
        { $match: { 'review.rating': ratingFilter } },
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
        negative: { $sum: { $cond: [{ $lt: ['$review.rating', 3] }, 1, 0] } },
        neutral: { $sum: { $cond: [{ $and: [
          { $gte: ['$review.rating', 3] }, { $lt: ['$review.rating', 4] },
        ] }, 1, 0] } },
      } }],
    } },
  ]).option({ maxTimeMS: 5000, allowDiskUse: true });
  const bookings = result?.items || [];
  const userIds = [...new Set(bookings.flatMap(booking => userIdAliases(booking.userId)))];
  const users = userIds.length
    ? await ClientUser.find({ id: { $in: userIds } }).select('id avatarUrl').lean()
    : [];
  const avatars = new Map(users.map(user => [normalizeUserId(user.id), user.avatarUrl]));
  const summary = result?.counts?.[0];
  const counts = { all: summary?.all || 0, negative: summary?.negative || 0, neutral: summary?.neutral || 0 };
  const total = counts[filter === 'latest' ? 'all' : filter];
  return {
    items: bookings.map(booking => publicReviewFromBooking(booking, avatars.get(normalizeUserId(booking.userId)) || '')),
    page: pagination.page,
    limit: pagination.limit,
    total,
    hasMore: pagination.skip + bookings.length < total,
    counts,
  };
}

module.exports = { getSalonReviewsPage };
