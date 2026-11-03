const assert = require('node:assert/strict');
const test = require('node:test');
const { parseReviewRatings } = require('./review-ratings');
const { Booking } = require('../models');
const ratings = { environment: 5, technique: 4, service: 3, price: 5 };

test('legacy integer requests remain accepted; dimension totals are computed by the server', () => {
  assert.deepEqual(parseReviewRatings({ rating: 4, comment: '很好', tags: [], imageObjects: [] }), { rating: 4 });
  assert.deepEqual(parseReviewRatings({ rating: 1, ratings }), { rating: 4.25, ratings });
  for (const rating of [undefined, 0, 6, 2.5]) assert.ok(parseReviewRatings({ rating }).error);
  for (const input of [null, [], {}, { ...ratings, other: 5 }, ...[undefined, 0, 6, 2.5, '5'].map(price => ({ ...ratings, price }))]) {
    assert.ok(parseReviewRatings({ rating: 5, ratings: input }).error);
  }
});

test('real Mongoose reviews and pending edits retain dimension scores and validate each field', async () => {
  const booking = new Booking({ id: 'dimensions', review: { rating: 4.25, ratings, pendingEdit: { rating: 4.25, ratings } } });
  assert.deepEqual(booking.review.ratings.toObject(), ratings);
  assert.deepEqual(booking.review.pendingEdit.ratings.toObject(), ratings);
  await booking.review.validate();
  booking.review.pendingEdit.ratings.price = 2.5;
  await assert.rejects(booking.review.validate());
  booking.review.pendingEdit.ratings.price = undefined;
  await assert.rejects(booking.review.validate());
});
