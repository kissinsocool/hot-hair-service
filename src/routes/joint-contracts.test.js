const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const registerClientBookings = require('./client-bookings');
const registerMerchant = require('./merchant');
const registerClient = require('./client');
const registerAdmin = require('./admin');
const booking = require('../services/booking');
const { Booking: BookingDocument } = require('../models');

function routesFor(register, ctx) {
  const routes = new Map();
  const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map(method => [method,
    (path, ...handlers) => routes.set(`${method}:${path}`, handlers.at(-1)),
  ]));
  register(app, ctx);
  return routes;
}
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const chain = value => ({ select() { return this; }, sort() { return this; }, skip() { return this; }, limit() { return this; }, async lean() { return value; } });
const limits = { booking: [], publicRead: [], login: [], upload: [], merchantBooking: [] };

function creationHarness(servicePricing = {}) {
  const saved = [];
  const messages = [];
  const session = { async withTransaction(work) { await work(); }, async endSession() {} };
  function Model(fields) {
    const doc = new BookingDocument(fields);
    doc.save = async () => { saved.push(doc.toObject()); };
    return doc;
  }
  Model.exists = async () => false;
  const ctx = {
    Booking: Model, crypto, rateLimits: limits, INPUT_LIMITS: { note: 500 },
    mongoose: { async startSession() { return session; } },
    Salon: {
      findOne() { return chain({ id: 'salon-1', name: 'Salon', publishStatus: 'online', openingHours: '09:00-20:00', staffIds: ['staff-1'], services: [{ id: 'service-1', name: 'Cut', priceFen: 8000, durationMinutes: 60, tagIds: ['wash_cut_blow'], ...servicePricing }] }); },
      async updateOne(_query, _update, options) { assert.equal(options.session, session); return { matchedCount: 1 }; },
    },
    BookingMessage: { async create(rows, options) { assert.equal(options.session, session); messages.push(...rows); return rows; } },
    normalizeUserId: id => id, userIdAliases: id => [id], normalizeBooking: doc => doc.toObject(),
    getUserPolicy: async () => ({ isBlacklisted: false }), parseOpeningHours: booking.parseOpeningHours,
    isSalonClosedOnDate: () => false, isSameDayBookingBlocked: () => false,
    broadcastBookingEvent() {}, AnalyticsEvent: { async updateOne() {} },
  };
  const handler = routesFor(registerClientBookings, ctx).get('post:/api/bookings');
  return { saved, messages, async create(extra = {}) {
    const res = response();
    await handler({ clientUser: { id: 'client-1', displayName: 'Client' }, body: {
      salonId: 'salon-1', staffId: '__no_preference__', serviceId: 'service-1',
      startTime: '2030-01-01T10:00:00', ...extra,
    } }, res);
    return res;
  } };
}

test('released client and k6 request bodies remain valid without expected prices', async () => {
  const h = creationHarness();
  const res = await h.create();
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.booking.payableAmountFen, 8000);
  assert.equal(h.messages.length, 1);
});

test('original 280 at 9折 books the saved selling price 252 without applying discount twice', async () => {
  const h = creationHarness({ priceFen: 25200, originalPriceFen: 28000, discountTenths: 90 });
  const res = await h.create();
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.booking.servicePriceFen, 25200);
  assert.equal(res.body.booking.payableAmountFen, 25200);
  const stale = await h.create({ expectedOriginalAmountFen: 28000, expectedPayableAmountFen: 28000 });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.body.quote.payableAmountFen, 25200);
});

test('price changes reject before creating an order or its message; explicit reconfirmation succeeds', async () => {
  const h = creationHarness();
  const stale = await h.create({ expectedOriginalAmountFen: 5000, expectedPayableAmountFen: 5000 });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.body.code, 'BOOKING_PRICE_CHANGED');
  assert.equal(stale.body.quote.payableAmountFen, 8000);
  assert.equal(h.saved.length, 0);
  assert.equal(h.messages.length, 0);
  const confirmed = await h.create({ expectedOriginalAmountFen: 8000, expectedPayableAmountFen: 8000 });
  assert.equal(confirmed.statusCode, 201);
  assert.equal(h.saved.length, 1);
  const invalid = await h.create({ expectedOriginalAmountFen: 8000 });
  assert.equal(invalid.statusCode, 400);
});

