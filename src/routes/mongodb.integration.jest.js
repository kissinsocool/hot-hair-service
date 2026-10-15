const crypto = require('node:crypto');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });
const mongoose = require('mongoose');
const WebSocket = require('ws');
const models = require('../models');
const { createSession } = require('../services/auth');
const { occupiedSlotStarts } = require('../services/booking');
const { server } = require('../../index');
const { Booking, BookingMessage, SlotOccupancy, Salon, StaffProfile, ClientUser, MerchantUser, AdminUser, UserCoupon, UserPolicy } = models;
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
