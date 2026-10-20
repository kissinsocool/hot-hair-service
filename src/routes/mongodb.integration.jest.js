const crypto = require('node:crypto');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });
const mongoose = require('mongoose');
const WebSocket = require('ws');
const models = require('../models');
const { createSession } = require('../services/auth');
const { occupiedSlotStarts } = require('../services/booking');
const { completeDueBookings } = require('../services/auto-complete-bookings');
const { server } = require('../../index');
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
      services: [{ id: 'service-1', name: 'Cut', tagIds: ['wash_cut_blow'], priceFen: 8000, durationMinutes: 60 }] });
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
      headers: { Authorization: `Bearer ${sessions[role].token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json(), total: res.headers.get('x-total-count') };
  }

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

  test('public review pages cover more than the legacy cap, count every category and preserve released detail requests', async () => {
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
    const legacy = await request('client', '/salons/review-pages-salon');
    expect(legacy.status).toBe(200); expect(legacy.body.reviews).toHaveLength(150); expect(legacy.body.reviewCount).toBe(165);
    expect(legacy.body.reviewTags).toEqual(reviewTags);
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
      review: { id: `precision-review-${index}`, rating, reviewStatus: 'approved' },
    })));
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
      review: { id: `precision-half-review-${index}`, rating, reviewStatus: 'approved' },
    })));
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
    expect((await Booking.findOne({ id: 'auto-due' }).lean()).couponRedeemedAt).toEqual(now);
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
