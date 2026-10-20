const assert = require('node:assert/strict');
const test = require('node:test');
const register = require('./review-helpful');

test('helpful feedback verifies public review identity and uses only the authenticated user', async () => {
  let handler;
  let visible = true;
  let online = true;
  const calls = [];
  register({ post: (_path, ...handlers) => { handler = handlers.at(-1); } }, {
    rateLimits: { reviewHelpful: [] },
    Booking: { findOne(query) {
      assert.equal(query['review.reviewStatus'], 'approved');
      assert.equal(query['review.id'], 'review-1');
      return { select: () => ({ lean: async () => visible ? { id: 'booking-1', staffId: 'staff-1', review: { id: 'review-1' } } : null }) };
    } },
    Salon: { exists: async query => { assert.deepEqual(query, { staffIds: 'staff-1', publishStatus: 'online' }); return online; } },
    recordReviewHelpful: async (...args) => { calls.push(args); return { helpful: true, helpfulCount: 1 }; },
  });
  const run = async body => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; } };
    await handler({ params: { id: 'booking-1' }, body, clientUser: { id: 'real-user' } }, res);
    return res;
  };
  assert.equal((await run({ reviewId: 'review-1', userId: 'forged' })).statusCode, 200);
  assert.deepEqual(calls, [['booking-1', 'review-1', 'real-user']]);
  for (const reviewId of [undefined, '', { $ne: '' }, 'a'.repeat(101)]) assert.equal((await run({ reviewId })).statusCode, 400);
  visible = false;
  assert.equal((await run({ reviewId: 'review-1' })).statusCode, 404);
  visible = true; online = false;
  assert.equal((await run({ reviewId: 'review-1' })).statusCode, 404);
  assert.equal(calls.length, 1);
});
