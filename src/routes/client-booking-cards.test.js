const assert = require('node:assert/strict');
const test = require('node:test');
const registerRoutes = require('./client-bookings');
const { publicImageUrl } = require('../images');

const cursor = value => ({ select() { return this; }, sort() { return this; }, skip() { return this; }, limit() { return this; }, async lean() { return value; } });

test('client booking cards batch current salon presentation by distinct IDs without changing orders or paging', async () => {
  let handler;
  const app = Object.fromEntries(['get', 'post', 'patch', 'delete'].map(method => [method, (path, ...handlers) => {
    if (method === 'get' && path === '/api/bookings') handler = handlers.at(-1);
  }]));
  const rows = [
    { id: 'B1', userId: 'u', salonId: 's', salonName: '预约时店名', status: 'completed', reviewed: true },
    { id: 'B2', userId: 'u', salonId: 's', status: 'accepted' },
    { id: 'B3', userId: 'u', salonId: 'deleted', status: 'canceled' },
    { id: 'legacy', userId: 'u', status: 'completed' },
  ];
  let salonReads = 0;
  let paging;
  registerRoutes(app, {
    Booking: { find(query) { assert.deepEqual(query, { userId: { $in: ['u'] } }); return cursor(rows); }, async countDocuments() { return 7; } },
    Salon: { find(query) { salonReads++; assert.deepEqual(query, { id: { $in: ['s', 'deleted'] } }); return cursor([{ id: 's', description: '首页简介', images: ['https://example.com/cover.jpg'] }]); } },
    publicImageUrl, normalizeBooking: value => ({ ...value }), normalizeUserId: value => value, userIdAliases: value => [value],
    normalizePagination: () => ({ page: 1, limit: 4, skip: 0 }), setPaginationHeaders(_res, pagination, total) { paging = { ...pagination, total }; },
    rateLimits: { booking: [] },
  });
  let body;
  await handler({ query: {}, clientUser: { id: 'u' } }, { json(value) { body = value; } });
  assert.equal(salonReads, 1);
  assert.deepEqual(paging, { page: 1, limit: 4, skip: 0, total: 7 });
  assert.equal(body[0].salonName, '预约时店名');
  assert.equal(body[0].salonDescription, '首页简介');
  assert.equal(body[1].salonImageUrl, 'https://example.com/cover.jpg');
  assert.equal(body[2].salonImageUrl, '');
  assert.equal(body[3].salonDescription, '');
  assert.deepEqual(body.map(({ salonImageUrl, salonDescription, ...booking }) => booking), rows);
});
