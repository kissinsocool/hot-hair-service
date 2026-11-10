const assert = require('node:assert/strict');
const test = require('node:test');
const { expirePendingBookings } = require('./auto-complete-bookings');

const now = new Date('2030-01-03T10:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const pending = (id, startsInHours, createdHoursAgo, extra = {}) => ({
  _id: id, id: String(id), status: 'pending', userId: 'user-1', salonId: 'salon-1',
  startTime: new Date(now.getTime() + startsInHours * HOUR),
  createdAt: new Date(now.getTime() - createdHoursAgo * HOUR),
  servicePriceFen: 10000, staffExtraServiceFeeFen: 0, serviceDurationMinutes: 60,
  ...extra,
});

const matches = (item, query) => item.status === query.status
  && (!query._id || item._id > query._id.$gt)
  && query.$or.some(branch => (branch.startTime
    ? item.startTime <= branch.startTime.$lte
    : item.createdAt <= branch.createdAt.$lte));

const runExpiry = async (bookings, options, beforeUpdate = () => {}) => {
  const calls = [];
  const session = { async withTransaction(work) { await work(); }, async endSession() {} };
  const result = await expirePendingBookings({
    mongoose: { async startSession() { return session; } },
    Booking: {
      find(query) {
        let limit;
        return {
          sort() { return this; },
          limit(value) { limit = value; return this; },
          async lean() { return bookings.filter(item => matches(item, query)).slice(0, limit).map(item => ({ ...item })); },
        };
      },
      async findOneAndUpdate(query, update, updateOptions) {
        assert.equal(updateOptions.session, session);
        const booking = bookings.find(item => item._id === query._id);
        beforeUpdate(booking);
        if (booking.status !== query.status || booking.startTime.getTime() !== query.startTime.getTime()) return null;
        Object.assign(booking, update.$set);
        calls.push(`booking:${booking.id}`);
        return booking;
      },
    },
    UserCoupon: {
      async updateOne(query, update, updateOptions) {
        assert.equal(updateOptions.session, session);
        assert.deepEqual(update, { $unset: { reservedAt: '', reservedBookingId: '' } });
        calls.push(`coupon:${query.id}:${query.reservedBookingId}`);
      },
    },
    SlotOccupancy: { async deleteOne(query) { calls.push(`slot:${query.bookingId}`); } },
    BookingMessage: { async create(messages) { calls.push(`message:${messages[0].type}:${messages[0].status}`); return messages; } },
    broadcastBookingEvent(event, booking) { calls.push(`${event}:${booking.id}`); },
  }, now, options);
  return { result, calls };
};

test('releases pending bookings whose start time passed or that the merchant left unhandled', async () => {
  const bookings = [
    pending(1, -1, 2),
    pending(2, 48, 25),
    pending(3, 48, 23),
    { ...pending(4, -1, 2), status: 'accepted' },
  ];
  const { result, calls } = await runExpiry(bookings, { timeoutMs: 24 * HOUR });

  assert.equal(result, 2);
  assert.deepEqual(bookings.map(item => item.status), ['rejected', 'rejected', 'pending', 'accepted']);
  assert.match(bookings[0].rejectReason, /预约时间已到/);
  assert.match(bookings[1].rejectReason, /长时间未确认/);
  assert.match(bookings[1].userMessage, /请重新选择时间预约/);
  assert.deepEqual(calls, [
    'booking:1', 'slot:1', 'message:reject:rejected', 'booking.updated:1',
    'booking:2', 'slot:2', 'message:reject:rejected', 'booking.updated:2',
  ]);
});

test('without a time limit only pending bookings past their start time are released', async () => {
  const bookings = [pending(1, -1, 2), pending(2, 48, 500)];
  const { result } = await runExpiry(bookings, { timeoutMs: 0 });
  assert.equal(result, 1);
  assert.deepEqual(bookings.map(item => item.status), ['rejected', 'pending']);
});

test('releasing a pending booking returns its reserved coupon and removes the discount', async () => {
  const bookings = [pending(1, -1, 2, {
    couponId: 'coupon-1', couponCode: 'CODE', couponTitle: '满99减20',
    couponDiscountFen: 2000, originalAmountFen: 10000, payableAmountFen: 8000,
  })];
  const { result, calls } = await runExpiry(bookings, { timeoutMs: 0 });
  assert.equal(result, 1);
  assert.equal(calls[0], 'coupon:coupon-1:1');
  assert.equal(bookings[0].couponId, '');
  assert.equal(bookings[0].couponDiscountFen, 0);
  assert.equal(bookings[0].payableAmountFen, 10000);
});

test('a booking the merchant handled meanwhile is left untouched', async () => {
  const bookings = [pending(1, -1, 2)];
  const { result, calls } = await runExpiry(bookings, { timeoutMs: 0 }, (booking) => { booking.status = 'accepted'; });
  assert.equal(result, 0);
  assert.equal(bookings[0].status, 'accepted');
  assert.deepEqual(calls, []);
});

test('a pending booking rescheduled after discovery is reconsidered on the next scan', async () => {
  const bookings = [pending(1, -1, 2)];
  const rescheduledTime = new Date(now.getTime() + HOUR);
  const { result, calls } = await runExpiry(bookings, { timeoutMs: 0 }, (booking) => {
    booking.startTime = rescheduledTime;
  });
  assert.equal(result, 0);
  assert.equal(bookings[0].status, 'pending');
  assert.equal(bookings[0].startTime, rescheduledTime);
  assert.deepEqual(calls, []);
});
