const assert = require('node:assert/strict');
const test = require('node:test');
const { completeDueBookings } = require('./auto-complete-bookings');

const now = new Date('2030-01-03T10:00:00.000Z');
const bookingAt = (id, minutesAgo, serviceDurationMinutes, status = 'accepted') => ({
  _id: id, id: String(id), status,
  startTime: new Date(now.getTime() - minutesAgo * 60 * 1000),
  ...(serviceDurationMinutes === undefined ? {} : { serviceDurationMinutes }),
});

const runCompletion = async (bookings, beforeUpdate = () => {}) => {
  const calls = [];
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
            return bookings.filter(item => item.status === query.status
              && item.startTime <= query.startTime.$lte
              && (!query._id || item._id > query._id.$gt))
              .slice(0, limit).map(item => ({ ...item }));
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
    broadcastBookingEvent(event) { calls.push(event); },
  }, now);
  return { result, calls };
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
  const { result, calls } = await runCompletion(bookings);
  assert.equal(result, 1);
  assert.equal(bookings[0].status, 'completed');
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
  for (const duration of [undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
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
