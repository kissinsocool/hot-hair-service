const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const test = require('node:test');
const {
  activeSessionQuery,
  acceptedBookingAtTimeQuery,
  buildGeoLocation,
  buildMerchantSalonPayload,
  buildPublicSalonDetail,
  buildStaffPayload,
  buildMerchantBookingScope,
  campaignPayload,
  couponPayload,
  couponDiscountForOrder,
  couponStatus,
  clearPublicSalonDetailCache,
  createClientUserWithSignupCoupons,
  createSession,
  ensureSalonForMerchant,
  getNearbySalons,
  generateSlotsForStaffAndDate,
  getApprovedReviewsByStaffIds,
  getCoordinates,
  hashPassword,
  hasReviewableContentChanges,
  INPUT_LIMITS,
  isSalonClosedOnDate,
  isSameDayBookingBlocked,
  logoutSession,
  normalizeBooking,
  normalizeMerchantBooking,
  normalizeClosedDates,
  normalizeServiceTags,
  normalizeAdLink,
  normalizePagination,
  normalizeRadiusKm,
  normalizeSalonTags,
  parseMerchantRescheduleTime,
  readFavoriteSalons,
  server,
  socketCanReceiveBooking,
  stripSensitiveSalonFields,
  verifyPassword,
  validateCampaignInput,
} = require('./index');
const { issueSignupCoupons } = require('./src/coupons');
const { isAllowedOrigin, resolveTrustProxyHops } = require('./src/config');
const { publicImageUrl } = require('./src/images');
const {
  Booking,
  ClientUser,
  CouponCampaign,
  FavoriteSalon,
  MerchantUser,
  Salon,
  SlotOccupancy,
  StaffProfile,
} = require('./src/models');
const registerAdminRoutes = require('./src/routes/admin');
const registerAuthEntryRoutes = require('./src/routes/auth-entry');
const registerClientBookingRoutes = require('./src/routes/client-bookings');
const registerClientRoutes = require('./src/routes/client');
const registerMerchantRoutes = require('./src/routes/merchant');
const registerPublicRoutes = require('./src/routes/public');
const bookingDomain = require('./src/services/booking');
const salonDomain = require('./src/services/salon');
const { bookingPatch, serviceForMigration } = require('./scripts/migrate-booking-domain');

test('public image URLs use the custom OSS domain', () => {
  assert.equal(
    publicImageUrl('https://hothairapp.oss-cn-beijing.aliyuncs.com/uploads/image.jpg'),
    'https://oss.hothaircc.cn/uploads/image.jpg',
  );
});

test('salon tags are trimmed, deduplicated and capped for homepage cards', () => {
  assert.deepEqual(
    normalizeSalonTags([' 人气店铺 ', '好评No.1', '人气店铺', '回头客No.1', '新客优选', '附近热门', '不应保留']),
    ['人气店铺', '好评No.1', '回头客No.1', '新客优选', '附近热门'],
  );

  const salon = new Salon({ id: 'tagged-salon', tags: ['人气店铺', '好评No.1'] });
  assert.deepEqual(salon.toObject().tags, ['人气店铺', '好评No.1']);
});

test('admin merchant updates persist selected tags on the real salon document', async () => {
  const routes = new Map();
  const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map(method => [
    method,
    (path, ...handlers) => routes.set(`${method}:${path}`, handlers.at(-1)),
  ]));
  const salon = new Salon({ id: 'salon-tags-route', tags: [] });
  const user = new MerchantUser({
    id: 'merchant-tags-route',
    username: 'tag-editor',
    displayName: '标签测试',
    salonId: salon.id,
    passwordHash: 'hash',
    passwordSalt: 'salt',
  });
  let salonSaved = false;
  salon.save = async () => { salonSaved = true; return salon; };
  user.save = async () => user;

  registerAdminRoutes(app, {
    rateLimits: { upload: [] },
    MerchantUser: { findOne: async () => user },
    Salon: { findOne: async () => salon },
    normalizeDeposit: value => Number(value),
    normalizeSalonTags,
    ensureSalonForMerchant: async () => salon,
    buildMerchantUserPayload: value => ({ id: value.id }),
    hashPassword: async () => ({ salt: 'salt', hash: 'hash' }),
    revokeSessionHash: async () => {},
    clearPublicSalonDetailCache: () => {},
  });

  const response = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return body; },
  };
  await routes.get('patch:/api/admin/merchants/:id')({
    params: { id: user.id },
    body: {
      username: user.username,
      displayName: user.displayName,
      salonId: salon.id,
      deposit: '100',
      tags: ['人气店铺', '好评No.1'],
    },
  }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(salonSaved, true);
  assert.deepEqual(salon.toObject().tags, ['人气店铺', '好评No.1']);
});

const collectRoutePaths = (register, context = {}) => {
  const paths = [];
  const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map(method => [
    method,
    path => paths.push(path),
  ]));
  app.use = () => {};
  register(app, {
    rateLimits: new Proxy({}, { get: () => [] }),
    ...context,
  });
  return paths;
};

test('route modules stay inside their trust boundaries', () => {
  const authEntry = collectRoutePaths(registerAuthEntryRoutes);
  const client = collectRoutePaths(registerClientRoutes);
  const clientBookings = collectRoutePaths(registerClientBookingRoutes);
  const merchant = collectRoutePaths(registerMerchantRoutes);
  const admin = collectRoutePaths(registerAdminRoutes);
  const publicPaths = collectRoutePaths(registerPublicRoutes);

  assert.deepEqual(authEntry.sort(), [
    '/api/admin/auth/login',
    '/api/auth/wechat/phone',
    '/api/merchant/auth/login',
  ]);
  assert.ok(client.every(path => /^\/api\/(auth|favorites|support-messages|uploads)/.test(path)));
  assert.ok(clientBookings.every(path => path.startsWith('/api/bookings')));
  assert.ok(merchant.every(path => path.startsWith('/api/merchant')));
  assert.ok(admin.every(path => path.startsWith('/api/admin')));
  assert.ok(publicPaths.every(path => /^\/api\/(ad|coupon-campaign|salons|staff)/.test(path)));
  assert.ok(publicPaths.some(path => path === '/api/coupon-campaign'));
  assert.ok(publicPaths.some(path => path === '/api/salons'));
  assert.ok(publicPaths.some(path => path === '/api/staff/:id/slots'));
});

test('booking domain stores fen, minutes and an explicit Shanghai timezone', () => {
  const service = salonDomain.serviceForStorage({
    id: 'service-1',
    name: '剪发',
    price: '¥88.50',
    duration: '45分钟',
  });
  assert.equal(service.priceFen, 8850);
  assert.equal(service.durationMinutes, 45);
  assert.equal(Object.hasOwn(service, 'price'), false);
  assert.equal(bookingDomain.slotStartTime('2030-01-02', '10:30'), '2030-01-02T10:30:00+08:00');
  assert.equal(
    bookingDomain.parseBookingTime('2030-01-02T10:30:00').toISOString(),
    '2030-01-02T02:30:00.000Z',
  );
  assert.equal(bookingDomain.localBookingDateKey('2030-01-02T16:30:00Z'), '2030-01-03');

  const normalized = bookingDomain.normalizeBookingPayload({
    status: 'completed',
    serviceBasePrice: 80,
    serviceDuration: '60分钟',
    payableAmountFen: 0,
  });
  assert.equal(normalized.servicePriceFen, 8000);
  assert.equal(normalized.serviceDurationMinutes, 60);
  assert.equal(normalized.payableAmountFen, 0);
  assert.equal(normalized.timeZone, 'Asia/Shanghai');
});

test('booking migration derives canonical fields without deleting legacy data', () => {
  assert.deepEqual(bookingPatch({
    servicePrice: '¥68',
    serviceDuration: '30分钟',
    staffExtraServiceFee: 20,
    totalPrice: 88,
    couponDiscountFen: 1000,
  }), {
    servicePriceFen: 6800,
    serviceDurationMinutes: 30,
    staffExtraServiceFeeFen: 2000,
    originalAmountFen: 8800,
    payableAmountFen: 7800,
    timeZone: 'Asia/Shanghai',
  });
  assert.deepEqual(serviceForMigration({
    id: 'service-legacy',
    name: '旧服务',
    price: '¥68',
    duration: '30分钟',
  }), {
    id: 'service-legacy',
    name: '旧服务',
    tags: [],
    priceFen: 6800,
    durationMinutes: 30,
    note: '',
    imageUrl: '',
    price: '¥68',
    duration: '30分钟',
  });
});

test('service, review, complaint and pending content use child schemas instead of Mixed', async () => {
  assert.ok(Salon.schema.path('services').schema);
  assert.ok(Salon.schema.path('pendingContent').schema);
  assert.ok(Booking.schema.path('review').schema);
  assert.ok(Booking.schema.path('complaint').schema);
  assert.equal(Salon.schema.path('services').schema.path('priceFen').instance, 'Number');
  assert.equal(Booking.schema.path('serviceDurationMinutes').instance, 'Number');

  const invalid = new Booking({
    id: 'booking-invalid-domain',
    serviceId: 'service-1',
    servicePriceFen: 10.5,
    serviceDurationMinutes: 30.5,
    startTime: new Date('2030-01-02T02:30:00Z'),
  });
  await assert.rejects(invalid.validate(), (error) => {
    assert.ok(error.errors.servicePriceFen);
    assert.ok(error.errors.serviceDurationMinutes);
    return true;
  });
});

