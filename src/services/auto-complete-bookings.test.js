const assert = require('node:assert/strict');
const test = require('node:test');
const { completeDueBookings } = require('./auto-complete-bookings');

test('completes only accepted bookings at least 24 hours old with coupon and message', async () => {
  const now = new Date('2030-01-03T10:00:00.000Z');
  const bookings = [
    { _id: 1, id: 'due', status: 'accepted', startTime: new Date('2030-01-02T10:00:00.000Z'), couponId: 'coupon', salonId: 'salon' },
    { _id: 2, id: 'future', status: 'accepted', startTime: new Date('2030-01-02T10:00:01.000Z') },
    { _id: 3, id: 'canceled', status: 'canceled', startTime: new Date('2030-01-01T10:00:00.000Z') },
  ];
  const calls = [];
  const session = { async withTransaction(work) { await work(); }, async endSession() {} };
  const result = await completeDueBookings({
    mongoose: { async startSession() { return session; } },
    Booking: {
      find(query) {
        return {
          sort() { return this; },
          limit() { return this; },
          async lean() {
            return bookings.filter(item => item.status === query.status
              && item.startTime <= query.startTime.$lte
              && (!query._id || item._id > query._id.$gt));
          },
        };
      },
      async findOneAndUpdate(query, update) {
        const booking = bookings.find(item => item._id === query._id);
        if (booking.status !== query.status || booking.startTime > query.startTime.$lte) return null;
        Object.assign(booking, update.$set);
        calls.push('booking');
        return booking;
      },
    },
    UserCoupon: {
      async findOneAndUpdate(query, update) {
        assert.equal(query.reservedBookingId, 'due');
        calls.push('coupon');
        return { redeemedAt: update.$set.redeemedAt };
      },
    },
    SlotOccupancy: { async deleteOne(query) { calls.push(`slot:${query.bookingId}`); } },
    BookingMessage: { async create(messages) { calls.push(`message:${messages[0].status}`); return messages; } },
    AnalyticsEvent: { async updateOne() { calls.push('analytics'); } },
    broadcastBookingEvent(event) { calls.push(event); },
  }, now);

  assert.equal(result, 1);
  assert.equal(bookings[0].status, 'completed');
  assert.equal(bookings[0].couponRedeemedAt, now);
  assert.equal(bookings[1].status, 'accepted');
  assert.equal(bookings[2].status, 'canceled');
  assert.deepEqual(calls, ['coupon', 'booking', 'slot:due', 'message:completed', 'booking.updated', 'analytics']);
});
