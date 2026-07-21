const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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
  parseMerchantRescheduleTime,
  readFavoriteSalons,
  server,
  socketCanReceiveBooking,
  stripSensitiveSalonFields,
  verifyPassword,
} = require('./index');
const { isAllowedOrigin } = require('./src/config');
const { Booking, ClientUser, FavoriteSalon, Salon, SlotOccupancy, StaffProfile } = require('./src/models');
const registerAdminRoutes = require('./src/routes/admin');
const registerMerchantRoutes = require('./src/routes/merchant');
const registerPublicRoutes = require('./src/routes/public');

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
    put(path, handler) { routes.set(`PUT ${path}`, handler); },
    delete(path, handler) { routes.set(`DELETE ${path}`, handler); },
  };
  let updateCall;
  let deleteCall;
  registerPublicRoutes(app, {
    FavoriteSalon: {
      async updateOne(...args) { updateCall = args; },
      async deleteMany(query) { deleteCall = query; },
    },
    async resolveRequestUser() { return { userId: 'user-1' }; },
    async readFavoriteSalons() { return []; },
    userIdAliases: userId => [userId, 'legacy-user-1'],
    rateLimits: { publicRead: [] },
  });
  const response = { json() {}, status() { return this; } };
  const request = { params: { id: 'salon-1' } };

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
  assert.equal(isAllowedOrigin('http://oss.hothair.top'), true);
  assert.equal(isAllowedOrigin('http://example.com'), false);
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
    async getStaffById() { return null; },
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

test('deleting an approved review removes it from the booking and staff profile', async () => {
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
  const staff = {
    reviews: [booking.review],
    markModified() {},
    async save() {},
  };
  registerAdminRoutes(app, {
    Booking: { async findOne() { return booking; } },
    async publishModeratedImage(name) { return name; },
    async deleteModeratedImages() {},
    async getStaffById() { return staff; },
    calculateStaffRating() { return 0; },
    rateLimits: { login: [], upload: [] },
  });

  await routes.get('/api/admin/user-images')(
    { body: { bookingId: 'BK-1', type: 'review', action: 'delete' } },
    { json() {} },
  );

  assert.equal(booking.review, undefined);
  assert.equal(booking.reviewed, false);
  assert.deepEqual(staff.reviews, []);
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
    use() {},
    patch(path, handler) { routes.set(path, handler); },
  };
  const oldReply = { content: '旧回复', reviewStatus: 'approved' };
  const booking = {
    id: 'BK-1',
    salonId: 'salon-7',
    staffId: 'staff-1',
    reviewed: true,
    review: { id: 'review-1', merchantReply: oldReply },
    markModified() {},
    async save() {},
  };
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

  assert.equal(booking.review.merchantReply, oldReply);
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
  const staff = {
    reviews: [{ ...booking.review, pendingMerchantReply: undefined }],
    markModified() {},
    async save() {},
  };
  registerAdminRoutes(app, {
    Booking: { async findOne() { return booking; } },
    async getStaffById() { return staff; },
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
  assert.equal(staff.reviews[0].merchantReply.content, '新回复');
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
  const staff = {
    reviews: [{ ...booking.review }],
    markModified() {},
    async save() {},
  };
  registerAdminRoutes(app, {
    Booking: { async findOne() { return booking; } },
    async getStaffById() { return staff; },
    rateLimits: { login: [], upload: [] },
  });

  await routes.get('/api/admin/user-images')(
    { body: { bookingId: 'BK-1', type: 'reviewReply', action: 'reject' } },
    { status() { return this; }, json() {} },
  );

  assert.equal(booking.review.reviewStatus, 'approved');
  assert.equal(booking.review.merchantReply.reviewStatus, 'rejected');
  assert.equal(staff.reviews[0].merchantReply.reviewStatus, 'rejected');
  assert.equal(normalizeBooking(booking).review.merchantReply, undefined);

  await routes.get('/api/admin/user-images')(
    { body: { bookingId: 'BK-1', type: 'reviewReply', action: 'approve' } },
    { status() { return this; }, json() {} },
  );

  assert.equal(booking.review.reviewStatus, 'approved');
  assert.equal(booking.review.merchantReply.reviewStatus, 'approved');
  assert.equal(staff.reviews[0].merchantReply.reviewStatus, 'approved');
});

test('client booking payloads hide pending merchant replies', () => {
  const booking = {
    status: 'completed',
    review: {
      merchantReply: { content: '已通过', reviewStatus: 'approved' },
      pendingMerchantReply: { content: '待审核', reviewStatus: 'pending' },
    },
  };

  assert.equal(normalizeBooking(booking).review.pendingMerchantReply, undefined);
  assert.equal(normalizeBooking(booking).review.merchantReply.content, '已通过');
  assert.equal(normalizeMerchantBooking(booking).review.pendingMerchantReply.content, '待审核');
});

test('concurrent review and complaint submissions only update once', async () => {
  const routes = new Map();
  const app = {
    get() {},
    post(path, ...handlers) { routes.set(path, handlers.at(-1)); },
    patch() {},
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
  registerMerchantRoutes(app, {
    Booking: {
      async findOne() { return booking; },
      async findOneAndUpdate(query, update) {
        const type = query.reviewed ? 'review' : 'complaint';
        if (claimed[type]) return null;
        claimed[type] = true;
        return { ...booking, ...update.$set };
      },
    },
    async resolveRequestUser() { return { userId: 'user-1' }; },
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
      { params: { id: 'BK-1' }, body },
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
    rateLimits: { login: [], booking: [], merchantBooking: [], publicRead: [], upload: [] },
  });

  let response;
  await routes.get('/api/bookings/:id/cancel')(
    { params: { id: 'BK-1' } },
    { json(value) { response = value; } },
  );

  assert.equal(updateCall[0].status, 'pending');
  assert.equal(updateCall[1].$set.canceledBy, 'user');
  assert.equal(updateCall[2].session, session);
  assert.deepEqual(deleteCall, [{ bookingId: 'BK-1' }, { session }]);
  assert.deepEqual(transactionOptions, {
    readConcern: { level: 'snapshot' },
    writeConcern: { w: 'majority' },
  });
  assert.equal(response.booking.status, 'canceled');
  assert.equal(ended, true);
});