test('getCoordinates accepts common location shapes', () => {
  assert.deepEqual(getCoordinates('121.4737,31.2304'), { latitude: 31.2304, longitude: 121.4737 });
  assert.deepEqual(getCoordinates({ lat: '31.2304', lng: '121.4737' }), { latitude: 31.2304, longitude: 121.4737 });
  assert.deepEqual(getCoordinates({ coordinates: [121.4737, 31.2304] }), { latitude: 31.2304, longitude: 121.4737 });
  assert.equal(getCoordinates({ latitude: 91, longitude: 121.4737 }), null);
  assert.equal(getCoordinates({ latitude: 31.2304, longitude: -181 }), null);
});

test('public salon details share a bounded short-lived cache entry', async () => {
  clearPublicSalonDetailCache();
  let builds = 0;
  const salon = { id: 'salon-cache', updatedAt: new Date('2030-01-01T00:00:00Z') };
  const builder = async () => ({ build: ++builds });

  const [first, second] = await Promise.all([
    buildPublicSalonDetail(salon, builder, 1000),
    buildPublicSalonDetail(salon, builder, 1000),
  ]);
  assert.deepEqual(first, { build: 1 });
  assert.deepEqual(second, { build: 1 });
  assert.equal(builds, 1);

  assert.deepEqual(await buildPublicSalonDetail(salon, builder, 16_001), { build: 2 });
  clearPublicSalonDetailCache();
});

test('public staff payloads use supplied booking reviews and ignore legacy profile reviews', () => {
  const reviews = Array.from({ length: 205 }, (_, index) => ({
    id: `review-${index}`,
    rating: 5,
    reviewStatus: 'approved',
  }));
  const payload = buildStaffPayload({ id: 'staff-1', reviews: [{ rating: 1 }] }, reviews);
  assert.equal(payload.reviews.length, 50);
  assert.equal(payload.rating, 5);
});

test('public reviews include the current approved customer avatar', async () => {
  const originalBookingFind = Booking.find;
  const originalClientUserFind = ClientUser.find;
  const bookingCursor = {
    select() { return bookingCursor; },
    sort() { return bookingCursor; },
    limit() { return bookingCursor; },
    async lean() {
      return [{
        id: 'booking-1',
        userId: 'user-customer-1',
        staffId: 'staff-1',
        review: { id: 'review-1', rating: 5, reviewStatus: 'approved' },
      }];
    },
  };
  const userCursor = {
    select() { return userCursor; },
    async lean() {
      return [{
        id: 'customer-1',
        avatarUrl: 'https://hothairapp.oss-cn-beijing.aliyuncs.com/uploads/avatar.jpg',
      }];
    },
  };
  Booking.find = () => bookingCursor;
  ClientUser.find = () => userCursor;

  try {
    const reviews = await getApprovedReviewsByStaffIds(['staff-1']);
    assert.equal(reviews[0].avatarUrl, 'https://oss.hothaircc.cn/uploads/avatar.jpg');
  } finally {
    Booking.find = originalBookingFind;
    ClientUser.find = originalClientUserFind;
  }
});

test('health, readiness and centralized auth boundaries work without database access', async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const [health, ready, client, merchant, admin] = await Promise.all([
      fetch(`${baseUrl}/health`),
      fetch(`${baseUrl}/ready`),
      fetch(`${baseUrl}/api/auth/me`),
      fetch(`${baseUrl}/api/merchant/auth/me`),
      fetch(`${baseUrl}/api/admin/auth/me`),
    ]);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, 'ok');
    assert.equal(ready.status, 503);
    assert.equal((await ready.json()).mongodb, 'down');
    assert.equal(client.status, 401);
    assert.equal(merchant.status, 401);
    assert.equal(admin.status, 401);

    const emptyLogin = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' };
    const [wechatLogin, merchantLogin, adminLogin] = await Promise.all([
      fetch(`${baseUrl}/api/auth/wechat/phone`, emptyLogin),
      fetch(`${baseUrl}/api/merchant/auth/login`, emptyLogin),
      fetch(`${baseUrl}/api/admin/auth/login`, emptyLogin),
    ]);
    assert.equal(wechatLogin.status, 400);
    assert.equal(merchantLogin.status, 400);
    assert.equal(adminLogin.status, 400);
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

