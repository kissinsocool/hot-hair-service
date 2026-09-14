const assert = require('node:assert/strict');
const test = require('node:test');
const registerMerchantRoutes = require('./merchant');
const bookingService = require('../services/booking');

test('merchant rescheduling updates the booking without creating a user message', async () => {
  const routes = new Map();
  const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map(method => [
    method,
    (path, ...handlers) => routes.set(`${method}:${path}`, handlers.at(-1)),
  ]));
  const session = {
    async withTransaction(work) { await work(); },
    async endSession() {},
  };
  const booking = {
    id: 'BK-1',
    salonId: 'salon-1',
    userId: 'user-1',
    status: 'accepted',
    staffId: '',
    startTime: new Date('2030-01-01T02:00:00.000Z'),
  };
  let bookingUpdate;
  let messageCount = 0;
  let broadcastBooking;

  registerMerchantRoutes(app, {
    AnalyticsEvent: { async updateOne() {} },
    Salon: {
      findOne() {
        return {
          select() { return this; },
          async lean() { return { staffIds: [], openingHours: '10:00 - 20:00' }; },
        };
      },
    },
    Booking: {
      async findOne() { return booking; },
      async findOneAndUpdate(query, update) {
        bookingUpdate = update.$set;
        return { ...booking, ...update.$set };
      },
    },
    BookingMessage: {
      async create() { messageCount += 1; return []; },
    },
    SlotOccupancy: {},
    UserCoupon: {},
    mongoose: { async startSession() { return session; } },
    buildMerchantBookingScope: () => ({ salonId: 'salon-1' }),
    normalizeMerchantBooking: value => value,
    parseMerchantRescheduleTime: bookingService.parseMerchantRescheduleTime,
    parseOpeningHours: bookingService.parseOpeningHours,
    isSalonClosedOnDate: () => false,
    broadcastBookingEvent(event, value) { broadcastBooking = { event, value }; },
    rateLimits: { login: [], booking: [], merchantBooking: [], publicRead: [], upload: [] },
  });

  let response;
  await routes.get('patch:/api/merchant/bookings/:id')(
    {
      params: { id: booking.id },
      body: { action: 'reschedule', startTime: '2030-01-01T11:00:00.000+08:00' },
      merchantUser: { salonId: booking.salonId },
    },
    { status() { return this; }, json(value) { response = value; } },
  );

  assert.equal(messageCount, 0);
  assert.equal(Object.hasOwn(bookingUpdate, 'userMessage'), false);
  assert.equal(bookingUpdate.startTime.toISOString(), '2030-01-01T03:00:00.000Z');
  assert.equal(broadcastBooking.event, 'booking.updated');
  assert.equal(response.booking.startTime.toISOString(), '2030-01-01T03:00:00.000Z');
});
