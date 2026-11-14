const assert = require('node:assert/strict');
const test = require('node:test');
const { completeDueBookings } = require('./auto-complete-bookings');

const now = new Date('2030-01-03T10:00:00.000Z');
const bookingAt = (id, minutesAgo, serviceDurationMinutes, status = 'accepted') => ({
  _id: id, id: String(id), status,
  startTime: new Date(now.getTime() - minutesAgo * 60 * 1000),
  ...(serviceDurationMinutes === undefined ? {} : { serviceDurationMinutes }),
});

const runCompletion = async (bookings, beforeUpdate = () => {}, overrides = {}) => {
  const calls = [];
  const broadcasts = [];
  const scannedIds = [];
  const session = { async withTransaction(work) { await work(); }, async endSession() {} };
  const result = await completeDueBookings({
    mongoose: { async startSession() { return session; } },
    Booking: {
      find(query) {
        let limit;
        return {
          sort() { return this; },
          limit(value) { limit = value; return this; },
          async lean() {
            const scanned = bookings.filter(item => item.status === query.status
              && item.startTime <= query.startTime.$lte
              && (!query._id || item._id > query._id.$gt))
              .slice(0, limit);
            scannedIds.push(...scanned.map(item => item.id));
            return scanned.map(item => ({ ...item }));
          },
        };
      },
      async findOneAndUpdate(query, update) {
        const booking = bookings.find(item => item._id === query._id);
        beforeUpdate(booking);
        if (booking.status !== query.status
          || booking.startTime.getTime() !== query.startTime.getTime()
          || (booking.serviceDurationMinutes ?? null) !== query.serviceDurationMinutes) return null;
        Object.assign(booking, update.$set);
        calls.push('booking');
        return booking;
      },
    },
    UserCoupon: {
      async findOneAndUpdate(query, update) {
        assert.equal(query.reservedBookingId, '1');
        calls.push('coupon');
        return { redeemedAt: update.$set.redeemedAt };
      },
    },
    SlotOccupancy: { async deleteOne(query) { calls.push(`slot:${query.bookingId}`); } },
    BookingMessage: { async create(messages) { calls.push(`message:${messages[0].status}`); return messages; } },
    AnalyticsEvent: { async updateOne() { calls.push('analytics'); } },
    broadcastBookingEvent(event, booking) {
      calls.push(event);
      broadcasts.push([event, booking.id]);
    },
    ...overrides,
  }, now);
  return { result, calls, broadcasts, scannedIds };
};

test('completes accepted bookings at the saved service end with coupon and message', async () => {
  const bookings = [
    { ...bookingAt(1, 90, 90), couponId: 'coupon', salonId: 'salon' },
    bookingAt(2, 90 - 1 / 60000, 90),
    bookingAt(3, 120, 30, 'canceled'),
    bookingAt(4, 120, 30, 'pending'),
    bookingAt(5, 120, 30, 'completed'),
    bookingAt(6, -30, 30),
    bookingAt(7, 120, 30, 'rejected'),
    bookingAt(8, 120, 30, 'no_show'),
  ];
  const { result, calls, scannedIds } = await runCompletion(bookings);
  assert.equal(result, 1);
  assert.deepEqual(scannedIds, ['1', '2']);
  assert.equal(bookings[0].status, 'completed');
  assert.equal(bookings[0].completionSource, 'automatic');
  assert.equal(bookings[0].completedAt, now);
  assert.match(bookings[0].userMessage, /系统已自动完成/);
  assert.equal(bookings[0].couponRedeemedAt, now);
  assert.equal(bookings[1].status, 'accepted');
  assert.equal(bookings[2].status, 'canceled');
  assert.deepEqual(bookings.slice(3).map(item => item.status), ['pending', 'completed', 'accepted', 'rejected', 'no_show']);
  assert.deepEqual(calls, ['coupon', 'booking', 'slot:1', 'message:completed', 'booking.updated', 'analytics']);
});

test('uses each order duration, including services longer than a day', async () => {
  const bookings = [bookingAt(1, 30, 30), bookingAt(2, 30, 90), bookingAt(3, 1440, 1500)];
  assert.equal((await runCompletion(bookings)).result, 1);
  assert.deepEqual(bookings.map(item => item.status), ['completed', 'accepted', 'accepted']);
});

