const REVIEW_RATING_KEYS = ['environment', 'technique', 'service', 'price'];

function parseReviewRatings(body) {
  if (body.ratings === undefined) {
    const rating = Number(body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return { error: 'rating must be an integer from 1 to 5' };
    }
    return { rating };
  }
  const input = body.ratings;
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).length !== REVIEW_RATING_KEYS.length
    || !REVIEW_RATING_KEYS.every(key => Number.isInteger(input[key]) && input[key] >= 1 && input[key] <= 5)) {
    return { error: 'ratings must contain environment, technique, service and price integers from 1 to 5' };
  }
  const ratings = Object.fromEntries(REVIEW_RATING_KEYS.map(key => [key, input[key]]));
  const rating = REVIEW_RATING_KEYS.reduce((sum, key) => sum + ratings[key], 0) / REVIEW_RATING_KEYS.length;
  return { rating, ratings };
}

module.exports = { REVIEW_RATING_KEYS, parseReviewRatings };
