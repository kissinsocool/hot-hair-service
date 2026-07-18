const assert = require('node:assert/strict');
const test = require('node:test');
const {
  activeSessionQuery,
  acceptedBookingAtTimeQuery,
  buildGeoLocation,
  buildMerchantBookingScope,
  createSession,
  ensureSalonForMerchant,
  getNearbySalons,
  generateSlotsForStaffAndDate,
  getCoordinates,
  hashPassword,
  INPUT_LIMITS,
  isSalonClosedOnDate,
  logoutSession,
  normalizeClosedDates,
  normalizeServiceTags,
  normalizeAdLink,
  normalizePagination,
  normalizeRadiusKm,
  parseMerchantRescheduleTime,
  server,
  socketCanReceiveBooking,
  stripSensitiveSalonFields,
  verifyPassword,
} = require('./index');
const { isAllowedOrigin } = require('./src/config');
const { Booking, Salon, SlotOccupancy, StaffProfile } = require('./src/models');
const registerMerchantRoutes = require('./src/routes/merchant');

test('getCoordinates accepts common location shapes', () => {
  assert.deepEqual(getCoordinates('121.4737,31.2304'), { latitude: 31.2304, longitude: 121.4737 });
  assert.deepEqual(getCoordinates({ lat: '31.2304', lng: '121.4737' }), { latitude: 31.2304, longitude: 121.4737 });
  assert.deepEqual(getCoordinates({ coordinates: [121.4737, 31.2304] }), { latitude: 31.2304, longitude: 121.4737 });
  assert.equal(getCoordinates({ latitude: 91, longitude: 121.4737 }), null);
  assert.equal(getCoordinates({ latitude: 31.2304, longitude: -181 }), null);
});