test('legacy orders without a valid duration keep the 24-hour boundary', async () => {
  for (const duration of [undefined, null, 0, -1, 1.5, '60', Number.MAX_SAFE_INTEGER + 1]) {
    const bookings = [bookingAt(1, 1440, duration), bookingAt(2, 1440 - 1 / 60000, duration)];
    assert.equal((await runCompletion(bookings)).result, 1);
    assert.deepEqual(bookings.map(item => item.status), ['completed', 'accepted']);
  }
});

test('does not complete an order changed concurrently after scanning', async () => {
  for (const change of [
    booking => { booking.startTime = new Date(now.getTime() + 60 * 60 * 1000); },
    booking => { booking.serviceDurationMinutes = 120; },
    booking => { booking.status = 'canceled'; },
  ]) {
    const booking = bookingAt(1, 60, 60);
    const { result, calls } = await runCompletion([booking], change);
    assert.equal(result, 0);
    assert.notEqual(booking.status, 'completed');
    assert.deepEqual(calls, []);
  }
});

test('continues paging when a full batch has not reached its service end', async () => {
  const bookings = Array.from({ length: 100 }, (_, index) => bookingAt(index + 1, 30, 90));
  bookings.push(bookingAt(101, 30, 30));
  assert.equal((await runCompletion(bookings)).result, 1);
  assert.equal(bookings[100].status, 'completed');
  assert.ok(bookings.slice(0, 100).every(item => item.status === 'accepted'));
  assert.equal((await runCompletion(bookings)).result, 0);
});

test('preserves existing redemption, recovers legacy redemption, and skips an inconsistent coupon', async (t) => {
  const existing = new Date('2030-01-02T10:00:00Z');
  const legacy = new Date('2030-01-01T10:00:00Z');
  const bookings = [
    { ...bookingAt(1, 60, 60), couponId: 'inconsistent' },
    { ...bookingAt(2, 60, 60), couponId: 'existing', couponRedeemedAt: existing },
    { ...bookingAt(3, 60, 60), couponId: 'legacy' },
  ];
  const UserCoupon = {
    findOneAndUpdate: t.mock.fn(async () => null),
    findOne: t.mock.fn(query => ({
      async session() { return query.id === 'legacy' ? { redeemedAt: legacy } : null; },
    })),
  };
  const log = t.mock.method(console, 'error', () => {});
  const { result, broadcasts } = await runCompletion(bookings, undefined, { UserCoupon });

  assert.equal(result, 2);
  assert.equal(bookings[0].status, 'accepted');
  assert.equal(bookings[1].couponRedeemedAt, existing);
  assert.equal(bookings[2].couponRedeemedAt, legacy);
  assert.deepEqual(UserCoupon.findOneAndUpdate.mock.calls.map(call => call.arguments[0].id), ['inconsistent', 'legacy']);
  assert.deepEqual(UserCoupon.findOne.mock.calls.map(call => call.arguments[0]), [
    { id: 'inconsistent', redeemedBookingId: '1' },
    { id: 'legacy', redeemedBookingId: '3' },
  ]);
  assert.equal(log.mock.callCount(), 1);
  assert.match(log.mock.calls[0].arguments[1].message, /Coupon state is inconsistent for booking 1/);
  assert.deepEqual(broadcasts, [['booking.updated', '2'], ['booking.updated', '3']]);
});

test('counts and broadcasts successful transactions even when another transaction or analytics fails', async (t) => {
  const bookings = [1, 2, 3].map(id => bookingAt(id, 60, 60));
  const transactionError = new Error('Booking update failed');
  const analyticsError = new Error('Analytics write failed');
  const log = t.mock.method(console, 'error', () => {});
  const AnalyticsEvent = {
    updateOne: t.mock.fn(async ({ eventId }) => {
      if (eventId === 'booking:2:visit_completed') throw analyticsError;
    }),
  };
  const { result, broadcasts } = await runCompletion(bookings, booking => {
    if (booking.id === '1') throw transactionError;
  }, { AnalyticsEvent });

  assert.equal(result, 2);
  assert.deepEqual(bookings.map(booking => booking.status), ['accepted', 'completed', 'completed']);
  assert.deepEqual(broadcasts, [['booking.updated', '2'], ['booking.updated', '3']]);
  assert.deepEqual(AnalyticsEvent.updateOne.mock.calls.map(call => call.arguments[0].eventId), [
    'booking:2:visit_completed', 'booking:3:visit_completed',
  ]);
  assert.deepEqual(log.mock.calls.map(call => call.arguments), [
    ['Automatic booking completion failed for 1:', transactionError],
    ['Booking completion analytics failed:', analyticsError],
  ]);
});