test('released booking requests charge the saved whole-yuan discount and reject stale fractional quotes', async () => {
  const h = creationHarness({ priceFen: 9000, originalPriceFen: 9950, discountTenths: 90 });
  const legacy = await h.create();
  assert.equal(legacy.statusCode, 201);
  assert.equal(legacy.body.booking.servicePriceFen, 9000);
  assert.equal(legacy.body.booking.payableAmountFen, 9000);
  const stale = await h.create({ expectedOriginalAmountFen: 8955, expectedPayableAmountFen: 8955 });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.body.quote.payableAmountFen, 9000);
  const confirmed = await h.create({ expectedOriginalAmountFen: 9000, expectedPayableAmountFen: 9000 });
  assert.equal(confirmed.statusCode, 201);
});

test('merchant reschedule slots use the owned booking snapshot and exclude its occupancy', async () => {
  let actual;
  let query;
  const routes = routesFor(registerMerchant, {
    rateLimits: limits, Salon: { findOne: () => chain({ id: 'salon-1', staffIds: ['staff-1'], acceptsSameDayBooking: false }) },
    Booking: { findOne: filter => { query = filter; return chain({ id: 'BK-1', staffId: 'staff-1', status: 'accepted', serviceDurationMinutes: 180 }); } },
    buildMerchantBookingScope: salonId => ({ salonId }),
    async generateSlotsForStaffAndDate(...args) { actual = args; return [{ time: '10:30', isAvailable: true }]; },
  });
  const res = response();
  await routes.get('get:/api/merchant/bookings/:id/slots')({ params: { id: 'BK-1' }, query: { date: '2030-01-01' }, merchantUser: { salonId: 'salon-1' } }, res);
  assert.deepEqual(query, { id: 'BK-1', salonId: 'salon-1' });
  assert.equal(actual[2], 180);
  assert.equal(actual[3].acceptsSameDayBooking, true);
  assert.equal(actual[4], 'BK-1');
  assert.equal(res.body[0].isAvailable, true);
});

test('merchant pagination range preserves cross-day pending orders and scopes summary counts', async () => {
  let query;
  const routes = routesFor(registerMerchant, {
    rateLimits: limits, Salon: { findOne: () => chain({ staffIds: ['staff-1'] }) },
    Booking: { async aggregate(pipeline) { query = pipeline[0].$match; return [{ _id: 'pending', count: 25 }]; } },
    buildMerchantBookingScope: salonId => ({ salonId }),
  });
  const req = { merchantUser: { salonId: 'salon-1' }, query: { fromDate: '2030-01-01', toDate: '2030-02-01', includePending: 'true', staffId: 'staff-1', statuses: 'accepted,completed' } };
  const res = response();
  await routes.get('get:/api/merchant/bookings/summary')(req, res);
  assert.deepEqual(query.$and[0], { salonId: 'salon-1' });
  assert.equal(query.$and[1].$or[0].startTime.$gte.toISOString(), '2029-12-31T16:00:00.000Z');
  assert.deepEqual(query.$and[1].$or[1], { status: 'pending' });
  assert.deepEqual(query.$and[2], { staffId: 'staff-1' });
  assert.equal(query.$and.length, 3, 'summary counts all statuses for the same tenant/date/staff');
  assert.equal(res.body.counts.pending, 25);
  req.query.toDate = 'invalid';
  const invalid = response();
  await routes.get('get:/api/merchant/bookings/summary')(req, invalid);
  assert.equal(invalid.statusCode, 400);
});

test('both review image consumers use the default TTL for every private image', async () => {
  const ttls = [];
  const privateImageUrl = (url, expires = 600) => { ttls.push(expires); return `signed:${url}`; };
  const data = [{ id: 'BK-1', review: { imageUrls: ['one', 'two'], pendingEdit: { imageUrls: ['three', 'four'] } } }];
  const ctx = { Booking: { find: () => chain(data), async countDocuments() { return 1; } }, privateImageUrl,
    normalizePagination: () => ({ skip: 0, limit: 20 }), setPaginationHeaders() {}, rateLimits: limits,
    userIdAliases: id => [id], normalizeBooking: doc => doc,
  };
  await routesFor(registerClient, ctx).get('get:/api/auth/reviews')({ clientUser: { id: 'client-1' }, query: {} }, response());
  await routesFor(registerAdmin, ctx).get('get:/api/admin/user-images')({ query: {} }, response());
  assert.deepEqual(ttls, [600, 600, 600, 600, 600, 600]);
});
