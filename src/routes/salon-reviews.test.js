const assert = require('node:assert/strict');
const test = require('node:test');
const registerPublicRoutes = require('./public');

const response = () => ({
  statusCode: 200,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return body; },
  set() { return this; },
});

test('staff review preview opts into positive reviews while legacy requests still use latest', async () => {
  const routes = new Map();
  const calls = [];
  registerPublicRoutes({ get: (path, ...handlers) => routes.set(path, handlers.at(-1)) }, {
    rateLimits: { publicRead: [] },
    getStaffById: id => ({ lean: async () => ({ id }) }),
    normalizePagination: query => ({ page: Number(query.page), limit: Number(query.limit) }),
    async getSalonReviewsPage(...args) { calls.push(args); return { items: [] }; },
    addReviewHelpfulState: async items => items,
    sessionTokenFromRequest: () => '',
  });
  const handler = routes.get('/api/staff/:id/reviews');
  const params = { id: 'staff-1' };
  await handler({ params, query: { page: '1', limit: '10' } }, response());
  await handler({ params, query: { filter: 'positive', page: '1', limit: '3' } }, response());
  assert.deepEqual(calls, [
    [{ staffIds: ['staff-1'] }, { page: 1, limit: 10 }, 'latest'],
    [{ staffIds: ['staff-1'] }, { page: 1, limit: 3 }, 'positive'],
  ]);
});

test('public review endpoint validates filters and restricts reads to online salons', async () => {
  const routes = new Map();
  let exists = true;
  const calls = [];
  const payload = { items: [], counts: { all: 0, negative: 0, neutral: 0, photos: 0 }, hasMore: false };
  registerPublicRoutes({ get: (path, ...handlers) => routes.set(path, handlers.at(-1)) }, {
    rateLimits: { publicRead: [] },
    Salon: { findOne(filter) {
      assert.deepEqual(filter, { id: 'salon-1', publishStatus: 'online' });
      return { select(fields) {
        // The salon's stored statistics supply the review counts and tags.
        assert.equal(fields, 'id +ratingStats');
        return { lean: async () => exists ? { id: 'salon-1', ratingStats: { reviewCount: 0 } } : null };
      } };
    } },
    normalizePagination(query, fallback, max) {
      assert.equal(fallback, 10); assert.equal(max, 50);
      return { page: 1, limit: 10, skip: 0 };
    },
    async getSalonReviewsPage(...args) { calls.push(args); return payload; },
    addReviewHelpfulState: async items => items,
    sessionTokenFromRequest: () => '',
  });
  const handler = routes.get('/api/salons/:id/reviews');
  for (const filter of [undefined, 'latest', 'negative', 'neutral', 'photos']) {
    const res = response();
    await handler({ params: { id: 'salon-1' }, query: filter === undefined ? {} : { filter } }, res);
    assert.deepEqual(res.body, payload);
    assert.equal(calls.at(-1)[2], filter || 'latest');
  }
  for (const filter of ['unknown', '', ['negative', 'neutral'], { $ne: 'latest' }]) {
    const res = response();
    await handler({ params: { id: 'salon-1' }, query: { filter } }, res);
    assert.equal(res.statusCode, 400);
  }
  assert.equal(calls.length, 5);
  exists = false;
  const res = response();
  await handler({ params: { id: 'salon-1' }, query: {} }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(calls.length, 5);
});
