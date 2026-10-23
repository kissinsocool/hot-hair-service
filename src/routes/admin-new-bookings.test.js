const assert = require('node:assert/strict');
const test = require('node:test');
const { AdminUser } = require('../models');
const registerAdminRoutes = require('./admin');

function setup() {
  const routes = new Map();
  const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map(method => [
    method, (path, ...handlers) => routes.set(`${method}:${path}`, handlers.at(-1)),
  ]));
  const users = new Map(['a', 'b'].map(id => [id, new AdminUser({ id, username: id })]));
  const bookings = [
    { id: 'yesterday', createdAt: new Date('2026-10-22T15:59:59.999Z'), status: 'pending' },
    { id: 'midnight', createdAt: new Date('2026-10-22T16:00:00.000Z'), status: 'canceled' },
    { id: 'morning', createdAt: new Date('2026-10-23T01:00:00.000Z'), status: 'pending' },
    { id: 'at-snapshot', createdAt: new Date('2026-10-23T02:00:00.000Z'), status: 'pending' },
  ];
  const updates = [];
  const matches = (booking, query = {}) =>
    (!query.status || booking.status === query.status) &&
    (!query.createdAt || (booking.createdAt >= query.createdAt.$gte && booking.createdAt < query.createdAt.$lt));
  const counts = { countDocuments: async () => 0 };
  registerAdminRoutes(app, {
    rateLimits: { upload: [] }, MerchantUser: counts, ClientUser: counts, Salon: counts,
    AnalyticsEvent: { aggregate: async () => [] },
    AdminUser: { updateOne: async (query, update) => {
      updates.push({ query, update });
      const user = users.get(query.id);
      const before = update.$max.newBookingsViewedBefore;
      if (!user.newBookingsViewedBefore || before > user.newBookingsViewedBefore) user.newBookingsViewedBefore = before;
      return { matchedCount: 1 };
    } },
    Booking: {
      countDocuments: async query => bookings.filter(b => matches(b, query)).length,
      find(query) {
        let skip = 0;
        let limit = 100;
        return {
          select() { return this; }, sort() { return this; },
          skip(value) { skip = value; return this; },
          limit(value) { limit = value; return this; },
          async lean() { return bookings.filter(b => matches(b, query)).reverse().slice(skip, skip + limit); },
        };
      },
    },
    normalizeBooking: value => value,
    normalizePagination: query => ({ skip: ((Number(query.page) || 1) - 1) * (Number(query.limit) || 100), limit: Number(query.limit) || 100 }),
    setPaginationHeaders: (res, _pagination, total) => res.headers.total = total,
  });
  return { users, updates, bookings, async request(path, { method = 'get', user = 'a', body = {}, query = {} } = {}) {
    const res = { statusCode: 200, body: null, headers: {},
      status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    await routes.get(`${method}:/api/admin/${path}`)({ query, body, adminUser: users.get(user) }, res);
    return res;
  } };
}

const before = '2026-10-23T02:00:00.000Z';
function clock(t) { t.mock.timers.enable({ apis: ['Date'], now: new Date(before) }); }

test('overview counts creation on Shanghai day regardless of status and does not mark viewed', async t => {
  clock(t);
  const f = setup();
  const { body } = await f.request('overview');
  assert.equal(body.todayBookingCount, 2);
  assert.equal(body.unviewedBookingCount, 2);
  assert.equal(body.bookingsSnapshotBefore, before);
  assert.equal(body.bookingCount, 4);
  assert.equal(f.users.get('a').newBookingsViewedBefore, undefined);
});

test('snapshot pagination excludes yesterday and orders arriving during load; viewed is per admin and monotonic', async t => {
  clock(t);
  const f = setup();
  for (const [page, expected] of [[1, 'morning'], [2, 'midnight']]) {
    const res = await f.request('new-bookings', { query: { before, page, limit: 1 } });
    assert.equal(res.headers.total, 2);
    assert.equal(res.body[0].id, expected);
  }
  await f.request('new-bookings/viewed', { method: 'post', body: { before, adminId: 'b' } });
  assert.equal((await f.request('overview')).body.unviewedBookingCount, 0);
  assert.equal((await f.request('overview', { user: 'b' })).body.unviewedBookingCount, 2);
  await f.request('new-bookings/viewed', { method: 'post', body: { before: '2026-10-23T01:00:00.000Z' } });
  assert.equal(f.users.get('a').newBookingsViewedBefore.toISOString(), before);
  assert.deepEqual(f.updates[0].query, { id: 'a' });
  assert.ok(f.updates[0].update.$max.newBookingsViewedBefore instanceof Date);
  t.mock.timers.tick(1);
  const overview = (await f.request('overview')).body;
  assert.equal(overview.todayBookingCount, 3);
  assert.equal(overview.unviewedBookingCount, 1);
});

test('new Shanghai day excludes previous unread orders', async t => {
  clock(t);
  const f = setup();
  t.mock.timers.setTime(new Date('2026-10-23T16:00:01.000Z').getTime());
  const { body } = await f.request('overview');
  assert.equal(body.todayBookingCount, 0);
  assert.equal(body.unviewedBookingCount, 0);
});

test('invalid snapshots never query or mark viewed', async t => {
  clock(t);
  const f = setup();
  for (const value of [undefined, null, '', 'bad', '2026-02-30', '2026-10-24T00:00:00.000Z', [], 123]) {
    assert.equal((await f.request('new-bookings', { query: { before: value } })).statusCode, 400);
    assert.equal((await f.request('new-bookings/viewed', { method: 'post', body: { before: value } })).statusCode, 400);
  }
  assert.equal(f.updates.length, 0);
});

test('released admin bookings request still returns all orders with unchanged pagination', async t => {
  clock(t);
  const f = setup();
  const res = await f.request('bookings', { query: { page: 1, limit: 100 } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers.total, 4);
  assert.equal(res.body.length, 4);
});
