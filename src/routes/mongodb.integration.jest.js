const crypto = require('node:crypto');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });
const mongoose = require('mongoose');
const WebSocket = require('ws');
const models = require('../models');
const { createSession } = require('../services/auth');
const { hashPassword } = require('../passwords');
const { occupiedSlotStarts } = require('../services/booking');
const { completeDueBookings, expirePendingBookings } = require('../services/auto-complete-bookings');
// Fixtures insert approved reviews directly, so they refresh stored ratings the way moderation routes do.
const { refreshStaffRatingSummaries } = require('../services/staff-ratings');
// This in-process test server exercises many writes without waiting for production rate windows.
const rateLimitToken = crypto.randomBytes(32).toString('hex');
process.env.LOAD_TEST_BYPASS_ENABLED = 'true';
process.env.LOAD_TEST_BYPASS_TOKEN = rateLimitToken;
const { server, getUserPolicy } = require('../../index');
const { Booking, BookingMessage, SlotOccupancy, Salon, StaffProfile, ClientUser, MerchantUser, AdminUser, UserCoupon, UserPolicy, ReviewHelpful } = models;
const uri = String(process.env.TEST_MONGODB_URI || '').trim();
const describeWithMongo = uri ? describe : describe.skip;

describeWithMongo('three-client booking contracts against a real replica set', () => {
  const sessions = {};
  let baseUrl;
  let bookingId;
  beforeAll(async () => {
    await mongoose.connect(uri, { dbName: `hot_hair_joint_test_${crypto.randomUUID().replaceAll('-', '')}`, serverSelectionTimeoutMS: 10000 });
    await Promise.all(Object.values(models).map(Model => Model.init()));
    for (const [role, Model] of [['client', ClientUser], ['merchant', MerchantUser], ['admin', AdminUser]]) {
      const session = createSession(); sessions[role] = session;
      await Model.create({ id: `${role}-1`, username: role, account: '13800000001', displayName: role,
        authProvider: 'wechat', salonId: 'salon-1', role, passwordHash: 'fixture-hash', passwordSalt: 'fixture-salt',
        sessionTokenHash: session.tokenHash, sessionExpiresAt: session.expiresAt });
    }
    await StaffProfile.create({ id: 'staff-1', name: 'Stylist', roleId: 'designer', extraServiceFeeFen: 0 });
    await Salon.create({ id: 'salon-1', name: 'Salon', publishStatus: 'online', staffIds: ['staff-1'], openingHours: '09:00-20:00',
      description: '首页门店简介', image: 'https://example.com/salon-cover.jpg',
      services: [{ id: 'service-1', name: 'Cut', note: '洗剪吹造型', tagIds: ['wash_cut_blow'], priceFen: 8000, durationMinutes: 60 }] });
    await UserCoupon.create({ id: 'coupon-1', userId: 'client-1', campaignKey: 'fixture', couponType: 'fixture',
      minimumSpendFen: 5000, discountFen: 1000, title: 'Fixture coupon', grantedAt: new Date(), claimedAt: new Date(),
      validFrom: new Date('2020-01-01'), validUntil: new Date('2035-01-01') });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });
  async function request(role, route, body, method = 'GET') {
    const res = await fetch(`${baseUrl}/api${route}`, { method,
      headers: { Authorization: `Bearer ${sessions[role].token}`, 'Content-Type': 'application/json', 'x-load-test-token': rateLimitToken },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json(), total: res.headers.get('x-total-count') };
  }

  async function createClient(id) {
    const session = createSession();
    sessions[id] = session;
    await ClientUser.create({ id, account: id, authProvider: 'wechat',
      sessionTokenHash: session.tokenHash, sessionExpiresAt: session.expiresAt });
  }

  test('merchants require an explicit salon, including a valid association to salon 1', async () => {
    const id = 'merchant-missing-salon';
    const password = 'fixture-pass7';
    const { salt, hash } = await hashPassword(password);
    const credentials = { id, username: id, passwordSalt: salt, passwordHash: hash };
    await expect(MerchantUser.create(credentials)).rejects.toThrow('salonId');
    sessions.missingSalon = createSession();
    await MerchantUser.collection.insertOne({ ...credentials,
      sessionTokenHash: sessions.missingSalon.tokenHash, sessionExpiresAt: sessions.missingSalon.expiresAt });
    const salon = await Salon.create({ id: '1', name: 'Explicit salon' });
    try {
      expect((await request('merchant', '/merchant/auth/login', { username: id, password }, 'POST')).status).toBe(403);
      expect((await request('missingSalon', '/merchant/salon')).status).toBe(403);
      expect((await request('missingSalon', '/merchant/bookings')).status).toBe(403);
      expect((await request('missingSalon', '/merchant/auth/logout', {}, 'POST')).status).toBe(200);
      const adminInput = { username: 'new-merchant', displayName: 'New merchant', password };
      expect((await request('admin', '/admin/merchants', adminInput, 'POST')).status).toBe(400);
      expect((await request('admin', `/admin/merchants/${id}`, { salonId: '1' }, 'PATCH')).status).toBe(200);
      const login = await request('merchant', '/merchant/auth/login', { username: id, password }, 'POST');
      expect(login.status).toBe(200);
      sessions.missingSalon = { token: login.body.token };
      expect((await request('missingSalon', '/merchant/salon')).body).toMatchObject({ id: '1', name: 'Explicit salon' });
    } finally {
      await MerchantUser.deleteOne({ id });
      await Salon.deleteOne({ _id: salon._id });
    }
  });

  test('password rules apply to new credentials without invalidating existing logins', async () => {
    const username = 'password-policy-merchant';
    const oldPassword = '123456';
    const { salt, hash } = await hashPassword(oldPassword);
    const credentials = { id: username, username, salonId: 'salon-1', passwordSalt: salt, passwordHash: hash };
    await MerchantUser.create(credentials);
    await AdminUser.create(credentials);
    try {
      for (const role of ['merchant', 'admin']) {
        const login = await request(role, `/${role}/auth/login`, { username, password: oldPassword }, 'POST');
        expect(login.status).toBe(200);
        if (role === 'merchant') sessions.passwordPolicy = { token: login.body.token };
      }
      const account = '/merchant/account';
      for (const newPassword of ['abcd12345', 'letters-only', '1234567890']) {
        expect((await request('passwordPolicy', account, { currentPassword: oldPassword, newPassword }, 'PATCH')).status).toBe(400);
        expect((await request('admin', `/admin/merchants/${username}`, { password: newPassword }, 'PATCH')).status).toBe(400);
        expect((await request('admin', '/admin/merchants', {
          username: 'another-merchant', displayName: 'Test', salonId: 'password-policy-salon', password: newPassword,
        }, 'POST')).status).toBe(400);
      }
      expect((await request('admin', `/admin/merchants/${username}`, { displayName: 'Updated' }, 'PATCH')).status).toBe(200);
      const newPassword = 'validpass7';
      expect((await request('passwordPolicy', account, { currentPassword: oldPassword, newPassword }, 'PATCH')).status).toBe(200);
      expect((await request('merchant', '/merchant/auth/login', { username, password: oldPassword }, 'POST')).status).toBe(401);
      expect((await request('merchant', '/merchant/auth/login', { username, password: newPassword }, 'POST')).status).toBe(200);
    } finally {
      await Promise.all([MerchantUser.deleteOne({ id: username }), AdminUser.deleteOne({ id: username })]);
    }
  });

  test('booking list and promotion routes reject ambiguous or inherited query values', async () => {
    for (const [role, route] of [
      ['client', '/bookings?status=pending&status=accepted'],
      ['client', '/bookings?staffId=staff-1&staffId=staff-2'],
      ['merchant', '/merchant/bookings?status=pending&status=accepted'],
      ['client', '/salons/promoted-services?category=constructor'],
      ['client', '/salons/promoted-services?category=__proto__'],
    ]) {
      expect((await request(role, route)).status).toBe(400);
    }
    for (const [role, route] of [
      ['client', '/bookings?status=pending&staffId=staff-1'],
      ['merchant', '/merchant/bookings?status=pending'],
      ['client', '/salons/promoted-services?category=women-cut'],
    ]) {
      expect((await request(role, route)).status).toBe(200);
    }
  });

  test('analytics event retention uses a 180-day TTL index', async () => {
    const indexes = await models.AnalyticsEvent.collection.indexes();
    expect(indexes).toContainEqual(expect.objectContaining({
      key: { createdAt: 1 }, expireAfterSeconds: 15_552_000,
    }));
  });

  test('phone login query uses the account and phone indexes', async () => {
    const phone = '13900000000';
    const id = 'legacy-phone-index';
    await ClientUser.create({ id, account: id, phone, authProvider: 'wechat' });
    try {
      const filter = { $or: [{ account: phone }, { phone }] };
      expect((await ClientUser.findOne(filter).lean()).id).toBe(id);
      const plan = await ClientUser.findOne(filter).explain('queryPlanner');
      const winningPlan = JSON.stringify(plan.queryPlanner.winningPlan);
      expect(winningPlan).toContain('"indexName":"account_1"');
      expect(winningPlan).toContain('"indexName":"phone_1"');
    } finally { await ClientUser.deleteOne({ id }); }
  });

  test('new expected-price contract rolls back coupon, occupancy, policy and salon fence before reconfirmation', async () => {
    const input = { staffId: 'staff-1', salonId: 'salon-1', serviceId: 'service-1', startTime: '2030-01-01T10:00:00', couponId: 'coupon-1', expectedOriginalAmountFen: 8000, expectedPayableAmountFen: 5000 };
    const changed = await request('client', '/bookings', input, 'POST');
    expect(changed.status).toBe(409);
    expect(changed.body).toMatchObject({ code: 'BOOKING_PRICE_CHANGED', quote: { payableAmountFen: 7000 } });
    expect(await Booking.countDocuments()).toBe(0);
    expect(await BookingMessage.countDocuments()).toBe(0);
    expect(await SlotOccupancy.countDocuments()).toBe(0);
    expect(await UserPolicy.countDocuments()).toBe(0);
    expect((await Salon.findOne({ id: 'salon-1' }).select('+bookingCreationFence').lean()).bookingCreationFence).toBe(0);
    const coupon = await UserCoupon.findOne({ id: 'coupon-1' }).lean();
    expect(coupon.reservedBookingId).toBe('');
    expect(coupon.reservedAt).toBeUndefined();
    const confirmed = await request('client', '/bookings', { ...input, expectedPayableAmountFen: 7000 }, 'POST');
    expect(confirmed.status).toBe(201);
    bookingId = confirmed.body.booking.id;
    expect(confirmed.body.booking.payableAmountFen).toBe(7000);
    expect((await UserCoupon.findOne({ id: 'coupon-1' }).lean()).reservedBookingId).toBe(bookingId);
    expect(await SlotOccupancy.countDocuments({ bookingId })).toBe(1);
  });

  test('released booking list includes homepage intro and cover without altering order state', async () => {
    const list = await request('client', '/bookings?page=1&limit=20');
    expect(list.status).toBe(200);
    const row = list.body.find(booking => booking.id === bookingId);
    expect(row).toMatchObject({ salonDescription: '首页门店简介', salonImageUrl: 'https://example.com/salon-cover.jpg', serviceName: 'Cut', serviceDescription: '洗剪吹造型', status: 'pending' });
    expect(list.body.every(booking => booking.userId === 'client-1')).toBe(true);
    expect(Number(list.total)).toBeGreaterThan(0);
    expect((await Booking.findOne({ id: bookingId }).lean()).salonDescription).toBeUndefined();
  });

  test('legacy body remains accepted and a price decrease invalidating the selected coupon still returns a fresh quote', async () => {
    const legacy = await request('client', '/bookings', { staffId: '__no_preference__', salonId: 'salon-1', serviceId: 'service-1', startTime: '2030-01-02T10:00:00' }, 'POST');
    expect(legacy.status).toBe(201);
    await UserCoupon.create({ id: 'coupon-2', userId: 'client-1', campaignKey: 'fixture', couponType: 'higher-threshold',
      minimumSpendFen: 9900, discountFen: 2000, title: 'Threshold coupon', grantedAt: new Date(), claimedAt: new Date(), validFrom: new Date('2020-01-01'), validUntil: new Date('2035-01-01') });
    const changed = await request('client', '/bookings', { staffId: '__no_preference__', salonId: 'salon-1', serviceId: 'service-1', startTime: '2030-01-03T10:00:00', couponId: 'coupon-2', expectedOriginalAmountFen: 12000, expectedPayableAmountFen: 10000 }, 'POST');
    expect(changed.status).toBe(409);
    expect(changed.body).toMatchObject({ code: 'BOOKING_PRICE_CHANGED', quote: { originalAmountFen: 8000, couponDiscountFen: 0 } });
    expect((await UserCoupon.findOne({ id: 'coupon-2' }).lean()).reservedBookingId).toBe('');
  });

  test('rescheduling rolls back if persistent notification fails, then commits time, occupancy and message together', async () => {
    const original = await Booking.findOne({ id: bookingId }).lean();
    const messageCount = await BookingMessage.countDocuments();
    const failure = jest.spyOn(BookingMessage, 'create').mockRejectedValueOnce(new Error('Injected notification write failure'));
    try {
      expect((await request('merchant', `/merchant/bookings/${bookingId}`, { action: 'reschedule', startTime: '2030-01-01T11:00:00+08:00' }, 'PATCH')).status).toBe(500);
    } finally { failure.mockRestore(); }
    expect((await Booking.findOne({ id: bookingId }).lean()).startTime).toEqual(original.startTime);
    expect((await SlotOccupancy.findOne({ bookingId }).lean()).slots).toEqual(occupiedSlotStarts(original.startTime, 60));
    expect(await BookingMessage.countDocuments()).toBe(messageCount);
    const updated = await request('merchant', `/merchant/bookings/${bookingId}`, { action: 'reschedule', startTime: '2030-01-01T11:00:00+08:00' }, 'PATCH');
    expect(updated.status).toBe(200);
    const notifications = await request('client', '/booking-messages?page=1&limit=20');
    expect(notifications.body.find(message => message.type === 'reschedule')).toMatchObject({ bookingId, startTime: '2030-01-01T03:00:00.000Z' });
    expect(notifications.body.find(message => message.type === 'reschedule').userMessage).toContain('改期至 2030-01-01 11:00');
  });

  test('merchant availability excludes its own booking and uses historical duration after the service changes', async () => {
    await Salon.updateOne({ id: 'salon-1' }, { $set: { 'services.0.durationMinutes': 180 } });
    await Booking.create({ id: 'other-slot', userId: 'client-1', salonId: 'salon-1', staffId: 'staff-1', serviceId: 'service-1', status: 'accepted', startTime: new Date('2030-01-01T12:00:00+08:00'), serviceDurationMinutes: 30 });
    await SlotOccupancy.create({ bookingId: 'other-slot', staffId: 'staff-1', startTime: new Date('2030-01-01T12:00:00+08:00'), slots: occupiedSlotStarts('2030-01-01T12:00:00+08:00', 30) });
    const slots = await request('merchant', `/merchant/bookings/${bookingId}/slots?date=2030-01-01`);
    expect(slots.status).toBe(200);
    expect(slots.body.find(slot => slot.time === '10:00').isAvailable).toBe(true);
    expect(slots.body.find(slot => slot.time === '10:30').isAvailable).toBe(true);
    expect(slots.body.find(slot => slot.time === '11:30').isAvailable).toBe(false);
    const scope = await request('merchant', '/merchant/bookings?fromDate=2030-01-02&toDate=2030-01-03&includePending=true&statuses=pending&page=1&limit=1');
    expect(scope.status).toBe(200);
    expect(Number(scope.total)).toBeGreaterThanOrEqual(2);
    expect(scope.body).toHaveLength(1);
    const summary = await request('merchant', '/merchant/bookings/summary?fromDate=2030-01-02&toDate=2030-01-03&includePending=true');
    expect(summary.body.counts.pending).toBeGreaterThanOrEqual(2);
    expect((await request('client', `/merchant/bookings/${bookingId}/slots?date=2030-01-01`)).status).toBe(401);
  });

  test('new merchant readers do not disclose another salon orders or schedule', async () => {
    sessions.otherMerchant = createSession();
    await Salon.create({ id: 'salon-2', name: 'Other salon', staffIds: [] });
    await MerchantUser.create({ id: 'merchant-2', username: 'other-merchant', salonId: 'salon-2',
      passwordHash: 'fixture-hash', passwordSalt: 'fixture-salt',
      sessionTokenHash: sessions.otherMerchant.tokenHash, sessionExpiresAt: sessions.otherMerchant.expiresAt });
    expect((await request('otherMerchant', `/merchant/bookings/${bookingId}/slots?date=2030-01-01`)).status).toBe(404);
    const list = await request('otherMerchant', '/merchant/bookings?includePending=true&page=1&limit=20');
    expect(list.body).toEqual([]);
    expect(list.total).toBe('0');
    expect((await request('otherMerchant', '/merchant/bookings/summary?includePending=true')).body.counts).toEqual({});
  });

  test('staff scores average only approved technique scores while salon scores retain the overall rating', async () => {
    const staffId = 'technique-score-staff';
    const salonId = 'technique-score-salon';
    await StaffProfile.create({ id: staffId, name: 'Technique stylist', roleId: 'designer' });
    await Salon.create({ id: salonId, name: 'Technique salon', publishStatus: 'online', staffIds: [staffId] });
    await Booking.create([
      { status: 'approved', rating: 4.5, technique: 3 },
      { status: 'approved', rating: 4.75, technique: 4 },
      { status: 'approved', rating: 5 },
      { status: 'pending', rating: 1, technique: 1 },
      { status: 'rejected', rating: 1, technique: 1 },
    ].map((item, i) => ({
      id: `technique-score-booking-${i}`, salonId, staffId, serviceId: 'service',
      startTime: new Date('2030-01-01'),
      review: {
        id: `technique-score-review-${i}`, rating: item.rating, reviewStatus: item.status,
        ...(item.technique === undefined ? {} : {
          ratings: { environment: 5, technique: item.technique, service: 5, price: 5 },
        }),
        pendingEdit: {
          rating: 1, reviewStatus: 'pending',
          ratings: { environment: 1, technique: 1, service: 1, price: 1 },
        },
      },
    })));
    await refreshStaffRatingSummaries([staffId]);
    const staff = await request('client', `/staff/${staffId}`);
    expect(staff.status).toBe(200);
    expect(staff.body).toMatchObject({ rating: 3.5, reviewCount: 3 });
    const salon = await request('client', `/salons/${salonId}`);
    expect(salon.status).toBe(200);
    expect(salon.body).toMatchObject({ rating: 4.75, reviewCount: 3 });
    expect(salon.body.staff[0]).toMatchObject({ id: staffId, rating: 3.5, reviewCount: 3 });
    const reviews = await request('client', `/staff/${staffId}/reviews`);
    expect(reviews.body.total).toBe(3);
    expect(reviews.body.items.map(review => review.rating).sort()).toEqual([4.5, 4.75, 5]);
    const { buildMerchantSalonPayload } = require('../../index');
    const merchant = await buildMerchantSalonPayload(salonId);
    expect(merchant.staff[0]).toMatchObject({ id: staffId, rating: 3.5, reviewCount: 3 });
    const stored = await Booking.find({ staffId, 'review.reviewStatus': 'approved' });
    const { buildStaffPayload } = require('../services/salon');
    expect(buildStaffPayload({ id: staffId }, stored.map(booking => booking.review))).toMatchObject({
      rating: 3.5, reviewCount: 3,
    });
    const emptyStaffId = 'technique-score-empty-staff';
    await StaffProfile.create({ id: emptyStaffId, name: 'Unrated stylist', roleId: 'designer' });
    await Salon.create({ id: 'technique-score-empty-salon', name: 'Unrated salon',
      publishStatus: 'online', staffIds: [emptyStaffId] });
    const emptySalon = await request('client', '/salons/technique-score-empty-salon');
    expect(emptySalon.body.staff[0]).toMatchObject({ rating: null, reviewCount: 0 });
    expect((await request('client', `/staff/${emptyStaffId}`)).body).toMatchObject({ rating: null, reviewCount: 0 });
  });

  test('public review pages cover more than the legacy cap, count every category and keep detail payloads to a preview', async () => {
    const staffId = 'review-pages-staff';
    await StaffProfile.create({ id: staffId, name: 'Reviews stylist', roleId: 'designer' });
    await Salon.create({ id: 'review-pages-salon', name: 'Reviews salon', publishStatus: 'online', staffIds: [staffId] });
    await Salon.create({ id: 'review-pages-empty', name: 'Empty salon', publishStatus: 'online', staffIds: [] });
    await Salon.create({ id: 'review-pages-offline', name: 'Offline salon', publishStatus: 'offline', staffIds: [staffId] });
    const ratings = [1, 2, 2.5, 3, 3.5, 4, 5];
    const documents = await Booking.create(Array.from({ length: 165 }, (_, i) => ({
      id: `review-pages-booking-${i}`, userId: 'client-1', salonId: 'review-pages-salon', staffId,
      staffName: 'Reviews stylist', serviceId: 'review-pages-service', startTime: new Date('2030-01-01'),
      review: { id: `review-pages-${i}`, rating: ratings[i % ratings.length], reviewStatus: 'approved',
        createdAt: new Date(Date.UTC(2030, 0, 1, 0, Math.min(i, 163))),
        imageUrls: i % 3 === 0 ? [`https://example.com/review-${i}.jpg`] : [],
        tags: i % 2 === 0 ? ['善于沟通', '未知标签'] : ['环境舒适'],
        pendingEdit: { id: 'private-edit', rating: 1, comment: 'private edit', reviewStatus: 'pending', imageUrls: ['https://example.com/private.jpg'], tags: ['技术一流'] },
        pendingMerchantReply: { content: 'private reply', reviewStatus: 'pending' },
        merchantReply: { content: 'unapproved reply', reviewStatus: 'pending' },
      },
    })));
    await Booking.create(['pending', 'rejected'].map(status => ({
      id: `review-pages-${status}`, staffId, serviceId: 'service', startTime: new Date('2030-01-01'),
      review: { id: status, rating: 1, reviewStatus: status, imageUrls: ['https://example.com/unapproved.jpg'], tags: ['善于沟通'] },
    })));
    await refreshStaffRatingSummaries([staffId]);
    const counts = { all: 165,
      negative: documents.filter(doc => doc.review.rating < 3).length,
      neutral: documents.filter(doc => doc.review.rating >= 3 && doc.review.rating < 4).length,
      photos: documents.filter(doc => doc.review.imageUrls.length).length };
    const expected = [...documents].sort((a, b) => b.review.createdAt - a.review.createdAt || String(b._id).localeCompare(String(a._id)));
    const seen = [];
    const reviewTags = [{ name: '善于沟通', count: 83 }, { name: '环境舒适', count: 82 }];
    for (let page = 1; page <= 17; page++) {
      const result = await request('client', `/salons/review-pages-salon/reviews?page=${page}&limit=10`);
      expect(result.status).toBe(200);
      expect(result.body.counts).toEqual(counts);
      expect(result.body.reviewTags).toEqual(reviewTags);
      expect(result.body.total).toBe(165);
      expect(result.body.items).toHaveLength(page === 17 ? 5 : 10);
      expect(result.body.hasMore).toBe(page < 17);
      seen.push(...result.body.items.map(review => review.id));
      for (const review of result.body.items) {
        expect(review.pendingEdit).toBeUndefined(); expect(review.pendingMerchantReply).toBeUndefined();
        expect(review.merchantReply).toBeUndefined(); expect(review.userId).toBeUndefined();
      }
    }
    expect(seen).toEqual(expected.map(doc => doc.review.id));
    for (const filter of ['negative', 'neutral', 'photos']) {
      const matches = doc => filter === 'photos' ? doc.review.imageUrls.length > 0
        : filter === 'negative' ? doc.review.rating < 3 : doc.review.rating >= 3 && doc.review.rating < 4;
      const filteredIds = [];
      for (let page = 1; page <= Math.ceil(counts[filter] / 10); page++) {
        const result = await request('client', `/salons/review-pages-salon/reviews?filter=${filter}&page=${page}&limit=10`);
        expect(result.status).toBe(200); expect(result.body.counts).toEqual(counts); expect(result.body.total).toBe(counts[filter]);
        expect(result.body.reviewTags).toEqual(reviewTags);
        expect(result.body.hasMore).toBe(page * 10 < counts[filter]);
        filteredIds.push(...result.body.items.map(review => review.id));
      }
      expect(filteredIds).toEqual(expected.filter(matches).map(doc => doc.review.id));
      const empty = await request('client', `/salons/review-pages-salon/reviews?filter=${filter}&page=100&limit=10`);
      expect(empty.body.items).toEqual([]); expect(empty.body.hasMore).toBe(false); expect(empty.body.counts).toEqual(counts);
    }
    // Salon detail previews the newest reviews in list order; staff entries carry only rating summaries.
    const detail = await request('client', '/salons/review-pages-salon');
    expect(detail.status).toBe(200); expect(detail.body.reviewCount).toBe(165);
    expect(detail.body.reviews.map(review => review.id)).toEqual(expected.slice(0, 3).map(doc => doc.review.id));
    expect(detail.body.reviewTags).toEqual(reviewTags);
    expect(detail.body.staff).toHaveLength(1);
    expect(detail.body.staff[0]).toMatchObject({ id: staffId, reviewCount: 165 });
    expect(detail.body.staff[0].reviews).toBeUndefined();
    // Staff detail no longer embeds reviews; they are paginated per staff member.
    const staffDetail = await request('client', `/staff/${staffId}`);
    expect(staffDetail.status).toBe(200); expect(staffDetail.body.reviewCount).toBe(165);
    expect(staffDetail.body.rating).toBeNull();
    expect(staffDetail.body.reviews).toBeUndefined(); expect(staffDetail.body.salonStaff).toBeUndefined();
    expect(staffDetail.body.salonId).toBe('review-pages-salon');
    const staffSeen = [];
    for (let page = 1; page <= 17; page++) {
      const result = await request('client', `/staff/${staffId}/reviews?page=${page}&limit=10`);
      expect(result.status).toBe(200); expect(result.body.total).toBe(165);
      expect(result.body.hasMore).toBe(page < 17);
      for (const review of result.body.items) {
        expect(review.pendingEdit).toBeUndefined(); expect(review.userId).toBeUndefined();
      }
      staffSeen.push(...result.body.items.map(review => review.id));
    }
    expect(staffSeen).toEqual(expected.map(doc => doc.review.id));
    expect((await request('client', '/staff/missing-staff/reviews')).status).toBe(404);
    const empty = await request('client', '/salons/review-pages-empty/reviews?filter=photos');
    expect(empty.body).toMatchObject({ items: [], page: 1, limit: 10, total: 0, hasMore: false, counts: { all: 0, negative: 0, neutral: 0, photos: 0 } });
    expect(empty.body.reviewTags).toEqual([]);
    expect((await request('client', '/salons/review-pages-offline/reviews')).status).toBe(404);
    expect((await request('client', '/salons/missing/reviews')).status).toBe(404);
    expect((await request('client', '/salons/review-pages-salon/reviews?filter=unknown')).status).toBe(400);
    const bounded = await request('client', '/salons/review-pages-salon/reviews?page=0&limit=1000');
    expect(bounded.body.page).toBe(1); expect(bounded.body.limit).toBe(50); expect(bounded.body.items).toHaveLength(50);
  });

  test('helpful feedback persists once per user, is private to the viewer and survives concurrent retries', async () => {
    await StaffProfile.create({ id: 'helpful-staff', name: 'Helpful stylist', roleId: 'designer' });
    await Salon.create({ id: 'helpful-salon', name: 'Helpful salon', publishStatus: 'online', staffIds: ['helpful-staff'] });
    await Booking.create({ id: 'helpful-booking', staffId: 'helpful-staff', serviceId: 'helpful-service', startTime: new Date('2030-01-01'),
      review: { id: 'helpful-review', rating: 5, reviewStatus: 'approved', createdAt: new Date() } });
    sessions.reviewer = createSession();
    await ClientUser.create({ id: 'reviewer-2', account: '13800000002', authProvider: 'wechat', displayName: 'Second reviewer',
      sessionTokenHash: sessions.reviewer.tokenHash, sessionExpiresAt: sessions.reviewer.expiresAt });
    const route = '/bookings/helpful-booking/review/helpful';
    const before = await request('client', '/salons/helpful-salon/reviews');
    expect(before.body.items[0]).toMatchObject({ helpfulCount: 0, helpful: false });
    const anonymousPost = await fetch(`${baseUrl}/api${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reviewId: 'helpful-review' }) });
    expect(anonymousPost.status).toBe(401);
    const writes = await Promise.all(Array.from({ length: 6 }, () => request('client', route, { reviewId: 'helpful-review', userId: 'forged' }, 'POST')));
    for (const result of writes) {
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ bookingId: 'helpful-booking', reviewId: 'helpful-review', helpfulCount: 1, helpful: true });
    }
    expect(await ReviewHelpful.countDocuments({ bookingId: 'helpful-booking' })).toBe(1);
    const one = await ReviewHelpful.findOne({ bookingId: 'helpful-booking' }).lean();
    expect(one.userId).toBe('client-1');
    const firstViewer = await request('client', '/salons/helpful-salon');
    expect(firstViewer.body.reviews[0]).toMatchObject({ helpfulCount: 1, helpful: true });
    const otherViewer = await request('reviewer', '/salons/helpful-salon');
    expect(otherViewer.body.reviews[0]).toMatchObject({ helpfulCount: 1, helpful: false });
    expect((await request('client', '/staff/helpful-staff/reviews')).body.items[0]).toMatchObject({ helpfulCount: 1, helpful: true });
    expect((await request('reviewer', '/staff/helpful-staff/reviews')).body.items[0]).toMatchObject({ helpfulCount: 1, helpful: false });
    expect((await request('reviewer', route, { reviewId: 'helpful-review' }, 'POST')).body.helpfulCount).toBe(2);
    expect((await request('client', route, { reviewId: 'helpful-review' }, 'POST')).body.helpfulCount).toBe(2);
    const anonymous = await fetch(`${baseUrl}/api/salons/helpful-salon/reviews`);
    expect(anonymous.headers.get('cache-control')).toBe('private, no-store');
    const anonymousReview = (await anonymous.json()).items[0];
    expect(anonymousReview).toMatchObject({ helpfulCount: 2, helpful: false });
    expect(anonymousReview.userId).toBeUndefined();
    const invalidToken = await fetch(`${baseUrl}/api/salons/helpful-salon`, { headers: { Authorization: 'Bearer invalid' } });
    expect(invalidToken.status).toBe(200);
    expect((await invalidToken.json()).reviews[0]).toMatchObject({ helpfulCount: 2, helpful: false });
    expect((await request('client', route, {}, 'POST')).status).toBe(400);
    expect((await request('client', route, { reviewId: 'old-review' }, 'POST')).status).toBe(404);
    await Salon.updateOne({ id: 'helpful-salon' }, { $set: { publishStatus: 'offline' } });
    expect((await request('client', route, { reviewId: 'helpful-review' }, 'POST')).status).toBe(404);
    await Salon.updateOne({ id: 'helpful-salon' }, { $set: { publishStatus: 'online' } });
    await Booking.updateOne({ id: 'helpful-booking' }, { $set: { 'review.reviewStatus': 'pending' } });
    expect((await request('client', route, { reviewId: 'helpful-review' }, 'POST')).status).toBe(404);
    await Booking.updateOne({ id: 'helpful-booking' }, { $set: { 'review.id': 'new-review', 'review.reviewStatus': 'approved' } });
    const replaced = await request('client', '/salons/helpful-salon/reviews');
    expect(replaced.body.items[0]).toMatchObject({ id: 'new-review', helpfulCount: 0, helpful: false });
    expect((await request('client', route, { reviewId: 'new-review' }, 'POST')).body.helpfulCount).toBe(1);
  });

  test('current salon requests keep two-decimal averages in distance and rating order', async () => {
    await StaffProfile.create({ id: 'precision-staff', name: 'Precision stylist', roleId: 'designer' });
    await Salon.create({
      id: 'precision-salon', name: 'Precision salon', publishStatus: 'online',
      staffIds: ['precision-staff'],
      location: { latitude: 39.9042, longitude: 116.4074 },
      geoLocation: { type: 'Point', coordinates: [116.4074, 39.9042] },
    });
    await Booking.create([5, 5, 4].map((rating, index) => ({
      id: `precision-booking-${index}`, salonId: 'precision-salon', staffId: 'precision-staff',
      serviceId: 'precision-service', startTime: new Date('2030-02-01T02:00:00Z'),
      review: { id: `precision-review-${index}`, rating, reviewStatus: 'approved',
        ratings: { environment: rating, technique: rating, service: rating, price: rating } },
    })));
    await refreshStaffRatingSummaries(['precision-staff']);
    for (const sort of ['', '&sort=rating']) {
      const result = await request('client', `/salons?latitude=39.9042&longitude=116.4074&page=1&limit=10${sort}`);
      expect(result.status).toBe(200);
      expect(result.body.find(salon => salon.id === 'precision-salon')).toMatchObject({
        rating: 4.67, reviewCount: 3,
      });
    }
    // A mean of 4.125 must round the same way in JS details and MongoDB sorting.
    await Booking.create([4, 4, 4, 4, 3].map((rating, index) => ({
      id: `precision-half-booking-${index}`, salonId: 'precision-salon', staffId: 'precision-staff',
      serviceId: 'precision-service', startTime: new Date('2030-02-02T02:00:00Z'),
      review: { id: `precision-half-review-${index}`, rating, reviewStatus: 'approved',
        ratings: { environment: rating, technique: rating, service: rating, price: rating } },
    })));
    await refreshStaffRatingSummaries(['precision-staff']);
    for (const sort of ['', '&sort=rating']) {
      const result = await request('client', `/salons?latitude=39.9042&longitude=116.4074&page=1&limit=10${sort}`);
      expect(result.status).toBe(200);
      expect(result.body.find(salon => salon.id === 'precision-salon')).toMatchObject({
        rating: 4.13, reviewCount: 8,
      });
    }
    const detail = await request('client', '/salons/precision-salon');
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ rating: 4.13, reviewCount: 8 });
    expect(detail.body.staff[0]).toMatchObject({ rating: 4.13, reviewCount: 8 });
  });

  test('automatic completion uses saved duration and commits coupon, occupancy and notification', async () => {
    const now = new Date('2029-01-03T10:00:00Z');
    const startTime = new Date('2029-01-03T08:30:00Z');
    await Booking.create([
      { id: 'auto-due', userId: 'client-1', salonId: 'salon-1', serviceId: 'service-1',
        status: 'accepted', startTime, serviceDurationMinutes: 90, couponId: 'auto-coupon' },
      { id: 'auto-waiting', serviceId: 'service-1', status: 'accepted',
        startTime, serviceDurationMinutes: 120 },
      { id: 'auto-legacy', serviceId: 'service-1', status: 'accepted',
        startTime: new Date('2029-01-02T10:00:00Z') },
    ]);
    await UserCoupon.create({ id: 'auto-coupon', userId: 'client-1', campaignKey: 'fixture',
      couponType: 'auto', minimumSpendFen: 0, discountFen: 1000, title: 'Auto completion coupon',
      grantedAt: startTime, validFrom: new Date('2029-01-01'), validUntil: new Date('2035-01-01'),
      reservedBookingId: 'auto-due', reservedAt: startTime });
    await SlotOccupancy.create({ bookingId: 'auto-due', staffId: 'auto-staff',
      startTime, slots: occupiedSlotStarts(startTime, 90) });
    const broadcastBookingEvent = jest.fn();
    const dependencies = { mongoose, ...models, broadcastBookingEvent };
    expect(await completeDueBookings(dependencies, now)).toBe(2);
    expect(await Booking.findOne({ id: 'auto-due' }).lean()).toMatchObject({ couponRedeemedAt: now, completionSource: 'automatic', completedAt: now });
    expect((await Booking.findOne({ id: 'auto-waiting' }).lean()).status).toBe('accepted');
    expect((await Booking.findOne({ id: 'auto-legacy' }).lean()).status).toBe('completed');
    expect(await SlotOccupancy.countDocuments({ bookingId: 'auto-due' })).toBe(0);
    expect(await UserCoupon.findOne({ id: 'auto-coupon' }).lean()).toMatchObject({
      redeemedBookingId: 'auto-due', redeemedAt: now,
    });
    expect(await BookingMessage.countDocuments({ bookingId: 'auto-due', status: 'completed' })).toBe(1);
    expect(broadcastBookingEvent).toHaveBeenCalledTimes(2);
    expect(await completeDueBookings(dependencies, now)).toBe(0);
  });

  test('released merchant complete and legacy complaint requests work with completion provenance and feedback handling', async () => {
    const id = 'completion-feedback-legacy';
    const timestamp = new Date('2028-01-01');
    await Booking.create({ id, userId: 'client-1', salonId: 'salon-1', staffId: 'staff-1',
      serviceId: 'service-1', serviceName: 'Cut', status: 'accepted', startTime: timestamp,
      originalAmountFen: 8000, payableAmountFen: 7000, couponDiscountFen: 1000,
      createdAt: timestamp, updatedAt: timestamp });
    expect((await request('merchant', `/merchant/bookings/${id}`, { action: 'complete', reason: '' }, 'PATCH')).status).toBe(200);
    const completed = await Booking.findOne({ id }).lean();
    expect(completed.completionSource).toBe('merchant');
    expect(completed.completedAt).toBeInstanceOf(Date);
    expect((await request('client', `/bookings/${id}`)).body.completionSource).toBe('merchant');
    expect((await request('client', `/bookings/${id}/complaint`, { description: '订单有问题', imageObjects: [] }, 'POST')).status).toBe(201);
    const before = await Booking.findOne({ id }).lean();
    expect(before.complaint).toMatchObject({ reason: 'other', status: 'submitted' });
    expect((await request('merchant', `/merchant/bookings/${id}`, { action: 'cancel', reason: '纠正' }, 'PATCH')).status).toBe(409);
    for (const response of ['', 'x'.repeat(2001), {}]) {
      expect((await request('admin', `/admin/complaints/${id}`, { response }, 'PATCH')).status).toBe(400);
    }
    expect((await request('client', `/admin/complaints/${id}`, { response: '越权处理' }, 'PATCH')).status).toBe(401);
    const messagesBefore = await BookingMessage.countDocuments({ bookingId: id });
    const failure = jest.spyOn(BookingMessage, 'create').mockRejectedValueOnce(new Error('Injected complaint notification failure'));
    try {
      expect((await request('admin', `/admin/complaints/${id}`, { response: '应回滚' }, 'PATCH')).status).toBe(500);
    } finally { failure.mockRestore(); }
    expect(await Booking.findOne({ id }).lean()).toEqual(before);
    expect(await BookingMessage.countDocuments({ bookingId: id })).toBe(messagesBefore);
    const replies = await Promise.all([1, 2].map(() => request('admin', `/admin/complaints/${id}`, { response: '已核实双方情况，记录处理结果' }, 'PATCH')));
    expect(replies.map(item => item.status).sort()).toEqual([200, 409]);
    const after = await Booking.findOne({ id }).lean();
    expect({ ...after, complaint: before.complaint }).toEqual(before);
    expect(after.complaint).toMatchObject({ status: 'handled', response: '已核实双方情况，记录处理结果', reviewStatus: 'pending' });
    expect(after.complaint.handledAt).toBeInstanceOf(Date);
    expect(await BookingMessage.countDocuments({ bookingId: id, type: 'complaint_handled' })).toBe(1);
    const detail = await request('client', `/bookings/${id}`);
    expect(detail.body.complaint).toMatchObject({ status: 'handled', response: after.complaint.response });
    // Content moderation does not erase the separate handling result or remove it from the complaint list.
    expect((await request('admin', '/admin/user-images', { bookingId: id, type: 'complaint', action: 'approve' }, 'PATCH')).status).toBe(200);
    const list = await request('admin', '/admin/complaints?page=1&limit=100');
    expect(list.body.find(row => row.bookingId === id)).toMatchObject({ handlingStatus: 'handled', response: after.complaint.response });
    const messages = await request('client', '/booking-messages?page=1&limit=100');
    expect(messages.body.find(row => row.bookingId === id && row.type === 'complaint_handled').userMessage).toContain('处理结果');
  });

  test('stale complaint content moderation preserves a concurrently saved processing response', async () => {
    const id = 'completion-complaint-moderation-race';
    await Booking.create({ id, userId: 'client-1', serviceId: 'service-1', status: 'completed',
      startTime: new Date('2028-01-01'), complaint: { id: 'race-issue', description: '订单问题', status: 'submitted', reviewStatus: 'pending' } });
    const stale = await Booking.findOne({ id });
    const handlerTime = new Date();
    const intercepted = jest.spyOn(Booking, 'findOne').mockImplementationOnce(async () => {
      await Booking.updateOne({ id }, { $set: { 'complaint.status': 'handled', 'complaint.response': '并发处理意见', 'complaint.handledAt': handlerTime } });
      return stale;
    });
    try {
      expect((await request('admin', '/admin/user-images', { bookingId: id, type: 'complaint', action: 'approve' }, 'PATCH')).status).toBe(200);
    } finally { intercepted.mockRestore(); }
    expect((await Booking.findOne({ id }).lean()).complaint).toMatchObject({
      status: 'handled', response: '并发处理意见', handledAt: handlerTime, reviewStatus: 'approved',
    });
    // Even released clients cannot overwrite the processing result after content rejection.
    expect((await request('admin', '/admin/user-images', { bookingId: id, type: 'complaint', action: 'reject' }, 'PATCH')).status).toBe(200);
    expect((await request('client', `/bookings/${id}/complaint`, { description: '重新提交', imageObjects: [] }, 'POST')).status).toBe(409);
  });

  test.each(['not_arrived', 'service_incomplete', 'other'])('completion feedback validates owner, reason and duplicate submission: %s', async reason => {
    const id = `completion-issue-${reason}`;
    await Booking.create({ id, userId: 'client-1', salonId: 'salon-1', serviceId: 'service-1',
      status: 'completed', startTime: new Date('2028-01-01'), completionSource: 'automatic' });
    const input = { reason, description: '实际情况与订单不一致', imageObjects: [] };
    await Booking.updateOne({ id }, { $set: { userId: 'another-user' } });
    expect((await request('client', `/bookings/${id}/complaint`, input, 'POST')).status).toBe(403);
    await Booking.updateOne({ id }, { $set: { userId: 'client-1' } });
    for (const invalid of ['fake', null, {}, ['other']]) {
      expect((await request('client', `/bookings/${id}/complaint`, { ...input, reason: invalid }, 'POST')).status).toBe(400);
    }
    expect((await request('client', `/bookings/${id}/complaint`, input, 'POST')).status).toBe(201);
    expect((await request('client', `/bookings/${id}/complaint`, input, 'POST')).status).toBe(409);
    expect((await request('client', `/bookings/${id}`)).body.complaint.reason).toBe(reason);
  });

  test.each(['cancel', 'no_show'])('merchant corrects automatic completion with %s atomically using the released request body', async action => {
    const id = `correct-auto-${action}`;
    const startTime = new Date('2028-01-01T01:00:00Z');
    await Booking.create({ id, userId: 'client-1', salonId: 'salon-1', staffId: 'staff-1',
      serviceId: 'service-1', status: 'accepted', startTime, createdAt: new Date('2034-01-01'), serviceDurationMinutes: 60,
      servicePriceFen: 8000, originalAmountFen: 8000, payableAmountFen: 7000,
      couponId: id, couponCode: 'SAVE10', couponTitle: 'Save 10', couponDiscountFen: 1000 });
    await UserCoupon.create({ id, userId: 'client-1', campaignKey: 'fixture', couponType: id,
      minimumSpendFen: 0, discountFen: 1000, title: 'Correction coupon',
      grantedAt: startTime, validFrom: startTime, validUntil: new Date('2035-01-01'),
      reservedBookingId: id, reservedAt: startTime });
    await completeDueBookings({ mongoose, ...models, broadcastBookingEvent() {} }, new Date('2028-01-02'));
    expect((await Booking.findOne({ id }).lean()).status).toBe('completed');
    expect((await UserCoupon.findOne({ id }).lean()).redeemedBookingId).toBe(id);
    const policyBefore = (await UserPolicy.findOne({ userId: 'client-1' }).lean())?.noShowCount || 0;
    const body = { action, reason: action === 'cancel' ? '用户要求取消' : '用户未到店' };
    expect((await request('otherMerchant', `/merchant/bookings/${id}`, body, 'PATCH')).status).toBe(404);
    const failure = jest.spyOn(BookingMessage, 'create').mockRejectedValueOnce(new Error('Injected correction message failure'));
    try {
      expect((await request('merchant', `/merchant/bookings/${id}`, body, 'PATCH')).status).toBe(500);
    } finally { failure.mockRestore(); }
    expect((await Booking.findOne({ id }).lean()).status).toBe('completed');
    expect((await UserCoupon.findOne({ id }).lean()).redeemedBookingId).toBe(id);
    expect((await UserPolicy.findOne({ userId: 'client-1' }).lean())?.noShowCount || 0).toBe(policyBefore);
    const attempts = await Promise.all([1, 2].map(() => request('merchant', `/merchant/bookings/${id}`, body, 'PATCH')));
    expect(attempts.map(result => result.status).sort()).toEqual([200, 409]);
    const status = action === 'cancel' ? 'canceled' : 'no_show';
    const updated = attempts.find(result => result.status === 200).body.booking;
    expect(updated).toMatchObject({ id, status, rejectReason: body.reason, couponId: '', couponDiscountFen: 0, payableAmountFen: 8000, couponRedeemedAt: null });
    const coupon = await UserCoupon.findOne({ id }).lean();
    for (const field of ['reservedAt', 'reservedBookingId', 'redeemedAt', 'redeemedBookingId', 'redeemedSalonId', 'redeemedMerchantId']) {
      expect(coupon[field]).toBeFalsy();
    }
    expect(await BookingMessage.countDocuments({ bookingId: id, type: action })).toBe(1);
    expect((await UserPolicy.findOne({ userId: 'client-1' }).lean())?.noShowCount || 0).toBe(policyBefore + (action === 'no_show' ? 1 : 0));
    expect((await request('client', `/bookings/${id}`)).body).toMatchObject({ id, status });
    const merchant = await request('merchant', `/merchant/bookings?statuses=canceled,no_show&page=1&limit=100`);
    expect(merchant.body.find(row => row.id === id).status).toBe(status);
    const summary = await request('merchant', '/merchant/bookings/summary');
    expect(summary.body.counts[status]).toBeGreaterThanOrEqual(1);
    const admin = await request('admin', '/admin/bookings?page=1&limit=100');
    expect(admin.body.find(row => row.id === id).status).toBe(status);
    const messages = await request('client', '/booking-messages?page=1&limit=100');
    expect(messages.body.find(row => row.bookingId === id && row.type === action).status).toBe(status);
    expect((await request('merchant', `/merchant/bookings/${id}`, body, 'PATCH')).status).toBe(409);
  });

  test.each([
    { reviewed: true }, { review: { id: 'review', reviewStatus: 'rejected' } },
    { complained: true }, { complaint: { id: 'complaint', reviewStatus: 'rejected' } },
  ])('completed booking feedback prevents merchant correction: %j', async feedback => {
    const id = `protected-${crypto.randomUUID()}`;
    await Booking.create({ id, userId: 'client-1', salonId: 'salon-1', serviceId: 'service-1',
      status: 'completed', startTime: new Date('2028-01-01'), ...feedback });
    for (const action of ['cancel', 'no_show']) {
      const response = await request('merchant', `/merchant/bookings/${id}`, { action, reason: '用户未到店' }, 'PATCH');
      expect(response.status).toBe(409);
      expect(response.body.message).toContain('评价或投诉');
    }
    expect((await Booking.findOne({ id }).lean()).status).toBe('completed');
    expect(await BookingMessage.countDocuments({ bookingId: id })).toBe(0);
  });

  test('released accepted no-show and completed corrections blacklist only at three distinct bookings', async () => {
    for (let index = 1; index <= 3; index += 1) {
      const id = `no-show-threshold-${index}`;
      await Booking.create({ id, userId: 'no-show-threshold-user', salonId: 'salon-1', serviceId: 'service-1',
        status: index === 1 ? 'accepted' : 'completed', startTime: new Date('2028-01-01') });
      const body = { action: 'no_show', reason: '用户未到店' };
      const result = await request('merchant', `/merchant/bookings/${id}`, body, 'PATCH');
      expect(result.status).toBe(200);
      expect(result.body.userPolicy).toMatchObject({ noShowCount: index, isBlacklisted: index === 3 });
      expect((await request('merchant', `/merchant/bookings/${id}`, body, 'PATCH')).status).toBe(409);
      expect((await UserPolicy.findOne({ userId: 'no-show-threshold-user' }).lean()).noShowCount).toBe(index);
    }
  });

  test('feedback arriving after merchant precheck is preserved by the transaction predicate', async () => {
    const id = 'correct-feedback-race';
    await Booking.create({ id, userId: 'client-1', salonId: 'salon-1', serviceId: 'service-1',
      status: 'completed', startTime: new Date('2028-01-01') });
    const original = Booking.findOneAndUpdate.bind(Booking);
    const race = jest.spyOn(Booking, 'findOneAndUpdate').mockImplementationOnce(async (filter, ...args) => {
      expect(filter).toMatchObject({ reviewed: { $ne: true }, review: null, complained: { $ne: true }, complaint: null });
      await Booking.updateOne({ id }, { $set: { complained: true, complaint: { id: 'racing-complaint' } } });
      return original(filter, ...args);
    });
    try {
      expect((await request('merchant', `/merchant/bookings/${id}`, { action: 'cancel', reason: '用户要求取消' }, 'PATCH')).status).toBe(409);
    } finally { race.mockRestore(); }
    expect(await Booking.findOne({ id }).lean()).toMatchObject({ status: 'completed', complained: true, complaint: { id: 'racing-complaint' } });
  });

  test('merchant appeal validates eligibility, ownership and input without changing completed orders', async () => {
    const body = { reason: 'no_show', description: '用户未到店，订单自动完成后出现评价，请核实。' };
    for (const [id, status, feedback] of [
      ['appeal-no-feedback', 'completed', {}],
      ['appeal-accepted', 'accepted', { reviewed: true }],
    ]) {
      await Booking.create({ id, status, salonId: 'salon-1', serviceId: 'service-1', startTime: new Date('2028-01-01'), ...feedback });
      expect((await request('merchant', `/merchant/bookings/${id}/appeal`, body, 'POST')).status).toBe(409);
    }
    await Booking.create({ id: 'appeal-validation', userId: 'client-1', status: 'completed', reviewed: true,
      salonId: 'salon-1', serviceId: 'service-1', startTime: new Date('2028-01-01') });
    for (const invalid of [
      {}, { ...body, reason: 'invalid' }, { ...body, description: '  ' },
      { ...body, description: ['text'] }, { ...body, description: 'a'.repeat(2001) },
    ]) {
      expect((await request('merchant', '/merchant/bookings/appeal-validation/appeal', invalid, 'POST')).status).toBe(400);
    }
    expect((await request('client', '/merchant/bookings/appeal-validation/appeal', body, 'POST')).status).toBe(401);
    expect((await request('otherMerchant', '/merchant/bookings/appeal-validation/appeal', body, 'POST')).status).toBe(404);
    expect((await request('merchant', '/merchant/bookings/missing/appeal', body, 'POST')).status).toBe(404);
    expect((await Booking.findOne({ id: 'appeal-validation' }).lean()).merchantAppeal).toBeUndefined();
  });

  test('appeal submission and admin response persist privately, reject duplicates and preserve all booking effects', async () => {
    const updatedAt = new Date('2028-01-01T10:00:00Z');
    const policyBefore = await UserPolicy.findOne({ userId: 'client-1' }).lean();
    const messagesBefore = await BookingMessage.countDocuments();
    for (const [index, feedback] of [
      { reviewed: true }, { review: { id: 'appeal-review', comment: '服务评价', reviewStatus: 'rejected' } },
      { complained: true }, { complaint: { id: 'appeal-complaint', description: '用户投诉', reviewStatus: 'pending' } },
    ].entries()) {
      const id = `appeal-success-${index}`;
      await Booking.create({ id, userId: 'client-1', userName: 'Client', salonId: 'salon-1', salonName: 'Salon',
        serviceId: 'service-1', status: 'completed', startTime: updatedAt, createdAt: updatedAt, updatedAt,
        couponId: 'appeal-coupon', couponDiscountFen: 1000, payableAmountFen: 7000, ...feedback });
      const before = await Booking.findOne({ id }).lean();
      const body = { reason: index % 2 ? 'other' : 'no_show', description: '  商家说明实际情况  ' };
      const attempts = await Promise.all([1, 2].map(() => request('merchant', `/merchant/bookings/${id}/appeal`, body, 'POST')));
      expect(attempts.map(result => result.status).sort()).toEqual([201, 409]);
      const appeal = attempts.find(result => result.status === 201).body.booking.merchantAppeal;
      expect(appeal).toMatchObject({ reason: body.reason, description: '商家说明实际情况', status: 'pending', merchantId: 'merchant-1' });
      const after = await Booking.findOne({ id }).lean();
      const { merchantAppeal, ...rest } = after;
      expect(rest).toEqual(before);
      expect((await request('client', `/bookings/${id}`)).body.merchantAppeal).toBeUndefined();
      const merchantRows = await request('merchant', '/merchant/bookings?statuses=completed&page=1&limit=100');
      expect(merchantRows.body.find(row => row.id === id).merchantAppeal.description).toBe('商家说明实际情况');
      expect((await request('merchant', `/merchant/bookings/${id}`, { action: 'no_show', reason: '用户未到店' }, 'PATCH')).status).toBe(409);
    }
    const page = await request('admin', '/admin/booking-appeals?page=1&limit=1');
    expect(page.status).toBe(200);
    expect(page.total).toBe('4');
    expect(page.body).toHaveLength(1);
    expect((await request('admin', '/admin/booking-appeals?page=2&limit=1')).body[0].bookingId).not.toBe(page.body[0].bookingId);
    expect((await request('merchant', '/admin/booking-appeals')).status).toBe(401);
    expect((await request('client', '/admin/booking-appeals')).status).toBe(401);
    const id = 'appeal-success-0';
    for (const response of ['', '  ', [], 'a'.repeat(2001)]) {
      expect((await request('admin', `/admin/booking-appeals/${id}`, { response }, 'PATCH')).status).toBe(400);
    }
    expect((await request('merchant', `/admin/booking-appeals/${id}`, { response: '自行处理' }, 'PATCH')).status).toBe(401);
    const handled = await Promise.all([1, 2].map(() => request('admin', `/admin/booking-appeals/${id}`, { response: '  已核实，请联系客服进一步处理。  ' }, 'PATCH')));
    expect(handled.map(result => result.status).sort()).toEqual([200, 409]);
    const result = await Booking.findOne({ id }).lean();
    expect(result).toMatchObject({ status: 'completed', reviewed: true, couponId: 'appeal-coupon', payableAmountFen: 7000, updatedAt });
    expect(result.merchantAppeal).toMatchObject({ status: 'handled', handledBy: 'admin-1', response: '已核实，请联系客服进一步处理。' });
    const merchantRows = await request('merchant', '/merchant/bookings?statuses=completed&page=1&limit=100');
    expect(merchantRows.body.find(row => row.id === id).merchantAppeal.status).toBe('handled');
    expect((await request('client', `/bookings/${id}`)).body.merchantAppeal).toBeUndefined();
    expect(await UserPolicy.findOne({ userId: 'client-1' }).lean()).toEqual(policyBefore);
    expect(await BookingMessage.countDocuments()).toBe(messagesBefore);
  });

  test.each(['approved', 'rejected'])('appeal review saves %s with its response and keeps old response-only requests compatible', async decision => {
    const id = `appeal-decision-${decision}`;
    const updatedAt = new Date('2028-01-01');
    await Booking.create({ id, userId: 'client-1', salonId: 'salon-1', serviceId: 'service-1',
      startTime: updatedAt, updatedAt, status: 'completed', reviewed: true,
      merchantAppeal: { reason: 'other', description: '请核实', status: 'pending', merchantId: 'merchant-1', submittedAt: new Date() } });
    for (const invalid of [null, '', 'handled', true, ['approved']]) {
      expect((await request('admin', `/admin/booking-appeals/${id}`, { decision: invalid, response: '说明' }, 'PATCH')).status).toBe(400);
    }
    expect((await Booking.findOne({ id }).lean()).merchantAppeal.status).toBe('pending');
    const attempts = await Promise.all([1, 2].map(() => request('admin', `/admin/booking-appeals/${id}`, { decision, response: `  ${decision}处理说明  ` }, 'PATCH')));
    expect(attempts.map(row => row.status).sort()).toEqual([200, 409]);
    const saved = await Booking.findOne({ id }).lean();
    expect(saved).toMatchObject({ status: 'completed', reviewed: true, updatedAt,
      merchantAppeal: { status: 'handled', decision, response: `${decision}处理说明`, handledBy: 'admin-1' } });
    const list = await request('admin', '/admin/booking-appeals?page=1&limit=100');
    expect(list.body.find(row => row.bookingId === id).decision).toBe(decision);
    const merchant = await request('merchant', '/merchant/bookings?statuses=completed&page=1&limit=100');
    expect(merchant.body.find(row => row.id === id).merchantAppeal.decision).toBe(decision);
    expect((await request('client', `/bookings/${id}`)).body.merchantAppeal).toBeUndefined();
    expect((await Booking.findOne({ id: 'appeal-success-0' }).lean()).merchantAppeal.decision).toBeUndefined();
  });

  test('legacy and four-dimension review contracts persist through moderation and all clients', async () => {
    sessions.dimensions = createSession();
    await ClientUser.create({ id: 'dimensions-client', username: 'dimensions-client', account: '13800000009',
      displayName: 'Dimensions', authProvider: 'wechat', sessionTokenHash: sessions.dimensions.tokenHash,
      sessionExpiresAt: sessions.dimensions.expiresAt });
    for (const legacy of [true, false]) {
      const id = `review-dimensions-${legacy}`;
      const ratings = { environment: 5, technique: 4, service: 3, price: 5 };
      await Booking.create({ id, userId: 'dimensions-client', salonId: 'salon-1', staffId: 'staff-1',
        serviceId: 'service-1', status: 'completed', startTime: new Date('2028-01-01') });
      const body = { rating: 5, comment: '服务体验很好', tags: ['善于沟通'], imageObjects: [] };
      if (!legacy) body.ratings = ratings;
      const created = await request('dimensions', `/bookings/${id}/review`, body, 'POST');
      expect(created.status).toBe(201);
      expect(created.body.review.rating).toBe(legacy ? 5 : 4.25);
      const saved = await Booking.findOne({ id }).lean();
      expect(saved.review.ratings).toEqual(legacy ? undefined : ratings);
      expect((await request('admin', '/admin/user-images', { bookingId: id, type: 'review', action: 'approve' }, 'PATCH')).status).toBe(200);
      for (const route of ['/auth/reviews?page=1&limit=100', '/salons/salon-1/reviews?page=1&limit=50']) {
        const result = await request('dimensions', route);
        const rows = Array.isArray(result.body) ? result.body : result.body.items;
        expect(rows.find(row => row.bookingId === id).ratings).toEqual(legacy ? undefined : ratings);
      }
      const merchant = await request('merchant', '/merchant/bookings?statuses=completed&page=1&limit=100');
      expect(merchant.body.find(row => row.id === id).review.rating).toBe(legacy ? 5 : 4.25);
      const editedRatings = { environment: 2, technique: 3, service: 4, price: 5 };
      const edited = await request('dimensions', `/bookings/${id}/review`, {
        rating: 5, ratings: editedRatings, comment: '补充体验', tags: [], retainedImageUrls: [], imageObjects: [],
      }, 'PATCH');
      expect(edited.status).toBe(200);
      const pending = await Booking.findOne({ id }).lean();
      expect(pending.review.pendingEdit).toMatchObject({ rating: 3.5, ratings: editedRatings });
      expect(pending.review.rating).toBe(legacy ? 5 : 4.25);
      expect((await request('admin', '/admin/user-images', { bookingId: id, type: 'reviewEdit', action: 'approve' }, 'PATCH')).status).toBe(200);
      const approved = await Booking.findOne({ id }).lean();
      expect(approved.review).toMatchObject({ rating: 3.5, ratings: editedRatings });
      // Released clients still submit only an integer total when editing.
      expect((await request('dimensions', `/bookings/${id}/review`, {
        rating: 4, comment: '旧版修改', tags: [], retainedImageUrls: [], imageObjects: [],
      }, 'PATCH')).status).toBe(200);
      const oldEdit = await Booking.findOne({ id }).lean();
      expect(oldEdit.review.pendingEdit.rating).toBe(4);
      expect(oldEdit.review.pendingEdit.ratings).toBeUndefined();
    }
  });

  test('merchant reply approval removes the pending item and publishes the approved reply', async () => {
    const id = 'merchant-reply-approval';
    await Booking.create({ id, userId: 'client-1', salonId: 'salon-1', staffId: 'staff-1',
      serviceId: 'service-1', status: 'completed', startTime: new Date('2028-01-01'), reviewed: true,
      review: { id: 'reply-review', rating: 5, comment: '用户原评价', reviewStatus: 'approved',
        merchantReply: { content: '旧公开回复', reviewStatus: 'approved' },
        pendingMerchantReply: { content: '新回复待审核', reviewStatus: 'pending' } } });
    const result = await request('admin', '/admin/user-images', { bookingId: id, type: 'reviewReply', action: 'approve' }, 'PATCH');
    expect(result.status).toBe(200);
    const list = await request('admin', '/admin/user-images?page=1&limit=100');
    expect(list.body.find(item => item.bookingId === id && item.type === 'reviewReply')).toMatchObject({
      status: 'approved', content: '新回复待审核',
    });
    const saved = await Booking.findOne({ id }).lean();
    expect(saved.review.pendingMerchantReply).toBeUndefined();
    expect(saved.review).toMatchObject({ comment: '用户原评价', reviewStatus: 'approved',
      merchantReply: { content: '新回复待审核', reviewStatus: 'approved' } });
    const client = await request('client', `/bookings/${id}`);
    expect(client.body.review.merchantReply.content).toBe('新回复待审核');
    expect(client.body.review.pendingMerchantReply).toBeUndefined();
  });

  test.each(['pendingReply', 'publicReply', 'pendingEdit'])('moderation deletes persisted %s subdocuments without changing the user review', async kind => {
    const id = `moderation-delete-${kind}`;
    const review = { id: 'delete-review', comment: '用户原评价', rating: 5, reviewStatus: 'approved' };
    if (kind !== 'pendingEdit') review.merchantReply = { content: '原公开回复', reviewStatus: 'approved' };
    if (kind === 'pendingReply') review.pendingMerchantReply = { content: '待审核新回复', reviewStatus: 'pending' };
    if (kind === 'pendingEdit') review.pendingEdit = { id: 'edit-review', comment: '待审核修改', rating: 4, reviewStatus: 'pending', imageUrls: [] };
    await Booking.create({ id, userId: 'client-1', salonId: 'salon-1', serviceId: 'service-1',
      startTime: new Date('2028-01-01'), status: 'completed', reviewed: true, review });
    expect((await request('admin', '/admin/user-images', {
      bookingId: id, type: kind === 'pendingEdit' ? 'reviewEdit' : 'reviewReply', action: 'delete',
    }, 'PATCH')).status).toBe(200);
    const saved = await Booking.findOne({ id }).lean();
    expect(saved.review).toMatchObject({ id: 'delete-review', comment: '用户原评价', rating: 5, reviewStatus: 'approved' });
    expect(saved.review.pendingMerchantReply).toBeUndefined();
    expect(saved.review.pendingEdit).toBeUndefined();
    if (kind === 'pendingReply') expect(saved.review.merchantReply.content).toBe('原公开回复');
    if (kind === 'publicReply') expect(saved.review.merchantReply).toBeUndefined();
  });

  test('stored ratings follow review approval, approved edits, rejection and client deletion through the real routes', async () => {
    const staffId = 'stored-rating-staff';
    const salonId = 'stored-rating-salon';
    const coordinates = [114.0579, 22.5431];
    await StaffProfile.create({ id: staffId, name: 'Stored stylist', roleId: 'designer' });
    await Salon.create({ id: salonId, name: 'Stored salon', publishStatus: 'online', staffIds: [staffId],
      location: { latitude: coordinates[1], longitude: coordinates[0] }, geoLocation: { type: 'Point', coordinates } });
    const scores = score => ({ environment: score, technique: score, service: score, price: score });
    // Reviews start pending, as the client review route creates them.
    await Booking.create([5, 3].map((score, index) => ({
      id: `stored-rating-${index}`, userId: 'client-1', salonId, staffId, serviceId: 'service', status: 'completed',
      startTime: new Date('2030-03-01T02:00:00Z'),
      review: { id: `stored-rating-review-${index}`, rating: score, ratings: scores(score), reviewStatus: 'pending', createdAt: new Date() },
    })));
    const ratings = async () => {
      const [staff, salon, list] = await Promise.all([
        request('client', `/staff/${staffId}`),
        request('client', `/salons/${salonId}`),
        request('client', `/salons?latitude=${coordinates[1]}&longitude=${coordinates[0]}&radiusKm=1&sort=rating&page=1&limit=10`),
      ]);
      const card = list.body.find(item => item.id === salonId);
      return { staff: [staff.body.rating, staff.body.reviewCount], salon: [salon.body.rating, salon.body.reviewCount],
        list: [card.rating, card.reviewCount], detailStaff: [salon.body.staff[0].rating, salon.body.staff[0].reviewCount] };
    };
    const expectRatings = async (staff, salon) => expect(await ratings()).toEqual({ staff, salon, list: salon, detailStaff: staff });
    const moderate = async (bookingId, type, action) => expect((await request('admin', '/admin/user-images', { bookingId, type, action }, 'PATCH')).status).toBe(200);

    await expectRatings([null, 0], [null, 0]);
    await moderate('stored-rating-0', 'review', 'approve');
    await expectRatings([5, 1], [5, 1]);
    await moderate('stored-rating-1', 'review', 'approve');
    await expectRatings([4, 2], [4, 2]);
    // An approved edit replaces the score that counts; a pending one does not.
    await Booking.updateOne({ id: 'stored-rating-1' }, { $set: { 'review.pendingEdit': {
      id: 'stored-rating-review-1', rating: 1, ratings: scores(1), reviewStatus: 'pending', imageUrls: [], createdAt: new Date() } } });
    await expectRatings([4, 2], [4, 2]);
    await moderate('stored-rating-1', 'reviewEdit', 'approve');
    await expectRatings([3, 2], [3, 2]);
    await moderate('stored-rating-0', 'review', 'reject');
    await expectRatings([1, 1], [1, 1]);
    expect((await request('client', '/bookings/stored-rating-1/review', undefined, 'DELETE')).status).toBe(200);
    await expectRatings([null, 0], [null, 0]);
    expect(await models.StaffRatingSummary.findOne({ staffId }).lean()).toMatchObject({ reviewCount: 0, ratingTotal: 0, techniqueCount: 0 });

    // Concurrent refreshes converge, and a rebuild from bookings reproduces the stored totals.
    await moderate('stored-rating-0', 'review', 'approve');
    await Promise.all(Array.from({ length: 5 }, () => refreshStaffRatingSummaries([staffId])));
    expect(await models.StaffRatingSummary.countDocuments({ staffId })).toBe(1);
    await expectRatings([5, 1], [5, 1]);
  });

  test('admin today bookings snapshot and per-account viewed state persist through actual HTTP and MongoDB', async () => {
    const { bookingDayRange } = require('../services/booking');
    const today = bookingDayRange();
    for (const [id, createdAt] of [
      ['new-orders-yesterday', new Date(today.start.getTime() - 1)],
      ['new-orders-midnight', today.start],
    ]) {
      await Booking.create({ id, userId: 'client-1', salonId: 'salon-1',
        serviceId: 'service-1', startTime: new Date('2030-01-01'), status: 'canceled', createdAt });
    }
    const secondSession = createSession();
    sessions.admin2 = secondSession;
    await AdminUser.create({ id: 'admin-2', username: 'admin-2', passwordHash: 'fixture', passwordSalt: 'fixture',
      sessionTokenHash: secondSession.tokenHash, sessionExpiresAt: secondSession.expiresAt });
    const overview = await request('admin', '/admin/overview');
    expect(overview.status).toBe(200);
    const before = overview.body.bookingsSnapshotBefore;
    const query = `before=${encodeURIComponent(before)}&page=1&limit=100`;
    const list = await request('admin', `/admin/new-bookings?${query}`);
    expect(list.status).toBe(200);
    expect(list.body.some(order => order.id === 'new-orders-midnight')).toBe(true);
    expect(list.body.some(order => order.id === 'new-orders-yesterday')).toBe(false);
    expect(Number(list.total)).toBe(overview.body.todayBookingCount);
    expect((await request('merchant', `/admin/new-bookings?${query}`)).status).toBe(401);
    expect((await request('admin', '/admin/new-bookings/viewed', { before, adminId: 'admin-2' }, 'POST')).status).toBe(200);
    expect((await AdminUser.findOne({ id: 'admin-1' }).lean()).newBookingsViewedBefore.toISOString()).toBe(before);
    expect((await AdminUser.findOne({ id: 'admin-2' }).lean()).newBookingsViewedBefore).toBeUndefined();
    expect((await request('admin', '/admin/overview')).body.unviewedBookingCount).toBe(0);
    expect((await request('admin2', '/admin/overview')).body.unviewedBookingCount).toBeGreaterThan(0);
    await Booking.create({ id: 'new-orders-at-boundary', userId: 'client-1', salonId: 'salon-1',
      serviceId: 'service-1', startTime: new Date('2030-01-01'), status: 'pending', createdAt: new Date(before) });
    expect((await request('admin', '/admin/overview')).body.unviewedBookingCount).toBe(1);
    await Promise.all([before, new Date(new Date(before).getTime() - 1).toISOString()].map(value =>
      request('admin', '/admin/new-bookings/viewed', { before: value }, 'POST')));
    expect((await AdminUser.findOne({ id: 'admin-1' }).lean()).newBookingsViewedBefore.toISOString()).toBe(before);
    expect((await request('admin', '/admin/bookings?page=1&limit=100')).body.some(order => order.id === 'new-orders-yesterday')).toBe(true);
  });

  test('restricted package saves multiple selectable staff and validates slots, prices and bookings', async () => {
    await createClient('package-client');
    await StaffProfile.create([
      { id: 'restricted-staff', name: 'Stylist', roleId: 'designer', extraServiceFeeFen: 2000 },
      { id: 'restricted-staff-2', name: 'Stylist 2', roleId: 'designer', extraServiceFeeFen: 1000 },
      { id: 'restricted-staff-3', name: 'Stylist 3', roleId: 'designer', extraServiceFeeFen: 0 },
    ]);
    await Salon.create({ id: 'restricted-salon', name: '限定套餐店', publishStatus: 'online',
      staffIds: ['restricted-staff', 'restricted-staff-2', 'restricted-staff-3'], openingHours: '09:00-20:00', services: [{
        id: 'restricted-service', name: '限定套餐', tagIds: ['wash_cut_blow'],
        priceFen: 8000, durationMinutes: 60, staffSelectionRestricted: true,
      }] });
    sessions.restrictedMerchant = createSession();
    await MerchantUser.create({ id: 'restricted-merchant', username: 'restricted-merchant', account: '13800000004',
      salonId: 'restricted-salon', passwordHash: 'fixture', passwordSalt: 'fixture',
      sessionTokenHash: sessions.restrictedMerchant.tokenHash, sessionExpiresAt: sessions.restrictedMerchant.expiresAt });
    const detail = await request('package-client', '/salons/restricted-salon');
    expect(detail.status).toBe(200);
    expect(detail.body.services[0].staffSelectionRestricted).toBe(true);
    const input = { salonId: 'restricted-salon', serviceId: 'restricted-service',
      staffId: 'restricted-staff', startTime: '2030-01-06T10:00:00',
      expectedOriginalAmountFen: 8000, expectedPayableAmountFen: 8000 };
    expect((await request('package-client', '/bookings', input, 'POST')).status).toBe(409);
    const created = await request('package-client', '/bookings', { ...input, staffId: '__no_preference__' }, 'POST');
    expect(created.status).toBe(201);
    const stored = await Booking.findOne({ id: created.body.booking.id }).lean();
    expect(stored.isNoPreference).toBe(true);
    expect(stored.staffExtraServiceFeeFen).toBe(0);
    const service = { ...detail.body.services[0], selectableStaffIds: ['restricted-staff', 'restricted-staff-2'] };
    const saved = await request('restrictedMerchant', '/merchant/salon', { services: [service] }, 'PATCH');
    expect(saved.status).toBe(200);
    expect(saved.body.services[0].selectableStaffIds).toEqual(service.selectableStaffIds);
    const published = await request('package-client', '/salons/restricted-salon');
    expect(published.body.services[0].selectableStaffIds).toEqual(service.selectableStaffIds);
    for (const id of ['restricted-staff', 'restricted-staff-2', 'restricted-staff-3']) {
      const slots = await request('package-client', `/staff/${id}/slots?date=2030-01-06&serviceId=restricted-service`);
      expect(slots.status).toBe(id === 'restricted-staff-3' ? 409 : 200);
    }
    const denied = await request('package-client', '/bookings', { ...input, staffId: 'restricted-staff-3' }, 'POST');
    expect(denied.status).toBe(409);
    const stalePrice = await request('package-client', '/bookings', input, 'POST');
    expect(stalePrice.status).toBe(409);
    expect(stalePrice.body.code).toBe('BOOKING_PRICE_CHANGED');
    const selected = await request('package-client', '/bookings', { ...input, expectedOriginalAmountFen: 10000, expectedPayableAmountFen: 10000 }, 'POST');
    expect(selected.status).toBe(201);
    expect(selected.body.booking.staffId).toBe('restricted-staff');
    expect(selected.body.booking.staffExtraServiceFeeFen).toBe(2000);
    expect(selected.body.booking.isNoPreference).toBe(false);
    const disabled = await request('restrictedMerchant', '/merchant/salon', { services: [{ ...service, staffSelectionRestricted: false }] }, 'PATCH');
    expect(disabled.status).toBe(200);
    const unrestrictedSlots = await request('package-client', '/staff/restricted-staff-3/slots?date=2030-01-06&serviceId=restricted-service');
    expect(unrestrictedSlots.status).toBe(200);
    const editor = await request('restrictedMerchant', '/merchant/salon');
    const pending = await request('restrictedMerchant', '/merchant/salon', { staff: [
      ...editor.body.staff,
      { name: '待审核理发师', roleId: 'designer', extraServiceFeeFen: 0, bio: '介绍' },
    ] }, 'PATCH');
    expect(pending.status).toBe(200);
    const pendingStaff = pending.body.staff.find(profile => profile.name === '待审核理发师');
    expect(pendingStaff.id).toBeTruthy();
    const pendingSelection = await request('restrictedMerchant', '/merchant/salon', { services: [{
      ...service, staffSelectionRestricted: true, selectableStaffIds: [pendingStaff.id],
    }] }, 'PATCH');
    expect(pendingSelection.status).toBe(200);
    const approved = await request('admin', '/admin/merchants/restricted-merchant/content', { action: 'approve' }, 'PATCH');
    expect(approved.status).toBe(200);
    const approvedSalon = await request('package-client', '/salons/restricted-salon');
    const approvedStaff = approvedSalon.body.staff.find(profile => profile.name === '待审核理发师');
    expect(approvedStaff.id).not.toBe(pendingStaff.id);
    expect(approvedSalon.body.services[0].selectableStaffIds).toEqual([approvedStaff.id]);
  });

  test('user policy upserts increment the hidden fence and merchant responses never expose it', async () => {
    const userId = 'policy-fence-client';
    const session = await mongoose.startSession();
    try {
      for (const count of [1, 2]) {
        await session.withTransaction(async () => {
          const policy = await getUserPolicy(userId, session);
          expect(policy.toObject()).toMatchObject({ userId, noShowCount: 0, isBlacklisted: false,
            createdAt: expect.any(Date), updatedAt: expect.any(Date) });
          expect(policy.toObject()).not.toHaveProperty('bookingCreationFence');
        });
        expect((await UserPolicy.findOne({ userId }).select('+bookingCreationFence').lean()).bookingCreationFence).toBe(count);
      }
    } finally { await session.endSession(); }
    await Booking.create({ id: 'policy-no-show', userId, salonId: 'salon-1', serviceId: 'service-1',
      status: 'accepted', startTime: new Date('2030-01-06T15:00:00+08:00') });
    const response = await request('merchant', '/merchant/bookings/policy-no-show',
      { action: 'no_show', reason: '用户未到店' }, 'PATCH');
    expect(response.status).toBe(200);
    expect(response.body.userPolicy).toMatchObject({ noShowCount: 1, isBlacklisted: false });
    expect(response.body.userPolicy).not.toHaveProperty('bookingCreationFence');
    expect((await UserPolicy.findOne({ userId }).select('+bookingCreationFence').lean()).bookingCreationFence).toBe(2);
  });

  async function createBookingCoupon(userId, id) {
    await UserCoupon.create({ id, userId, campaignKey: 'fixture', couponType: id,
      minimumSpendFen: 5000, discountFen: 1000, title: 'Fixture coupon',
      grantedAt: new Date(), claimedAt: new Date(),
      validFrom: new Date('2020-01-01'), validUntil: new Date('2035-01-01') });
  }

  test('eight concurrent bookings across salons hold at most five slots and coupons, and cancellation restores capacity', async () => {
    const userId = 'capacity-client';
    await createClient(userId);
    await StaffProfile.create(Array.from({ length: 8 }, (_, index) => ({
      id: `capacity-staff-${index}`, name: 'Stylist', roleId: 'designer',
    })));
    await Salon.create(Array.from({ length: 8 }, (_, index) => ({
      id: `capacity-salon-${index}`, name: 'Capacity salon', publishStatus: 'online',
      openingHours: '09:00-20:00', staffIds: [`capacity-staff-${index}`],
      services: [{ id: 'cut', name: 'Cut', tagIds: ['wash_cut_blow'], priceFen: 8000, durationMinutes: 60 }],
    })));
    const inputs = Array.from({ length: 8 }, (_, index) => ({
      staffId: `capacity-staff-${index}`, salonId: `capacity-salon-${index}`,
      serviceId: 'cut', startTime: `2030-02-01T${10 + index}:00:00+08:00`, couponId: `capacity-coupon-${index}`,
    }));
    await Promise.all(inputs.map(({ couponId }) => createBookingCoupon(userId, couponId)));
    const submit = input => request(userId, '/bookings', input, 'POST');
    const responses = await Promise.all(inputs.map(submit));
    expect(responses.map(result => result.status).sort()).toEqual([201, 201, 201, 201, 201, 409, 409, 409]);
    const active = { userId, status: { $in: ['pending', 'accepted'] } };
    expect(await Booking.countDocuments(active)).toBe(5);
    expect(await BookingMessage.countDocuments({ userId })).toBe(5);
    for (const [index, { status, body }] of responses.entries()) {
      const { staffId, couponId } = inputs[index];
      const occupancy = await SlotOccupancy.findOne({ staffId }).lean();
      const coupon = await UserCoupon.findOne({ id: couponId }).lean();
      if (status === 201) {
        expect(occupancy.bookingId).toBe(body.booking.id);
        expect(coupon.reservedBookingId).toBe(body.booking.id);
      } else {
        expect(body.message).toContain('最多同时保留5个');
        expect(occupancy).toBeNull();
        expect(coupon.reservedBookingId).toBe('');
        expect(coupon.reservedAt).toBeUndefined();
      }
    }

    const created = responses.find(result => result.status === 201).body.booking.id;
    // An accepted booking occupies capacity too.
    await Booking.updateOne({ id: created }, { $set: { status: 'accepted' } });
    const blockedInput = inputs[responses.findIndex(result => result.status === 409)];
    expect(await submit(blockedInput)).toMatchObject({ status: 409, body: { message: expect.stringContaining('最多同时保留5个') } });
    expect((await request(userId, `/bookings/${created}/cancel`, {}, 'PATCH')).status).toBe(200);
    expect((await submit(blockedInput)).status).toBe(201);
    expect(await Booking.countDocuments(active)).toBe(5);
  });

  test('pending expiry releases occupancy and coupons atomically, leaving fresh and accepted bookings alone', async () => {
    const userId = 'expiry-client';
    await createClient(userId);
    await createBookingCoupon(userId, 'expiry-coupon');
    await StaffProfile.create({ id: 'expiry-staff', name: 'Stylist', roleId: 'designer' });
    await Salon.create({ id: 'expiry-salon', name: 'Expiry salon', publishStatus: 'online',
      openingHours: '09:00-20:00', staffIds: ['expiry-staff'],
      services: [{ id: 'cut', name: 'Cut', tagIds: ['wash_cut_blow'], priceFen: 8000, durationMinutes: 60 }],
    });
    const now = new Date('2030-03-01T02:00:00Z');
    const input = { salonId: 'expiry-salon', staffId: 'expiry-staff', serviceId: 'cut',
      startTime: '2030-03-02T10:00:00+08:00', couponId: 'expiry-coupon',
      expectedOriginalAmountFen: 8000, expectedPayableAmountFen: 7000 };
    const response = await request(userId, '/bookings', input, 'POST');
    expect(response.status).toBe(201);
    const expiredId = response.body.booking.id;
    await Booking.updateOne({ id: expiredId }, { $set: { createdAt: new Date('2030-02-27T02:00:00Z') } },
      { timestamps: false, overwriteImmutable: true });

    const started = new Date('2030-03-01T01:00:00Z');
    await Booking.create([
      { id: 'expiry-started', status: 'pending', startTime: started, createdAt: started },
      { id: 'expiry-fresh', status: 'pending', startTime: new Date('2030-03-02'), createdAt: started },
      { id: 'expiry-accepted', status: 'accepted', startTime: started, createdAt: started },
    ].map(value => ({ userId, serviceId: 'cut', ...value })));
    await SlotOccupancy.create({ bookingId: 'expiry-started', staffId: input.staffId,
      startTime: started, slots: occupiedSlotStarts(started, 60) });

    const broadcastBookingEvent = jest.fn();
    const dependencies = { mongoose, ...models, broadcastBookingEvent };
    const options = { timeoutMs: 24 * 60 * 60 * 1000 };
    await expirePendingBookings(dependencies, now, options);
    expect(await Booking.findOne({ id: 'expiry-started' }).lean()).toMatchObject({
      status: 'rejected', rejectReason: expect.stringContaining('预约时间已到'),
    });
    expect(await Booking.findOne({ id: expiredId }).lean()).toMatchObject({
      status: 'rejected', rejectReason: expect.stringContaining('长时间未确认'),
      userMessage: expect.any(String), merchantMessage: expect.any(String),
      couponId: '', couponCode: '', couponTitle: '', couponDiscountFen: 0,
      originalAmountFen: 8000, payableAmountFen: 8000, couponRedeemedAt: null,
    });
    expect((await Booking.findOne({ id: 'expiry-fresh' }).lean()).status).toBe('pending');
    expect((await Booking.findOne({ id: 'expiry-accepted' }).lean()).status).toBe('accepted');
    expect(await SlotOccupancy.countDocuments({ bookingId: { $in: [expiredId, 'expiry-started'] } })).toBe(0);
    for (const id of [expiredId, 'expiry-started']) {
      expect(await BookingMessage.countDocuments({ bookingId: id, type: 'reject', status: 'rejected' })).toBe(1);
      expect(broadcastBookingEvent).toHaveBeenCalledWith('booking.updated', expect.objectContaining({ id, status: 'rejected' }));
    }
    expect(await expirePendingBookings(dependencies, now, options)).toBe(0);
    const coupons = await request(userId, '/auth/coupons');
    expect(coupons.body).toEqual([expect.objectContaining({ id: input.couponId, status: 'available' })]);
    expect((await request(userId, '/bookings', input, 'POST')).status).toBe(201);
  });

  test('merchant acceptance and pending expiry commit exactly one transition', async () => {
    const id = 'expiry-accept-race';
    const startTime = new Date('2030-03-05T02:00:00Z');
    await Booking.create({ id, userId: 'expiry-client', salonId: 'salon-1', serviceId: 'service-1',
      staffId: 'staff-1', staffName: 'Stylist', status: 'pending', startTime,
      serviceDurationMinutes: 60 });
    await SlotOccupancy.create({ bookingId: id, staffId: 'staff-1', startTime,
      slots: occupiedSlotStarts(startTime, 60) });
    const broadcastBookingEvent = jest.fn();
    const [accepted] = await Promise.all([
      request('merchant', `/merchant/bookings/${id}`, { action: 'accept' }, 'PATCH'),
      expirePendingBookings({ mongoose, ...models, broadcastBookingEvent }, startTime),
    ]);
    const stored = await Booking.findOne({ id }).lean();
    const messages = await BookingMessage.find({ bookingId: id }).lean();
    expect(messages).toHaveLength(1);
    if (accepted.status === 200) {
      expect(stored.status).toBe('accepted');
      expect(messages[0].type).toBe('accept');
      expect(await SlotOccupancy.countDocuments({ bookingId: id })).toBe(1);
      expect(broadcastBookingEvent).not.toHaveBeenCalledWith('booking.updated', expect.objectContaining({ id }));
    } else {
      expect(accepted.status).toBe(409);
      expect(stored.status).toBe('rejected');
      expect(messages[0].type).toBe('reject');
      expect(await SlotOccupancy.countDocuments({ bookingId: id })).toBe(0);
      expect(broadcastBookingEvent).toHaveBeenCalledWith('booking.updated', expect.objectContaining({ id }));
    }
  });

  test('logout closes the old merchant websocket and revokes all three role tokens', async () => {
    const socket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/ws');
    try {
      await new Promise((resolve, reject) => {
        socket.on('error', reject);
        socket.on('message', raw => {
          const message = JSON.parse(raw.toString());
          if (message.event === 'auth.required') socket.send(JSON.stringify({ event: 'authenticate', role: 'merchant', token: sessions.merchant.token }));
          if (message.event === 'authenticated') resolve();
        });
      });
      const closed = new Promise(resolve => socket.once('close', code => resolve(code)));
      for (const role of ['merchant', 'admin', 'client']) {
        const prefix = role === 'client' ? '/auth' : `/${role}/auth`;
        expect((await request(role, `${prefix}/logout`, {}, 'POST')).status).toBe(200);
        const protectedRoute = role === 'client' ? '/bookings' : `${prefix}/me`;
        expect((await request(role, protectedRoute)).status).toBe(401);
      }
      expect(await closed).toBe(1008);
    } finally { socket.terminate(); }
  });
});