test('same-day booking policy blocks only today', () => {
  const now = new Date(2026, 6, 20, 9);
  const salon = { acceptsSameDayBooking: false };

  assert.equal(isSameDayBookingBlocked(salon, '2026-07-20T18:00:00', now), true);
  assert.equal(isSameDayBookingBlocked(salon, '2026-07-21T10:00:00', now), false);
  assert.equal(isSameDayBookingBlocked({ acceptsSameDayBooking: true }, '2026-07-20T18:00:00', now), false);
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

test('coupon campaigns use activity dates and validate both discount tiers', () => {
  const parsed = validateCampaignInput({
    enabled: true,
    promotionImageUrl: 'https://example.com/new-user-gift.jpg',
    registrationStartAt: '2030-01-01T00:00:00.000Z',
    registrationEndAt: '2030-02-01T00:00:00.000Z',
    coupons: [
      {
        key: '99-20',
        minimumSpendFen: 9900,
        discountFen: 2000,
        title: '满99减20',
      },
      {
        key: '199-30',
        minimumSpendFen: 19900,
        discountFen: 3000,
        title: '满199减30',
      },
    ],
  });
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.value.promotionImageUrl, 'https://example.com/new-user-gift.jpg');
  assert.equal(parsed.value.coupons.length, 2);
  assert.equal(Object.hasOwn(parsed.value, 'validFrom'), false);
  assert.equal(Object.hasOwn(parsed.value, 'validUntil'), false);
  const payload = campaignPayload({
    ...parsed.value,
    validFrom: new Date(),
    validUntil: new Date(),
  });
  assert.equal(Object.hasOwn(payload, 'validFrom'), false);
  assert.equal(Object.hasOwn(payload, 'validUntil'), false);

  const now = new Date('2030-01-15T00:00:00.000Z');
  const coupon = {
    id: 'coupon-1',
    validFrom: parsed.value.registrationStartAt,
    validUntil: parsed.value.registrationEndAt,
  };
  assert.equal(couponStatus(coupon, now), 'unclaimed');
  assert.equal(couponStatus({ ...coupon, claimedAt: now }, now), 'available');
  assert.equal(
    couponStatus({ ...coupon, claimedAt: now, reservedBookingId: 'BK-1' }, now),
    'reserved',
  );
  assert.equal(couponStatus({ ...coupon, claimedAt: now, redeemedAt: now }, now), 'redeemed');
  assert.equal(
    couponPayload({ ...coupon, claimedAt: now }, now).validUntil,
    parsed.value.registrationEndAt,
  );
  assert.equal(
    couponDiscountForOrder(9899, { minimumSpendFen: 9900, discountFen: 2000 }),
    null,
  );
  assert.equal(
    couponDiscountForOrder(9900, { minimumSpendFen: 9900, discountFen: 2000 }),
    2000,
  );
});

test('signup coupon validity matches the campaign', async () => {
  const registrationStartAt = new Date('2030-01-01T00:00:00.000Z');
  const registrationEndAt = new Date('2030-03-01T00:00:00.000Z');
  let createdCoupons;
  let createOptions;
  await issueSignupCoupons({
    CouponCampaign: {
      findOne() {
        return {
          session() {
            return {
              registrationStartAt,
              registrationEndAt,
              coupons: [{
                key: '99-20',
                minimumSpendFen: 9900,
                discountFen: 2000,
                title: '满99减20',
                description: '',
              }],
            };
          },
        };
      },
    },
    UserCoupon: {
      create(coupons, options) {
        createdCoupons = coupons;
        createOptions = options;
        return coupons;
      },
    },
    crypto: { randomUUID: () => 'coupon-1' },
    userId: 'user-1',
  });

  assert.equal(createdCoupons[0].validFrom, registrationStartAt);
  assert.equal(createdCoupons[0].validUntil, registrationEndAt);
  assert.equal(createdCoupons[0].claimedAt, undefined);
  assert.equal(createOptions.ordered, true);
});

test('new-user gift stays hidden until the home promotion claims it', async () => {
  const routes = new Map();
  const app = {
    get(path, ...handlers) { routes.set(`GET ${path}`, handlers.at(-1)); },
    post(path, ...handlers) { routes.set(`POST ${path}`, handlers.at(-1)); },
    put() {},
    patch() {},
    delete() {},
    use() {},
  };
  let couponUpdate;
  registerClientRoutes(app, {
    CouponCampaign: {
      findOne() {
        return {
          select() { return this; },
          async lean() {
            return {
              _id: 'campaign-1',
              promotionImageUrl: 'https://example.com/new-user-gift.jpg',
            };
          },
        };
      },
      async exists() { return { _id: 'campaign-1' }; },
    },
    UserCoupon: {
      async exists() { return { _id: 'coupon-1' }; },
      async updateMany(...args) {
        couponUpdate = args;
        return { modifiedCount: 2 };
      },
      find() {
        return {
          sort() { return this; },
          async lean() {
            return [
              { id: 'coupon-1', claimedAt: new Date() },
              { id: 'coupon-2', claimedAt: new Date() },
            ];
          },
        };
      },
    },
    userIdAliases: id => [id],
    couponPayload: value => value,
    publicImageUrl,
    requireClientAuth() {},
    rateLimits: { upload: [], login: [], booking: [] },
  });

  let campaignPayload;
  await routes.get('GET /api/auth/coupon-campaign')(
    { clientUser: { id: 'user-1' } },
    { json(value) { campaignPayload = value; } },
  );
  assert.deepEqual(campaignPayload, {
    enabled: true,
    promotionImageUrl: 'https://example.com/new-user-gift.jpg',
  });

  let claimPayload;
  await routes.get('POST /api/auth/coupon-campaign/claim')(
    { clientUser: { id: 'user-1' } },
    {
      status() { return this; },
      json(value) { claimPayload = value; },
    },
  );
  assert.equal(couponUpdate[0].claimedAt.$exists, false);
  assert.equal(couponUpdate[1].$set.claimedAt instanceof Date, true);
  assert.equal(claimPayload.coupons.length, 2);
});

test('public coupon campaign exposes only the active promotion image', async () => {
  const routes = new Map();
  const app = {
    get(path, ...handlers) { routes.set(path, handlers.at(-1)); },
    post() {},
    put() {},
    patch() {},
    delete() {},
    use() {},
  };
  registerPublicRoutes(app, {
    CouponCampaign: {
      findOne() {
        return {
          select() { return this; },
          async lean() {
            return { promotionImageUrl: 'https://example.com/new-user-gift.jpg' };
          },
        };
      },
    },
    publicImageUrl,
    rateLimits: { publicRead: [] },
  });

  let payload;
  await routes.get('/api/coupon-campaign')(
    {},
    {
      set() {},
      json(value) { payload = value; },
    },
  );
  assert.deepEqual(payload, {
    enabled: true,
    promotionImageUrl: 'https://example.com/new-user-gift.jpg',
  });
});

test('signup transaction saves a client with its MongoDB session', async () => {
  const originalStartSession = mongoose.startSession;
  const originalClientSave = ClientUser.prototype.save;
  const originalCampaignFindOne = CouponCampaign.findOne;
  const session = {
    async withTransaction(work) { await work(); },
    async endSession() {},
  };
  let saveOptions;
  mongoose.startSession = async () => session;
  ClientUser.prototype.save = async function save(options) {
    saveOptions = options;
    return this;
  };
  CouponCampaign.findOne = () => ({ session: async () => null });

  try {
    const user = await createClientUserWithSignupCoupons({ id: 'user-1' });
    assert.equal(user.id, 'user-1');
    assert.equal(saveOptions.session, session);
  } finally {
    mongoose.startSession = originalStartSession;
    ClientUser.prototype.save = originalClientSave;
    CouponCampaign.findOne = originalCampaignFindOne;
  }
});

test('support messages are validated, trimmed and stored with the current user', async () => {
  const routes = new Map();
  const app = {
    get() {},
    patch() {},
    put() {},
    delete() {},
    post(path, ...handlers) { routes.set(path, handlers.at(-1)); },
  };
  let saved;
  registerClientRoutes(app, {
    SupportMessage: {
      async create(value) {
        saved = value;
        return value;
      },
    },
    normalizeUserId: value => value.replace(/^user-/, ''),
    requireClientAuth() {},
    crypto: { randomUUID: () => 'message-1' },
    rateLimits: {
      support: [],
      upload: [],
      login: [],
    },
  });

  let status;
  let payload;
  await routes.get('/api/support-messages')(
    {
      clientUser: { id: 'user-1', displayName: '测试用户' },
      body: { problem: '  被强迫充值  ', contact: ' 13800138000 ' },
    },
    {
      status(value) { status = value; return this; },
      json(value) { payload = value; },
    },
  );

  assert.equal(status, 201);
  assert.deepEqual(saved, {
    id: 'support-message-1',
    userId: '1',
    userName: '测试用户',
    problem: '被强迫充值',
    contact: '13800138000',
  });
  assert.deepEqual(payload, { id: 'support-message-1' });
});

test('client authentication exposes only the WeChat phone login entry', () => {
  const routes = new Map();
  const app = {
    get(path) { routes.set(`GET ${path}`, true); },
    patch(path) { routes.set(`PATCH ${path}`, true); },
    post(path) { routes.set(`POST ${path}`, true); },
    put(path) { routes.set(`PUT ${path}`, true); },
    delete(path) { routes.set(`DELETE ${path}`, true); },
  };
  registerClientRoutes(app, {
    requireClientAuth() {},
    rateLimits: {
      support: [],
      upload: [],
      login: [],
      booking: [],
    },
  });
  registerAuthEntryRoutes(app, {
    rateLimits: { login: [] },
  });

  assert.equal(routes.has('POST /api/auth/wechat/phone'), true);
  assert.equal(routes.has('POST /api/auth/sms/request'), false);
  assert.equal(routes.has('POST /api/auth/sms/verify'), false);
  assert.equal(routes.has('POST /api/auth/register'), false);
  assert.equal(routes.has('POST /api/auth/login'), false);
  assert.equal(ClientUser.schema.path('passwordHash'), undefined);
  assert.equal(ClientUser.schema.path('passwordSalt'), undefined);
  assert.equal(ClientUser.schema.path('authProvider').isRequired, true);
});

test('client profile rejects attempts to change the WeChat-bound phone', async () => {
  const routes = new Map();
  const app = {
    get() {},
    post() {},
    put() {},
    delete() {},
    patch(path, ...handlers) { routes.set(path, handlers.at(-1)); },
  };
  let databaseRead = false;
  registerClientRoutes(app, {
    ClientUser: {
      async findOne() { databaseRead = true; },
    },
    requireClientAuth() {},
    rateLimits: { support: [], upload: [], login: [], booking: [] },
  });

  let status;
  let payload;
  await routes.get('/api/auth/profile')(
    {
      clientUser: { id: 'user-1', account: '13800138000', phone: '13800138000' },
      body: { displayName: '测试用户', phone: '13900139000' },
    },
    {
      status(value) { status = value; return this; },
      json(value) { payload = value; },
    },
  );

  assert.equal(status, 400);
  assert.equal(payload.message, '手机号只能通过微信授权绑定，不能在资料中修改');
  assert.equal(databaseRead, false);
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
  const legacySalt = 'legacy-salt';
  assert.equal(await verifyPassword('legacy-password', {
    passwordSalt: legacySalt,
    passwordHash: crypto.createHash('sha256').update(`${legacySalt}:legacy-password`).digest('hex'),
  }), false);
});

test('sessions have an expiry and authentication queries reject expired tokens', () => {
  const now = Date.parse('2030-01-01T00:00:00.000Z');
  const session = createSession(now);
  const query = activeSessionQuery('token-1', new Date(now));

  assert.equal(session.token.length, 64);
  assert.equal(session.tokenHash, crypto.createHash('sha256').update(session.token).digest('hex'));
  assert.ok(session.expiresAt.getTime() > now);
  assert.equal(query.sessionTokenHash, crypto.createHash('sha256').update('token-1').digest('hex'));
  assert.equal(query.sessionExpiresAt.$gt.getTime(), now);
  assert.equal(ClientUser.schema.path('sessionToken'), undefined);
  assert.ok(ClientUser.schema.path('sessionTokenHash'));
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
  assert.equal(update.filter.sessionTokenHash, crypto.createHash('sha256').update('token-1').digest('hex'));
  assert.ok(update.filter.sessionExpiresAt.$gt instanceof Date);
  assert.deepEqual(update.changes, { $set: { sessionTokenHash: '', sessionExpiresAt: null } });
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
  assert.ok(bookingIndexes.some(fields =>
    fields.salonId === 1 && fields.startTime === 1 && fields.status === 1));
  assert.ok(bookingIndexes.some(fields =>
    fields.staffId === 1 && fields['review.reviewStatus'] === 1 && fields.updatedAt === -1));
  assert.ok(salonIndexes.some(fields =>
    fields.geoLocation === '2dsphere' && fields.publishStatus === 1));
});

test('merchant booking day range defaults to today and accepts an explicit date', () => {
  const today = registerMerchantRoutes.bookingDayRange(undefined, new Date(2030, 0, 2, 15, 30));
  assert.deepEqual(today, {
    start: new Date(2030, 0, 2),
    end: new Date(2030, 0, 3),
  });
  assert.deepEqual(registerMerchantRoutes.bookingDayRange('2030-02-03'), {
    start: new Date(2030, 1, 3),
    end: new Date(2030, 1, 4),
  });
  assert.equal(registerMerchantRoutes.bookingDayRange('03/02/2030'), null);
  assert.equal(registerMerchantRoutes.bookingDayRange('2030-02-30'), null);
});

test('booking IDs are eight numeric digits', () => {
  assert.equal(registerMerchantRoutes.generateBookingId(() => 0), '00000000');
  assert.equal(registerMerchantRoutes.generateBookingId(() => 99999999), '99999999');
});

test('merchant booking list does not hide future orders when no date is requested', async () => {
  const routes = new Map();
  const app = {
    get(path, ...handlers) { routes.set(path, handlers.at(-1)); },
    post() {},
    patch() {},
    delete() {},
    use() {},
  };
  let query;
  const emptyQuery = {
    select() { return this; },
    sort() { return this; },
    skip() { return this; },
    limit() { return this; },
    async lean() { return []; },
  };
  registerMerchantRoutes(app, {
    Salon: {
      findOne() {
        return { select() { return this; }, async lean() { return { staffIds: ['staff-1'] }; } };
      },
    },
    Booking: {
      find(value) { query = value; return emptyQuery; },
      async countDocuments() { return 0; },
    },
    buildMerchantBookingScope,
    normalizeMerchantBooking: value => value,
    normalizePagination: () => ({ page: 1, limit: 50, skip: 0 }),
    setPaginationHeaders() {},
    rateLimits: { login: [], booking: [], merchantBooking: [], publicRead: [], upload: [] },
  });

  await routes.get('/api/merchant/bookings')(
    { query: {}, merchantUser: { salonId: 'salon-1' } },
    { json() {} },
  );

  assert.equal(JSON.stringify(query).includes('startTime'), false);
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

test('favorites store references and read current salon data', async () => {
  const originalFavoriteFind = FavoriteSalon.find;
  const originalSalonFind = Salon.find;
  const originalStaffFind = StaffProfile.find;
  let salonQuery;
  FavoriteSalon.find = () => {
    const chain = {
      select() { return chain; },
      sort() { return chain; },
      async lean() { return [{ salonId: 'salon-1' }]; },
    };
    return chain;
  };
  Salon.find = async (query) => {
    salonQuery = query;
    return [new Salon({ id: 'salon-1', name: '最新店名', staffIds: [], publishStatus: 'online' })];
  };
  StaffProfile.find = () => ({ lean: async () => [] });

  try {
    const favorites = await readFavoriteSalons('user-1');
    assert.equal(FavoriteSalon.schema.path('salon'), undefined);
    assert.deepEqual(salonQuery, { id: { $in: ['salon-1'] }, publishStatus: 'online' });
    assert.equal(favorites[0].name, '最新店名');
  } finally {
    FavoriteSalon.find = originalFavoriteFind;
    Salon.find = originalSalonFind;
    StaffProfile.find = originalStaffFind;
  }
});

test('favorite writes are idempotent upserts and deletes', async () => {
  const routes = new Map();
  const app = {
    get() {},
    post() {},
    patch() {},
    put(path, handler) { routes.set(`PUT ${path}`, handler); },
    delete(path, handler) { routes.set(`DELETE ${path}`, handler); },
  };
  let updateCall;
  let deleteCall;
  registerClientRoutes(app, {
    FavoriteSalon: {
      async updateOne(...args) { updateCall = args; },
      async deleteMany(query) { deleteCall = query; },
    },
    normalizeUserId: value => value,
    async readFavoriteSalons() { return []; },
    userIdAliases: userId => [userId, 'legacy-user-1'],
    rateLimits: { support: [], upload: [], booking: [] },
  });
  const response = { json() {}, status() { return this; } };
  const request = { clientUser: { id: 'user-1' }, params: { id: 'salon-1' } };

  await routes.get('PUT /api/favorites/:id')(request, response);
  await routes.get('PUT /api/favorites/:id')(request, response);
  await routes.get('DELETE /api/favorites/:id')(request, response);

  assert.deepEqual(updateCall, [
    { userId: 'user-1', salonId: 'salon-1' },
    { $setOnInsert: { userId: 'user-1', salonId: 'salon-1' } },
    { upsert: true },
  ]);
  assert.deepEqual(deleteCall, {
    userId: { $in: ['user-1', 'legacy-user-1'] },
    salonId: 'salon-1',
  });
});

test('client booking reads require authentication and ignore claimed user ids', async () => {
  const routes = new Map();
  const app = {
    get(path, ...handlers) { routes.set(`GET ${path}`, handlers.at(-1)); },
    post() {},
    patch() {},
    delete() {},
    use() {},
  };
  let bookingQuery;
  const cursor = {
    select() { return this; },
    sort() { return this; },
    skip() { return this; },
    limit() { return this; },
    async lean() { return []; },
  };
  registerClientBookingRoutes(app, {
    Booking: {
      find(query) { bookingQuery = query; return cursor; },
      async countDocuments() { return 0; },
    },
    normalizeUserId: value => value,
    userIdAliases: value => [value, `legacy-${value}`],
    normalizePagination: () => ({ page: 1, limit: 20, skip: 0 }),
    setPaginationHeaders() {},
    normalizeBooking: value => value,
    rateLimits: { login: [], booking: [], merchantBooking: [], publicRead: [], upload: [] },
  });

  await routes.get('GET /api/bookings')(
    {
      clientUser: { id: 'owner-1' },
      query: { userId: 'victim-1', status: 'pending' },
    },
    { json() {} },
  );

  assert.deepEqual(bookingQuery, {
    userId: { $in: ['owner-1', 'legacy-owner-1'] },
    status: 'pending',
  });
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

test('isAllowedOrigin only allows the production frontend', () => {
  assert.equal(isAllowedOrigin('http://localhost:61234'), false);
  assert.equal(isAllowedOrigin('http://127.0.0.1:61234'), false);
  assert.equal(isAllowedOrigin('https://oss.hothaircc.cn'), true);
  assert.equal(isAllowedOrigin('http://oss.hothair.top'), false);
  assert.equal(isAllowedOrigin('http://example.com'), false);
});

test('production trusts one proxy hop by default while explicit topology wins', () => {
  assert.equal(resolveTrustProxyHops(undefined, 'production'), 1);
  assert.equal(resolveTrustProxyHops(undefined, 'development'), 0);
  assert.equal(resolveTrustProxyHops('2', 'production'), 2);
  assert.equal(resolveTrustProxyHops('invalid', 'production'), 1);
});

test('merchant salon payload merges pending content from a real Mongoose document', async () => {
  const originalSalonFindOne = Salon.findOne;
  const originalStaffFind = StaffProfile.find;
  const salon = new Salon({
    id: 'salon-pending',
    name: '已发布店名',
    staffIds: [],
    services: [],
    pendingContent: {
      name: '待审核店名',
      fullDescription: '待审核详情',
    },
  });
  Salon.findOne = async () => salon;
  StaffProfile.find = () => ({ lean: async () => [] });

  try {
    const payload = await buildMerchantSalonPayload(salon.id);
    assert.equal(payload.name, '待审核店名');
    assert.equal(payload.fullDescription, '待审核详情');
    assert.equal(Object.hasOwn(payload, '$__parent'), false);
    assert.equal(Object.hasOwn(payload, '_doc'), false);
  } finally {
    Salon.findOne = originalSalonFindOne;
    StaffProfile.find = originalStaffFind;
  }
});

test('stripSensitiveSalonFields removes license fields from public salon payloads', () => {
  const payload = stripSensitiveSalonFields({
    id: '1',
    name: 'Hot Hair',
    licenseUrl: 'licenses/license.png',
    legalPersonIdFrontUrl: 'licenses/legal-person-id-front.png',
    legalPersonIdBackUrl: 'licenses/legal-person-id-back.png',
    addressProofUrl: 'licenses/address-proof.png',
    licenseStatus: 'pending',
    licenseRejectReason: 'bad image',
    licenseSubmittedAt: new Date(),
    licenseReviewedAt: new Date(),
    pendingContent: { name: 'unreviewed' },
    contentRejectReason: 'internal reason',
  });

  assert.deepEqual(payload, { id: '1', name: 'Hot Hair' });
});

test('content review only covers merchant text and uploaded images', () => {
  const current = {
    name: '店铺',
    description: '介绍',
    fullDescription: '详情',
    promoImages: ['cover.jpg'],
    services: [{ id: 'S1', name: '剪发', note: '备注', imageUrl: 'service.jpg' }],
    staff: [{ id: 'P1', name: '理发师', bio: '简介', imageUrl: 'staff.jpg' }],
  };

  assert.equal(hasReviewableContentChanges(current, {
    phone: '13800000000',
    openingHours: '09:00 - 21:00',
    closedDates: ['2026-07-20'],
    services: [{ id: 'S1', price: '¥800', duration: '60分钟', tags: ['剪发'] }],
    staff: [{ id: 'P1', role: '店长', experience: '10年', extraServiceFee: 200 }],
  }), false);
  assert.equal(hasReviewableContentChanges(current, { address: '新地址' }), true);
  assert.equal(hasReviewableContentChanges(current, { description: '新介绍' }), true);
  assert.equal(hasReviewableContentChanges(current, {
    services: [{ id: 'S1', note: '新备注' }],
  }), true);
  assert.equal(hasReviewableContentChanges(current, { promoImages: ['new-cover.jpg'] }), true);
});

test('merchant qualification submission stores all required direct-upload documents', async () => {
  const routes = new Map();
  const app = {
    get() {},
    post() {},
    delete() {},
    use() {},
    patch(path, ...handlers) { routes.set(path, handlers.at(-1)); },
  };
  const salon = {
    id: 'salon-1',
    async save() {},
  };
  registerMerchantRoutes(app, {
    Salon: { async findOne() { return salon; } },
    async verifyMerchantQualificationObjects() {},
    privateImageUrl: value => `private:${value}`,
    rateLimits: { login: [], booking: [], merchantBooking: [], publicRead: [], upload: [] },
  });

  let response;
  await routes.get('/api/merchant/qualification')(
    {
      merchantUser: { id: 'merchant-1', salonId: 'salon-1' },
      body: {
        licenseUrl: 'licenses/merchant/license.png',
        legalPersonIdFrontUrl: 'licenses/merchant/legal-person-id-front.png',
        legalPersonIdBackUrl: 'licenses/merchant/legal-person-id-back.png',
        addressProofUrl: 'licenses/merchant/address-proof.png',
      },
    },
    { status() { return this; }, json(value) { response = value; } },
  );

  assert.equal(salon.licenseUrl, 'licenses/merchant/license.png');
  assert.equal(salon.legalPersonIdFrontUrl, 'licenses/merchant/legal-person-id-front.png');
  assert.equal(salon.legalPersonIdBackUrl, 'licenses/merchant/legal-person-id-back.png');
  assert.equal(salon.addressProofUrl, 'licenses/merchant/address-proof.png');
  assert.equal(salon.licenseStatus, 'pending');
  assert.equal(response.legalPersonIdFrontUrl, 'private:licenses/merchant/legal-person-id-front.png');
  assert.equal(response.legalPersonIdBackUrl, 'private:licenses/merchant/legal-person-id-back.png');
  assert.equal(response.addressProofUrl, 'private:licenses/merchant/address-proof.png');
});

test('merchant upload signing is scoped to the authenticated merchant', async () => {
  const routes = new Map();
  const app = {
    get() {},
    patch() {},
    delete() {},
    use() {},
    post(path, ...handlers) { routes.set(path, handlers.at(-1)); },
  };
  let signedRequest;
  registerMerchantRoutes(app, {
    createMerchantUploadPolicies(request) {
      signedRequest = request;
      return [{ objectName: 'uploads/merchant/image.jpg' }];
    },
    rateLimits: { login: [], booking: [], merchantBooking: [], publicRead: [], upload: [] },
  });

  let response;
  await routes.get('/api/merchant/uploads/sign')(
    {
      merchantUser: { id: 'merchant-1' },
      body: { type: 'public', files: [{ fileName: 'image.jpg', contentType: 'image/jpeg', size: 10 }] },
    },
    { status() { return this; }, json(value) { response = value; } },
  );

  assert.equal(signedRequest.userId, 'merchant-1');
  assert.equal(signedRequest.type, 'public');
  assert.deepEqual(response, { uploads: [{ objectName: 'uploads/merchant/image.jpg' }] });
});

test('merchant qualification accepts only verified direct-upload objects', async () => {
  const routes = new Map();
  const app = {
    get() {},
    post() {},
    delete() {},
    use() {},
    patch(path, ...handlers) { routes.set(path, handlers.at(-1)); },
  };
  const salon = {
    id: 'salon-1',
    licenseUrl: 'licenses/old-license.png',
    legalPersonIdFrontUrl: 'licenses/id-front.png',
    legalPersonIdBackUrl: 'licenses/id-back.png',
    addressProofUrl: 'licenses/address.png',
    async save() {},
  };
  let verified;
  registerMerchantRoutes(app, {
    Salon: { async findOne() { return salon; } },
    async verifyMerchantQualificationObjects(request) { verified = request; },
    privateImageUrl: value => value,
    rateLimits: { login: [], booking: [], merchantBooking: [], publicRead: [], upload: [] },
  });

  await routes.get('/api/merchant/qualification')(
    {
      merchantUser: { id: 'merchant-1', salonId: 'salon-1' },
      body: { licenseUrl: 'licenses/merchant-owner/new-license.png' },
    },
    { status() { return this; }, json() {} },
  );

  assert.deepEqual(verified, {
    userId: 'merchant-1',
    objectNames: ['licenses/merchant-owner/new-license.png'],
  });
  assert.equal(salon.licenseUrl, 'licenses/merchant-owner/new-license.png');
});

test('admin merchant creation helper is wired into route context', () => {
  assert.equal(typeof ensureSalonForMerchant, 'function');
});

test('approving a review publishes moderated images before making it public', async () => {
  const routes = new Map();
  const app = {
    get() {},
    post() {},
    patch(path, ...handlers) { routes.set(path, handlers.at(-1)); },
  };
  const booking = {
    id: 'BK-1',
    staffId: 'staff-1',
    review: { reviewStatus: 'pending', imageUrls: ['moderation/review-1.png'] },
    markModified() {},
    async save() {},
  };
  const published = [];
  registerAdminRoutes(app, {
    Booking: { async findOne() { return booking; } },
    async publishModeratedImage(name) {
      published.push(name);
      return 'https://public.example/uploads/review-1.png';
    },
    async deleteModeratedImages() {},
    rateLimits: { login: [], upload: [] },
  });

  await routes.get('/api/admin/user-images')(
    { body: { bookingId: 'BK-1', type: 'review', action: 'approve' } },
    { json() {} },
  );

  assert.deepEqual(published, ['moderation/review-1.png']);
  assert.equal(booking.review.reviewStatus, 'approved');
  assert.deepEqual(booking.review.imageUrls, ['https://public.example/uploads/review-1.png']);
});

test('approving a review edit replaces the public review only after approval', async () => {
  const routes = new Map();
  const app = {
    get() {},
    post() {},
    patch(path, ...handlers) { routes.set(path, handlers.at(-1)); },
  };
  const original = {
    id: 'review-1',
    bookingId: 'BK-1',
    comment: '原评论',
    rating: 4,
    reviewStatus: 'approved',
  };
  const booking = {
    id: 'BK-1',
    staffId: 'staff-1',
    reviewed: true,
    review: {
      ...original,
      pendingEdit: {
        ...original,
        comment: '修改后评论',
        rating: 5,
        imageUrls: ['moderation/new.png'],
        reviewStatus: 'pending',
      },
    },
    markModified() {},
    async save() {},
  };
  registerAdminRoutes(app, {
    Booking: { async findOne() { return booking; } },
    async publishModeratedImage() { return 'https://public.example/new.png'; },
    async deleteModeratedImages() {},
    rateLimits: { login: [], upload: [] },
  });

  assert.equal(booking.review.comment, '原评论');
  await routes.get('/api/admin/user-images')(
    { body: { bookingId: 'BK-1', type: 'reviewEdit', action: 'approve' } },
    { status() { return this; }, json() {} },
  );

  assert.equal(booking.review.comment, '修改后评论');
  assert.equal(booking.review.pendingEdit, undefined);
});

test('rejecting a review keeps moderated images for preview and later approval', async () => {
  const routes = new Map();
  const app = {
    get() {},
    post() {},
    patch(path, ...handlers) { routes.set(path, handlers.at(-1)); },
  };
  const booking = {
    id: 'BK-1',
    staffId: 'staff-1',
    review: { reviewStatus: 'pending', imageUrls: ['moderation/review-1.png'] },
    markModified() {},
    async save() {},
  };
  let deleted = false;
  registerAdminRoutes(app, {
    Booking: { async findOne() { return booking; } },
    async deleteModeratedImages() { deleted = true; },
    async getStaffById() { return null; },
    rateLimits: { login: [], upload: [] },
  });

  await routes.get('/api/admin/user-images')(
    { body: { bookingId: 'BK-1', type: 'review', action: 'reject' } },
    { json() {} },
  );

  assert.equal(deleted, false);
  assert.equal(booking.review.reviewStatus, 'rejected');
  assert.deepEqual(booking.review.imageUrls, ['moderation/review-1.png']);
});

test('deleting an approved review removes the single booking review', async () => {
  const routes = new Map();
  const app = {
    get() {},
    post() {},
    patch(path, ...handlers) { routes.set(path, handlers.at(-1)); },
  };
  const booking = {
    id: 'BK-1',
    staffId: 'staff-1',
    reviewed: true,
    review: { id: 'review-1', bookingId: 'BK-1', reviewStatus: 'approved', imageUrls: [] },
    markModified() {},
    async save() {},
  };
  registerAdminRoutes(app, {
    Booking: { async findOne() { return booking; } },
    async publishModeratedImage(name) { return name; },
    async deleteModeratedImages() {},
    rateLimits: { login: [], upload: [] },
  });

  await routes.get('/api/admin/user-images')(
    { body: { bookingId: 'BK-1', type: 'review', action: 'delete' } },
    { json() {} },
  );

  assert.equal(booking.review, undefined);
  assert.equal(booking.reviewed, false);
});

test('merchant review replies are scoped to the authenticated merchant salon', async () => {
  const routes = new Map();
  const app = {
    get() {},
    post() {},
    delete() {},
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
      publicRead: [],
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

test('merchant review replies stay pending without replacing the public reply', async () => {
  const routes = new Map();
  const app = {
    get() {},
    post() {},
    delete() {},
    use() {},
    patch(path, handler) { routes.set(path, handler); },
  };
  const booking = new Booking({
    id: 'BK-1',
    salonId: 'salon-7',
    staffId: 'staff-1',
    serviceId: 'service-1',
    startTime: new Date('2030-01-01T10:00:00Z'),
    reviewed: true,
    review: {
      id: 'review-1',
      comment: '原评价',
      rating: 5,
      reviewStatus: 'approved',
      merchantReply: { content: '旧回复', reviewStatus: 'approved' },
    },
  });
  booking.save = async () => booking;
  registerMerchantRoutes(app, {
    Booking: { async findOne() { return booking; } },
    INPUT_LIMITS: { reviewReply: 1000 },
    normalizeMerchantBooking: value => value,
    broadcastBookingEvent() {},
    rateLimits: {
      login: [], booking: [], merchantBooking: [], publicRead: [], upload: [],
    },
  });

  await routes.get('/api/merchant/bookings/:id/review-reply')(
    {
      body: { reply: '新回复' },
      params: { id: 'BK-1' },
      merchantUser: { salonId: 'salon-7' },
    },
    { json() {} },
  );

  assert.equal(booking.review.comment, '原评价');
  assert.equal(booking.review.merchantReply.content, '旧回复');
  assert.equal(booking.review.pendingMerchantReply.content, '新回复');
  assert.equal(booking.review.pendingMerchantReply.reviewStatus, 'pending');
});

test('approving a merchant reply publishes it without changing the user review status', async () => {
  const routes = new Map();
  const app = {
    get() {},
    post() {},
    patch(path, ...handlers) { routes.set(path, handlers.at(-1)); },
  };
  const booking = {
    id: 'BK-1',
    staffId: 'staff-1',
    review: {
      id: 'review-1',
      bookingId: 'BK-1',
      reviewStatus: 'approved',
      merchantReply: { content: '旧回复', reviewStatus: 'approved' },
      pendingMerchantReply: { content: '新回复', reviewStatus: 'pending' },
    },
    markModified() {},
    async save() {},
  };
  registerAdminRoutes(app, {
    Booking: { async findOne() { return booking; } },
    rateLimits: { login: [], upload: [] },
  });

  await routes.get('/api/admin/user-images')(
    { body: { bookingId: 'BK-1', type: 'reviewReply', action: 'approve' } },
    { status() { return this; }, json() {} },
  );

  assert.equal(booking.review.reviewStatus, 'approved');
  assert.equal(booking.review.pendingMerchantReply, undefined);
  assert.equal(booking.review.merchantReply.content, '新回复');
  assert.equal(booking.review.merchantReply.reviewStatus, 'approved');
});

test('rejecting an approved merchant reply hides it without rejecting the user review', async () => {
  const routes = new Map();
  const app = {
    get() {},
    post() {},
    patch(path, ...handlers) { routes.set(path, handlers.at(-1)); },
  };
  const booking = {
    id: 'BK-1',
    staffId: 'staff-1',
    review: {
      id: 'review-1',
      bookingId: 'BK-1',
      reviewStatus: 'approved',
      merchantReply: { content: '需要下架', reviewStatus: 'approved' },
    },
    markModified() {},
    async save() {},
  };
  registerAdminRoutes(app, {
    Booking: { async findOne() { return booking; } },
    rateLimits: { login: [], upload: [] },
  });

  await routes.get('/api/admin/user-images')(
    { body: { bookingId: 'BK-1', type: 'reviewReply', action: 'reject' } },
    { status() { return this; }, json() {} },
  );

  assert.equal(booking.review.reviewStatus, 'approved');
  assert.equal(booking.review.merchantReply.reviewStatus, 'rejected');
  assert.equal(normalizeBooking(booking).review.merchantReply, undefined);

  await routes.get('/api/admin/user-images')(
    { body: { bookingId: 'BK-1', type: 'reviewReply', action: 'approve' } },
    { status() { return this; }, json() {} },
  );

  assert.equal(booking.review.reviewStatus, 'approved');
  assert.equal(booking.review.merchantReply.reviewStatus, 'approved');
});

test('client booking payloads hide pending merchant replies', () => {
  const booking = {
    status: 'completed',
    review: {
      merchantReply: { content: '已通过', reviewStatus: 'approved' },
      pendingMerchantReply: { content: '待审核', reviewStatus: 'pending' },
      pendingEdit: { comment: '待审核修改', reviewStatus: 'pending' },
    },
  };

  assert.equal(normalizeBooking(booking).review.pendingMerchantReply, undefined);
  assert.equal(normalizeBooking(booking).review.pendingEdit, undefined);
  assert.equal(normalizeBooking(booking).review.merchantReply.content, '已通过');
  assert.equal(normalizeMerchantBooking(booking).review.pendingMerchantReply.content, '待审核');
});

test('client reviews are scoped to the authenticated user and include booking context', async () => {
  const routes = new Map();
  const app = {
    get(path, ...handlers) { routes.set(`GET ${path}`, handlers.at(-1)); },
    post(path, ...handlers) { routes.set(`POST ${path}`, handlers.at(-1)); },
    patch(path, ...handlers) { routes.set(`PATCH ${path}`, handlers.at(-1)); },
    put() {},
    delete() {},
  };
  let reviewQuery;
  const cursor = {
    select() { return this; },
    sort() { return this; },
    skip() { return this; },
    limit() { return this; },
    async lean() {
      return [{
        id: 'BK-1',
        userId: 'user-1',
        salonName: 'Hot Hair',
        staffName: 'Alice',
        serviceName: 'Cut',
        review: { rating: 5, comment: 'Great', imageUrls: ['moderation/review/a.jpg'] },
      }];
    },
  };
  registerClientRoutes(app, {
    Booking: {
      find(query) { reviewQuery = query; return cursor; },
      async countDocuments() { return 1; },
    },
    normalizeBooking: booking => booking,
    normalizePagination: () => ({ page: 1, limit: 50, skip: 0 }),
    setPaginationHeaders() {},
    userIdAliases: id => [id],
    privateImageUrl: value => `signed:${value}`,
    requireClientAuth() {},
    rateLimits: { upload: [], login: [] },
  });
  let payload;
  await routes.get('GET /api/auth/reviews')(
    { clientUser: { id: 'user-1' }, query: {} },
    { json(value) { payload = value; } },
  );

  assert.deepEqual(reviewQuery.userId, { $in: ['user-1'] });
  assert.equal(payload[0].bookingId, 'BK-1');
  assert.equal(payload[0].salonName, 'Hot Hair');
  assert.deepEqual(payload[0].imageUrls, ['signed:moderation/review/a.jpg']);
});

test('client avatar upload signs one private moderated object for the authenticated user', async () => {
  const routes = new Map();
  const app = {
    get() {},
    patch() {},
    put() {},
    delete() {},
    post(path, ...handlers) { routes.set(path, handlers.at(-1)); },
  };
  let signRequest;
  registerClientRoutes(app, {
    createModeratedUploadPolicies(request) {
      signRequest = request;
      return [{ objectName: 'moderation/avatar/user-1/avatar.jpg', uploadUrl: 'https://private.example' }];
    },
    requireClientAuth() {},
    rateLimits: { upload: [], login: [] },
  });
  let payload;
  await routes.get('/api/uploads/avatar/sign')(
    {
      clientUser: { id: 'user-1' },
      body: { files: [{ fileName: 'avatar.jpg', contentType: 'image/jpeg', size: 10 }] },
    },
    { json(value) { payload = value; } },
  );

  assert.equal(signRequest.type, 'avatar');
  assert.equal(signRequest.userId, 'user-1');
  assert.equal(signRequest.files.length, 1);
  assert.equal(payload.upload.url, 'moderation/avatar/user-1/avatar.jpg');
  assert.equal(payload.upload.uploadUrl, 'https://private.example');
});

test('client profile keeps the approved avatar while a real Mongoose document stores the pending avatar', async () => {
  const routes = new Map();
  const app = {
    get() {},
    post() {},
    put() {},
    delete() {},
    patch(path, ...handlers) { routes.set(path, handlers.at(-1)); },
  };
  const user = new ClientUser({
    id: 'user-1',
    account: '13800138000',
    displayName: '旧昵称',
    avatarUrl: 'https://cdn.example/approved.jpg',
    authProvider: 'wechat',
  });
  user.save = async () => user;
  let verified;
  registerClientRoutes(app, {
    ClientUser: { async findOne() { return user; } },
    async verifyModeratedImageObjects(request) { verified = request; return request.objectNames; },
    async deleteModeratedImages() {},
    buildClientUserPayload: value => ({
      avatarUrl: value.avatarUrl,
      avatarReviewStatus: value.avatarReviewStatus,
    }),
    privateImageUrl: value => value ? `signed:${value}` : '',
    sessionTokenFromRequest: () => 'token',
    rateLimits: { upload: [] },
  });

  let payload;
  await routes.get('/api/auth/profile')(
    {
      clientUser: { id: 'user-1' },
      body: { displayName: '新昵称', avatarUrl: 'moderation/avatar/user-1/new.jpg' },
    },
    { status() { return this; }, json(value) { payload = value; } },
  );

  assert.equal(verified.type, 'avatar');
  assert.deepEqual(verified.objectNames, ['moderation/avatar/user-1/new.jpg']);
  assert.equal(user.avatarUrl, 'https://cdn.example/approved.jpg');
  assert.equal(user.pendingAvatarUrl, 'moderation/avatar/user-1/new.jpg');
  assert.equal(user.avatarReviewStatus, 'pending');
  assert.equal(payload.user.avatarUrl, 'https://cdn.example/approved.jpg');
  assert.equal(payload.user.pendingAvatarUrl, 'signed:moderation/avatar/user-1/new.jpg');
});

test('admin approval publishes a pending avatar before replacing the approved avatar', async () => {
  const routes = new Map();
  const app = {
    get() {},
    post() {},
    put() {},
    delete() {},
    patch(path, ...handlers) { routes.set(path, handlers.at(-1)); },
  };
  const user = new ClientUser({
    id: 'user-1',
    account: '13800138000',
    displayName: '用户',
    avatarUrl: 'https://cdn.example/old.jpg',
    pendingAvatarUrl: 'moderation/avatar/user-1/new.jpg',
    avatarReviewStatus: 'pending',
    authProvider: 'wechat',
  });
  let updateQuery;
  registerAdminRoutes(app, {
    ClientUser: {
      async findOne() { return user; },
      async findOneAndUpdate(query, update) {
        updateQuery = query;
        user.set(update.$set);
        return user;
      },
    },
    async publishModeratedImage(objectName) {
      assert.equal(objectName, 'moderation/avatar/user-1/new.jpg');
      return 'https://cdn.example/new.jpg';
    },
    async deleteModeratedImages() {},
    buildClientUserPayload: value => ({
      avatarUrl: value.avatarUrl,
      avatarReviewStatus: value.avatarReviewStatus,
    }),
    rateLimits: { upload: [] },
  });

  let payload;
  await routes.get('/api/admin/users/:id/avatar')(
    { params: { id: 'user-1' }, body: { action: 'approve' } },
    { status() { return this; }, json(value) { payload = value; } },
  );

  assert.equal(updateQuery.pendingAvatarUrl, 'moderation/avatar/user-1/new.jpg');
  assert.equal(updateQuery.avatarReviewStatus, 'pending');
  assert.equal(user.avatarUrl, 'https://cdn.example/new.jpg');
  assert.equal(user.pendingAvatarUrl, '');
  assert.equal(user.avatarReviewStatus, 'approved');
  assert.equal(payload.user.avatarUrl, 'https://cdn.example/new.jpg');
});

test('editing a review stores a pending draft without changing the approved review', async () => {
  const routes = new Map();
  const app = {
    get() {},
    post() {},
    use() {},
    delete() {},
    patch(path, ...handlers) { routes.set(path, handlers.at(-1)); },
  };
  const originalReview = {
    id: 'review-1',
    bookingId: 'BK-1',
    comment: '原评论',
    rating: 4,
    imageUrls: ['https://public.example/old.jpg'],
    reviewStatus: 'approved',
  };
  const booking = new Booking({
    id: 'BK-1',
    userId: 'user-1',
    review: { ...originalReview },
  });
  let updateQuery;
  let update;
  registerClientBookingRoutes(app, {
    Booking: {
      async findOne() { return booking; },
      async findOneAndUpdate(query, value) {
        updateQuery = query;
        update = value;
        return { ...booking.toObject(), review: { ...originalReview, pendingEdit: value.$set['review.pendingEdit'] } };
      },
    },
    userIdAliases: id => [id],
    normalizeUserId: value => value,
    async verifyModeratedImageObjects() { return ['moderation/new.jpg']; },
    async deleteModeratedImages() {},
    normalizeBooking: value => value,
    broadcastBookingEvent() {},
    INPUT_LIMITS: { review: 1000 },
    rateLimits: { login: [], booking: [], merchantBooking: [], publicRead: [], upload: [] },
  });

  await routes.get('/api/bookings/:id/review')(
    {
      clientUser: { id: 'user-1' },
      params: { id: 'BK-1' },
      body: {
        rating: 5,
        comment: '修改后评论',
        retainedImageUrls: ['https://public.example/old.jpg'],
        imageObjects: ['moderation/new.jpg'],
      },
    },
    { status() { return this; }, json() {} },
  );

  assert.equal(booking.review.comment, '原评论');
  assert.equal(updateQuery['review.id'], 'review-1');
  assert.equal(update.$set['review.pendingEdit'].comment, '修改后评论');
  assert.equal(update.$set['review.pendingEdit'].reviewStatus, 'pending');
});

test('deleting a review returns success even when post-delete cleanup fails', async () => {
  const routes = new Map();
  const app = {
    get() {},
    post() {},
    patch() {},
    use() {},
    delete(path, ...handlers) { routes.set(path, handlers.at(-1)); },
  };
  const booking = new Booking({
    id: 'BK-1',
    userId: 'user-1',
    review: { id: 'review-1', imageUrls: ['https://public.example/old.jpg'] },
  });
  let updateQuery;
  registerClientBookingRoutes(app, {
    Booking: {
      async findOne() { return booking; },
      async findOneAndUpdate(query) {
        updateQuery = query;
        return { ...booking.toObject(), review: undefined };
      },
    },
    userIdAliases: id => [id],
    normalizeUserId: value => value,
    async deleteModeratedImages() { throw new Error('image cleanup failed'); },
    broadcastBookingEvent() { throw new Error('broadcast failed'); },
    rateLimits: { login: [], booking: [], merchantBooking: [], publicRead: [], upload: [] },
  });

  let payload;
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await routes.get('/api/bookings/:id/review')(
      { clientUser: { id: 'user-1' }, params: { id: 'BK-1' } },
      { json(value) { payload = value; } },
    );
    await Promise.resolve();
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(payload, { ok: true });
  assert.equal(updateQuery['review.id'], 'review-1');
});

test('concurrent review and complaint submissions only update once', async () => {
  const routes = new Map();
  const app = {
    get() {},
    post(path, ...handlers) { routes.set(path, handlers.at(-1)); },
    patch() {},
    delete() {},
    use() {},
  };
  const claimed = { review: false, complaint: false };
  const booking = {
    _id: 'mongo-booking-1',
    id: 'BK-1',
    userId: 'user-1',
    userName: 'User',
    status: 'completed',
    reviewed: false,
    complained: false,
    staffId: 'staff-1',
  };
  registerClientBookingRoutes(app, {
    Booking: {
      async findOne() { return booking; },
      async findOneAndUpdate(query, update) {
        const type = query.reviewed ? 'review' : 'complaint';
        if (claimed[type]) return null;
        claimed[type] = true;
        return { ...booking, ...update.$set };
      },
    },
    userIdAliases: userId => [userId],
    normalizeUserId: value => value,
    normalizeBooking: value => value,
    async verifyModeratedImageObjects() { return []; },
    async deleteModeratedImages() {},
    async getStaffById() { return {}; },
    broadcastBookingEvent() {},
    INPUT_LIMITS: { review: 1000, complaint: 2000 },
    rateLimits: { login: [], booking: [], merchantBooking: [], publicRead: [], upload: [] },
  });
  const invokeTwice = (path, body) => Promise.all([1, 2].map(async () => {
    const result = { status: 200 };
    await routes.get(path)(
      { clientUser: { id: 'user-1' }, params: { id: 'BK-1' }, body },
      {
        status(value) { result.status = value; return this; },
        json() {},
      },
    );
    return result.status;
  }));

  const reviewStatuses = await invokeTwice('/api/bookings/:id/review', { rating: 5, comment: 'good' });
  const complaintStatuses = await invokeTwice('/api/bookings/:id/complaint', { description: 'problem' });

  assert.deepEqual(reviewStatuses.sort(), [201, 409]);
  assert.deepEqual(complaintStatuses.sort(), [201, 409]);
});

test('booking cancellation atomically checks state and releases its slot in one transaction', async () => {
  const routes = new Map();
  const app = {
    get() {},
    post() {},
    delete() {},
    use() {},
    patch(path, ...handlers) { routes.set(path, handlers.at(-1)); },
  };
  const session = { id: 'transaction-session' };
  let updateCall;
  let deleteCall;
  let messageCreate;
  let couponReleaseCall;
  let transactionOptions;
  let ended = false;
  const current = {
    id: 'BK-1',
    userId: 'user-1',
    status: 'pending',
    startTime: new Date('2030-01-01'),
    couponId: 'coupon-1',
    originalAmountFen: 9900,
  };
  const updated = { ...current, status: 'canceled' };

  registerClientBookingRoutes(app, {
    Booking: {
      findOne() { return { session: async () => current }; },
      async findOneAndUpdate(...args) { updateCall = args; return updated; },
    },
    BookingMessage: {
      async create(...args) { messageCreate = args; return args[0]; },
    },
    SlotOccupancy: {
      async deleteOne(...args) { deleteCall = args; },
    },
    UserCoupon: {
      async updateOne(...args) { couponReleaseCall = args; },
    },
    mongoose: {
      async startSession() {
        return Object.assign(session, {
          async withTransaction(work, options) { transactionOptions = options; await work(); },
          async endSession() { ended = true; },
        });
      },
    },
    normalizeUserId: value => value,
    userIdAliases: id => [id],
    normalizeBooking: value => value,
    broadcastBookingEvent() {},
    USER_CANCEL_WINDOW_MS: 3 * 60 * 60 * 1000,
    rateLimits: { login: [], booking: [], merchantBooking: [], publicRead: [], upload: [] },
  });

  let response;
  await routes.get('/api/bookings/:id/cancel')(
    { clientUser: { id: 'user-1' }, params: { id: 'BK-1' } },
    { json(value) { response = value; } },
  );

  assert.equal(updateCall[0].status, 'pending');
  assert.equal(updateCall[1].$set.canceledBy, 'user');
  assert.equal(updateCall[2].session, session);
  assert.deepEqual(deleteCall, [{ bookingId: 'BK-1' }, { session }]);
  assert.equal(messageCreate[0][0].type, 'canceled');
  assert.equal(messageCreate[1].session, session);
  assert.equal(couponReleaseCall[0].id, 'coupon-1');
  assert.deepEqual(couponReleaseCall[0].$or, [
    { reservedBookingId: 'BK-1' },
    { redeemedBookingId: 'BK-1' },
  ]);
  assert.equal(couponReleaseCall[1].$unset.reservedBookingId, '');
  assert.equal(updateCall[1].$set.couponId, '');
  assert.deepEqual(transactionOptions, {
    readConcern: { level: 'snapshot' },
    writeConcern: { w: 'majority' },
  });
  assert.equal(response.booking.status, 'canceled');
  assert.equal(ended, true);
});

test('booking creation atomically reserves an eligible claimed coupon', async () => {
  const routes = new Map();
  const app = {
    get() {},
    patch() {},
    delete() {},
    use() {},
    post(path, ...handlers) { routes.set(path, handlers.at(-1)); },
  };
  const session = {
    async withTransaction(work) { await work(); },
    async endSession() {},
  };
  let couponQuery;
  let couponUpdate;
  let savedBooking;
  let messageCreate;
  class Booking {
    constructor(value) { Object.assign(this, value); }
    async save(options) {
      assert.equal(options.session, session);
      savedBooking = this;
    }
    static async exists() { return false; }
  }

  registerClientBookingRoutes(app, {
    Booking,
    BookingMessage: {
      async create(...args) { messageCreate = args; return args[0]; },
    },
    UserCoupon: {
      async findOneAndUpdate(query, update, options) {
        couponQuery = query;
        couponUpdate = update;
        assert.equal(options.session, session);
        return {
          id: 'coupon-1',
          code: 'ABCD-EFGH-IJKL',
          title: '满99减20',
          minimumSpendFen: 9900,
          discountFen: 2000,
        };
      },
    },
    SlotOccupancy: {
      async updateOne() {},
    },
    mongoose: {
      async startSession() { return session; },
    },
    crypto: {
      randomInt() { return 12345678; },
    },
    normalizeUserId: value => value,
    userIdAliases: value => [value],
    getStaffById() {
      return { async lean() { return { id: 'staff-1', name: 'Stylist', extraServiceFee: 0 }; } };
    },
    getSalonByStaffId() {
      return {
        async lean() {
          return {
            id: 'salon-1',
            name: 'Salon',
            openingHours: '09:00-22:00',
            services: [{
              id: 'service-1',
              name: 'Cut',
              price: '¥120',
              duration: '60分钟',
            }],
          };
        },
      };
    },
    parseOpeningHours: () => ({ start: 0, end: 24 * 60 }),
    async findActiveBookingAtTime() { return null; },
    async isStaffUnavailable() { return false; },
    isSalonClosedOnDate: () => false,
    isSameDayBookingBlocked: () => false,
    async getUserPolicy() { return { isBlacklisted: false }; },
    couponDiscountForOrder: (amount, coupon) =>
      amount >= coupon.minimumSpendFen ? coupon.discountFen : null,
    normalizeBooking: value => value,
    broadcastBookingEvent() {},
    INPUT_LIMITS: { note: 500 },
    rateLimits: { login: [], booking: [], merchantBooking: [], publicRead: [], upload: [] },
  });

  let status = 200;
  let response;
  await routes.get('/api/bookings')(
    {
      clientUser: { id: 'user-1', displayName: 'User' },
      body: {
        staffId: 'staff-1',
        serviceId: 'service-1',
        startTime: '2030-01-01T10:00:00.000Z',
        couponId: 'coupon-1',
      },
    },
    {
      status(value) { status = value; return this; },
      json(value) { response = value; },
    },
  );

  assert.equal(status, 201);
  assert.equal(couponQuery.id, 'coupon-1');
  assert.deepEqual(couponQuery.userId, { $in: ['user-1'] });
  assert.equal(couponQuery.claimedAt.$exists, true);
  assert.equal(couponUpdate.$set.reservedBookingId, '12345678');
  assert.equal(savedBooking.couponId, 'coupon-1');
  assert.equal(savedBooking.couponDiscountFen, 2000);
  assert.equal(savedBooking.payableAmountFen, 10000);
  assert.equal(messageCreate[0][0].type, 'created');
  assert.equal(messageCreate[1].session, session);
  assert.equal(response.booking.id, '12345678');
});

test('completing a booking atomically redeems its reserved coupon', async () => {
  const routes = new Map();
  const app = {
    get() {},
    post() {},
    delete() {},
    use() {},
    patch(path, ...handlers) { routes.set(path, handlers.at(-1)); },
  };
  const session = { id: 'transaction-session' };
  const booking = {
    id: 'BK-1',
    salonId: 'salon-1',
    userId: 'user-1',
    status: 'accepted',
    couponId: 'coupon-1',
    couponRedeemedAt: null,
    startTime: new Date('2030-01-01'),
  };
  let couponUpdate;
  let bookingUpdate;
  let messageCreate;

  registerMerchantRoutes(app, {
    Salon: {
      findOne() {
        return {
          select() { return this; },
          async lean() { return { staffIds: [] }; },
        };
      },
    },
    Booking: {
      async findOne() { return booking; },
      async findOneAndUpdate(...args) {
        bookingUpdate = args;
        return { ...booking, ...args[1].$set };
      },
    },
    BookingMessage: {
      async create(...args) { messageCreate = args; return args[0]; },
    },
    UserCoupon: {
      async findOneAndUpdate(...args) {
        couponUpdate = args;
        return { id: 'coupon-1', redeemedAt: args[1].$set.redeemedAt };
      },
    },
    SlotOccupancy: {
      async deleteOne() {},
    },
    mongoose: {
      async startSession() {
        return Object.assign(session, {
          async withTransaction(work) { await work(); },
          async endSession() {},
        });
      },
    },
    buildMerchantBookingScope: () => ({ salonId: 'salon-1' }),
    normalizeMerchantBooking: value => value,
    broadcastBookingEvent() {},
    rateLimits: { login: [], booking: [], merchantBooking: [], publicRead: [], upload: [] },
  });

  let response;
  await routes.get('/api/merchant/bookings/:id')(
    {
      params: { id: 'BK-1' },
      body: { action: 'complete' },
      merchantUser: { id: 'merchant-1', salonId: 'salon-1' },
    },
    {
      status() { return this; },
      json(value) { response = value; },
    },
  );

  assert.deepEqual(couponUpdate[0], {
    id: 'coupon-1',
    reservedBookingId: 'BK-1',
    redeemedAt: { $exists: false },
  });
  assert.equal(couponUpdate[1].$set.redeemedBookingId, 'BK-1');
  assert.equal(couponUpdate[1].$set.redeemedMerchantId, 'merchant-1');
  assert.equal(couponUpdate[1].$unset.reservedBookingId, '');
  assert.equal(bookingUpdate[1].$set.status, 'completed');
  assert.ok(bookingUpdate[1].$set.couponRedeemedAt instanceof Date);
  assert.equal(messageCreate[0][0].type, 'complete');
  assert.equal(messageCreate[0][0].status, 'completed');
  assert.equal(messageCreate[1].session, session);
  assert.equal(response.booking.status, 'completed');
});
