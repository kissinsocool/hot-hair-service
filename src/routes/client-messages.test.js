const assert = require('node:assert/strict');
const test = require('node:test');
const registerClientMessageRoutes = require('./client-messages');

const appWithRoutes = () => {
  const routes = new Map();
  return {
    routes,
    app: {
      get(path, handler) { routes.set(`GET ${path}`, handler); },
      patch(path, handler) { routes.set(`PATCH ${path}`, handler); },
    },
  };
};

test('booking message endpoints count unread events and mark only displayed events read', async () => {
  const { app, routes } = appWithRoutes();
  let countQuery;
  let readQuery;
  let readUpdate;
  const cursor = {
    select() { return this; },
    sort() { return this; },
    skip() { return this; },
    limit() { return this; },
    async lean() { return []; },
  };
  const BookingMessage = {
    find() { return cursor; },
    async countDocuments(query) { countQuery = query; return 2; },
    async updateMany(query, update) {
      readQuery = query;
      readUpdate = update;
      return { modifiedCount: 2 };
    },
  };
  registerClientMessageRoutes(app, {
    BookingMessage,
    normalizePagination: () => ({ page: 1, limit: 20, skip: 0 }),
    normalizeUserId: value => value,
    setPaginationHeaders() {},
    userIdAliases: value => [value, `legacy-${value}`],
  });

  let response;
  const request = { clientUser: { id: 'user-1' }, body: {}, query: {} };
  await routes.get('GET /api/booking-messages/unread-count')(
    request,
    { json(value) { response = value; } },
  );
  assert.deepEqual(countQuery, {
    userId: { $in: ['user-1', 'legacy-user-1'] },
    readAt: null,
  });
  assert.deepEqual(response, { count: 2 });

  request.body.through = '2030-01-01T03:00:00.000Z';
  await routes.get('PATCH /api/booking-messages/read')(
    request,
    { json(value) { response = value; }, status() { return this; } },
  );
  assert.deepEqual(readQuery.userId, { $in: ['user-1', 'legacy-user-1'] });
  assert.equal(readQuery.readAt, null);
  assert.equal(readQuery.createdAt.$lte.toISOString(), request.body.through);
  assert.ok(readUpdate.$set.readAt instanceof Date);
  assert.deepEqual(response, { updatedCount: 2 });
});