test('health and readiness endpoints expose process and dependency state', async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const health = await fetch(`http://127.0.0.1:${address.port}/health`);
    const ready = await fetch(`http://127.0.0.1:${address.port}/ready`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, 'ok');
    assert.equal(ready.status, 503);
    assert.equal((await ready.json()).mongodb, 'down');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('buildGeoLocation stores MongoDB GeoJSON coordinates', () => {
  assert.deepEqual(buildGeoLocation({ latitude: 31.2304, longitude: 121.4737 }), {
    type: 'Point',
    coordinates: [121.4737, 31.2304],
  });
});

test('normalizeServiceTags trims, deduplicates and limits service tags', () => {
  assert.deepEqual(normalizeServiceTags([' 洗剪吹 ', '染发', '洗剪吹', '', '烫发', '护理', '发型设计', '头皮护理', '造型']), [
    '洗剪吹',
    '染发',
    '烫发',
    '护理',
    '发型设计',
    '头皮护理',
  ]);
  assert.deepEqual(normalizeServiceTags('洗剪吹，染发、头皮护理'), ['洗剪吹', '染发', '头皮护理']);
});

test('closed dates are normalized and matched by calendar date', () => {
  assert.deepEqual(
    normalizeClosedDates(['2026-07-18', ' 2026-07-17 ', '2026-07-18', 'invalid']),
    ['2026-07-17', '2026-07-18'],
  );
  assert.equal(isSalonClosedOnDate({ closedDates: ['2026-07-18'] }, '2026-07-18T10:00:00'), true);
  assert.equal(isSalonClosedOnDate({ closedDates: ['2026-07-18'] }, '2026-07-19T10:00:00'), false);
});

test('normalizeAdLink only accepts mini program page paths', () => {
  assert.equal(normalizeAdLink('/pages/ad/ad'), '/pages/ad/ad');
  assert.equal(normalizeAdLink('/pages/detail/detail?id=1'), '/pages/detail/detail?id=1');
  assert.equal(normalizeAdLink('https://example.com'), '');
  assert.equal(normalizeAdLink('/pages/../admin'), '');
});

test('normalizePagination applies defaults and caps page size', () => {
  assert.deepEqual(normalizePagination({}), { page: 1, limit: 50, skip: 0 });
  assert.deepEqual(normalizePagination({ page: '3', limit: '500' }), { page: 3, limit: 100, skip: 200 });
  assert.deepEqual(normalizePagination({ page: 'Infinity' }), { page: 1, limit: 50, skip: 0 });
});

test('async password hashing remains verifiable', async () => {
  const password = await hashPassword('correct horse battery staple');
  assert.equal(await verifyPassword('correct horse battery staple', {
    passwordSalt: password.salt,
    passwordHash: password.hash,
  }), true);
  assert.equal(await verifyPassword('wrong', {
    passwordSalt: password.salt,
    passwordHash: password.hash,
  }), false);
});

test('sessions have an expiry and authentication queries reject expired tokens', () => {
  const now = Date.parse('2030-01-01T00:00:00.000Z');
  const session = createSession(now);
  const query = activeSessionQuery('token-1', new Date(now));

  assert.equal(session.token.length, 64);
  assert.ok(session.expiresAt.getTime() > now);
  assert.equal(query.sessionToken, 'token-1');
  assert.equal(query.sessionExpiresAt.$gt.getTime(), now);
});

test('logout atomically clears the active session token', async () => {
  let update;
  const Model = {
    async updateOne(filter, changes) { update = { filter, changes }; },
  };

  await logoutSession(Model, { id: 'user-1' }, {
    headers: { authorization: 'Bearer token-1' },
  });

  assert.equal(update.filter.id, 'user-1');
  assert.equal(update.filter.sessionToken, 'token-1');
  assert.ok(update.filter.sessionExpiresAt.$gt instanceof Date);
  assert.deepEqual(update.changes, { $set: { sessionToken: '', sessionExpiresAt: null } });
});

test('input limits cap query amplification and user content', () => {
  assert.equal('candidateStaff' in INPUT_LIMITS, false);
  assert.equal(INPUT_LIMITS.note, 500);
  assert.equal(INPUT_LIMITS.services, 50);
});

test('no-preference booking can remain unassigned until merchant acceptance', async () => {
  const booking = new Booking({
    id: 'BK-unassigned',
    serviceId: 'service-1',
    startTime: new Date('2030-01-01T10:00:00.000Z'),
    isNoPreference: true,
    staffName: '无需指定',
  });

  await booking.validate();
  assert.equal(booking.staffId, '');
});

test('slot occupancies enforce one booking per staff and start time', () => {
  const uniqueSlotIndex = SlotOccupancy.schema.indexes().find(
    ([fields]) => fields.staffId === 1 && fields.startTime === 1,
  );

  assert.equal(uniqueSlotIndex?.[1]?.unique, true);
});

test('query indexes match geospatial and filtered booking access patterns', () => {
  const bookingIndexes = Booking.schema.indexes().map(([fields]) => fields);
  const salonIndexes = Salon.schema.indexes().map(([fields]) => fields);

  assert.ok(bookingIndexes.some(fields =>
    fields.userId === 1 && fields.status === 1 && fields.createdAt === -1));
  assert.ok(bookingIndexes.some(fields =>
    fields.salonId === 1 && fields.status === 1 && fields.createdAt === -1));
  assert.ok(salonIndexes.some(fields =>
    fields.geoLocation === '2dsphere' && fields.publishStatus === 1));
});

test('merchant active booking scope follows current salon staff ownership', () => {
  assert.deepEqual(buildMerchantBookingScope('1', ['tina']), {
    $or: [
      { staffId: { $in: ['tina'] }, status: { $in: ['pending', 'accepted'] } },
      { salonId: '1', staffId: '' },
      { salonId: '1', status: { $nin: ['pending', 'accepted'] } },
    ],
  });
});

test('normalizeRadiusKm applies defaults and bounds', () => {
  assert.equal(normalizeRadiusKm(undefined, 10, 50), 10);
  assert.equal(normalizeRadiusKm('5000', 10, 50), 50);
  assert.equal(normalizeRadiusKm('-1', 10, 50), 0.1);
});

test('nearby salon expansion performs one geospatial query', async () => {
  const originalFind = Salon.find;
  let queries = 0;
  Salon.find = () => {
    queries += 1;
    const chain = {
      select() { return chain; },
      limit() { return chain; },
      async lean() {
        return [
          { id: 'near', geoLocation: { type: 'Point', coordinates: [121.4738, 31.2305] } },
          { id: 'farther', geoLocation: { type: 'Point', coordinates: [121.6, 31.3] } },
        ];
      },
    };
    return chain;
  };

  try {
    const salons = await getNearbySalons({ latitude: 31.2304, longitude: 121.4737 }, 1, 10, 2, 50);
    assert.equal(queries, 1);
    assert.deepEqual(salons.map(salon => salon.id), ['near', 'farther']);
  } finally {
    Salon.find = originalFind;
  }
});

test('staff slots load daily bookings and unavailability with fixed query count', async () => {
  const originalSalonFindOne = Salon.findOne;
  const originalBookingFind = Booking.find;
  const originalStaffFindOne = StaffProfile.findOne;
  let bookingQueries = 0;
  let staffQueries = 0;

  Salon.findOne = () => ({ lean: async () => ({ openingHours: '10:00 - 11:00' }) });
  Booking.find = () => {
    bookingQueries += 1;
    return { select: () => ({ lean: async () => [{ startTime: new Date('2030-01-01T10:30:00') }] }) };
  };
  StaffProfile.findOne = () => {
    staffQueries += 1;
    return { select: () => ({ lean: async () => ({ unavailableSlots: ['2030-01-01 11:00'] }) }) };
  };

  try {
    const slots = await generateSlotsForStaffAndDate('staff-1', '2030-01-01');
    assert.equal(bookingQueries, 1);
    assert.equal(staffQueries, 1);
    assert.equal(slots.find(slot => slot.time === '10:30').reason, '已有订单');
    assert.equal(slots.find(slot => slot.time === '11:00').reason, '理发师缺勤');
  } finally {
    Salon.findOne = originalSalonFindOne;
    Booking.find = originalBookingFind;
    StaffProfile.findOne = originalStaffFindOne;
  }
});

test('acceptedBookingAtTimeQuery only blocks already accepted bookings', () => {
  const query = acceptedBookingAtTimeQuery('S1', '2026-06-21T03:30:00.000Z', 'BK1');

  assert.equal(query.staffId, 'S1');
  assert.equal(query.startTime.getTime(), Date.parse('2026-06-21T03:30:00.000Z'));
  assert.deepEqual(query.id, { $ne: 'BK1' });
  assert.equal(query.status, 'accepted');
});

test('merchant rescheduling only accepts future times for active bookings', () => {
  const now = Date.parse('2026-06-21T03:00:00.000Z');

  assert.equal(parseMerchantRescheduleTime('completed', '2030-01-01', now).status, 409);
  assert.equal(parseMerchantRescheduleTime('pending', 'invalid', now).status, 400);
  assert.equal(parseMerchantRescheduleTime('pending', '2030-01-01T10:15:00.000Z', now).status, 400);
  assert.equal(parseMerchantRescheduleTime('accepted', '2026-06-21T02:00:00.000Z', now).status, 409);
  assert.equal(
    parseMerchantRescheduleTime('accepted', '2026-06-21T04:00:00.000Z', now).value.getTime(),
    Date.parse('2026-06-21T04:00:00.000Z'),
  );
});

test('websocket booking subscriptions only receive their own user or salon events', () => {
  const booking = { userId: 'user-7', salonId: 'salon-3' };

  assert.equal(socketCanReceiveBooking({ role: 'client', userId: '7' }, booking), true);
  assert.equal(socketCanReceiveBooking({ role: 'client', userId: '8' }, booking), false);
  assert.equal(socketCanReceiveBooking({ role: 'merchant', salonId: 'salon-3' }, booking), true);
  assert.equal(socketCanReceiveBooking({ role: 'merchant', salonId: 'salon-4' }, booking), false);
  assert.equal(socketCanReceiveBooking({ role: 'admin' }, booking), true);
  assert.equal(socketCanReceiveBooking(null, booking), false);
});

test('isAllowedOrigin allows local Flutter web ports', () => {
  assert.equal(isAllowedOrigin('http://localhost:61234'), true);
  assert.equal(isAllowedOrigin('http://127.0.0.1:61234'), true);
  assert.equal(isAllowedOrigin('http://example.com'), false);
});

test('stripSensitiveSalonFields removes license fields from public salon payloads', () => {
  const payload = stripSensitiveSalonFields({
    id: '1',
    name: 'Hot Hair',
    licenseUrl: 'licenses/license.png',
    licenseStatus: 'pending',
    licenseRejectReason: 'bad image',
    licenseSubmittedAt: new Date(),
    licenseReviewedAt: new Date(),
    pendingContent: { name: 'unreviewed' },
    contentRejectReason: 'internal reason',
  });

  assert.deepEqual(payload, { id: '1', name: 'Hot Hair' });
});

test('admin merchant creation helper is wired into route context', () => {
  assert.equal(typeof ensureSalonForMerchant, 'function');
});

test('merchant review replies are scoped to the authenticated merchant salon', async () => {
  const routes = new Map();
  const app = {
    get() {},
    post() {},
    use() {},
    patch(path, handler) { routes.set(path, handler); },
  };
  let query;
  registerMerchantRoutes(app, {
    Booking: {
      findOne(value) {
        query = value;
        return null;
      },
    },
    INPUT_LIMITS: { reviewReply: 1000 },
    rateLimits: {
      login: [],
      booking: [],
      merchantBooking: [],
      upload: [],
    },
  });

  let status;
  await routes.get('/api/merchant/bookings/:id/review-reply')(
    {
      body: { reply: '谢谢您的评价' },
      params: { id: 'BK-1' },
      merchantUser: { salonId: 'salon-7' },
    },
    {
      status(value) { status = value; return this; },
      json() {},
    },
  );

  assert.deepEqual(query, { id: 'BK-1', salonId: 'salon-7' });
  assert.equal(status, 404);
});

test('booking cancellation atomically checks state and releases its slot in one transaction', async () => {
  const routes = new Map();
  const app = {
    get() {},
    post() {},
    use() {},
    patch(path, ...handlers) { routes.set(path, handlers.at(-1)); },
  };
  const session = { id: 'transaction-session' };
  let updateCall;
  let deleteCall;
  let transactionOptions;
  let ended = false;
  const current = { id: 'BK-1', userId: 'user-1', status: 'pending', startTime: new Date('2030-01-01') };
  const updated = { ...current, status: 'canceled' };

  registerMerchantRoutes(app, {
    Booking: {
      findOne() { return { session: async () => current }; },
      async findOneAndUpdate(...args) { updateCall = args; return updated; },
    },
    SlotOccupancy: {
      async deleteOne(...args) { deleteCall = args; },
    },
    mongoose: {
      async startSession() {
        return Object.assign(session, {
          async withTransaction(work, options) { transactionOptions = options; await work(); },
          async endSession() { ended = true; },
        });
      },
    },
    resolveRequestUser: async () => ({ userId: 'user-1' }),
    userIdAliases: id => [id],
    normalizeBooking: value => value,
    broadcastBookingEvent() {},
    USER_CANCEL_WINDOW_MS: 3 * 60 * 60 * 1000,
    rateLimits: { login: [], booking: [], merchantBooking: [], upload: [] },
  });

  let response;
  await routes.get('/api/bookings/:id/cancel')(
    { params: { id: 'BK-1' } },
    { json(value) { response = value; } },
  );

  assert.equal(updateCall[0].status, 'pending');
  assert.equal(updateCall[2].session, session);
  assert.deepEqual(deleteCall, [{ bookingId: 'BK-1' }, { session }]);
  assert.deepEqual(transactionOptions, {
    readConcern: { level: 'snapshot' },
    writeConcern: { w: 'majority' },
  });
  assert.equal(response.booking.status, 'canceled');
  assert.equal(ended, true);
});
