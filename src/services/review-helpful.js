const { ReviewHelpful, ClientUser } = require('../models');
const { activeSessionQuery, normalizeUserId } = require('./auth');

async function addReviewHelpfulState(reviews, token = '') {
  if (!reviews.length) return [];
  const viewer = token ? await ClientUser.findOne({ ...activeSessionQuery(token), authProvider: 'wechat' }).select('id').lean() : null;
  const viewerId = viewer ? normalizeUserId(viewer.id) : '';
  const rows = await ReviewHelpful.aggregate([
    { $match: { bookingId: { $in: reviews.map(review => review.bookingId).filter(Boolean) } } },
    { $group: {
      _id: { bookingId: '$bookingId', reviewId: '$reviewId' },
      helpfulCount: { $sum: 1 },
      helpful: { $max: { $cond: [{ $eq: ['$userId', viewerId] }, 1, 0] } },
    } },
  ]);
  const key = (bookingId, reviewId) => JSON.stringify([bookingId, reviewId]);
  const states = new Map(rows.map(row => [key(row._id.bookingId, row._id.reviewId), row]));
  return reviews.map(review => {
    const state = states.get(key(review.bookingId, review.id));
    return { ...review, helpfulCount: state?.helpfulCount || 0, helpful: Boolean(state?.helpful) };
  });
}

async function recordReviewHelpful(bookingId, reviewId, userId) {
  const identity = { bookingId, reviewId, userId: normalizeUserId(userId) };
  try {
    await ReviewHelpful.updateOne(identity, { $setOnInsert: identity }, { upsert: true });
  } catch (error) {
    if (error.code !== 11000) throw error;
  }
  const helpfulCount = await ReviewHelpful.countDocuments({ bookingId, reviewId });
  return { bookingId, reviewId, helpfulCount, helpful: true };
}

module.exports = { addReviewHelpfulState, recordReviewHelpful };
