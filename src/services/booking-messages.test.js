const assert = require('node:assert/strict');
const test = require('node:test');
const { bookingMessagePayload } = require('./booking-messages');

test('booking messages snapshot each status event instead of collapsing by booking', () => {
  const booking = {
    id: 'BK-1',
    userId: 'user-1',
    status: 'completed',
    userMessage: '本次预约已完成，感谢到店。',
    salonName: '靓丝美约',
    staffName: 'Tony',
    serviceName: '剪发',
    startTime: new Date('2030-01-01T02:00:00.000Z'),
    updatedAt: new Date('2030-01-01T03:00:00.000Z'),
  };

  assert.deepEqual(bookingMessagePayload(booking, 'complete'), {
    userId: 'user-1',
    bookingId: 'BK-1',
    type: 'complete',
    status: 'completed',
    userMessage: '本次预约已完成，感谢到店。',
    salonId: undefined,
    salonName: '靓丝美约',
    staffId: undefined,
    staffName: 'Tony',
    serviceId: undefined,
    serviceName: '剪发',
    startTime: booking.startTime,
    couponTitle: undefined,
    couponDiscountFen: undefined,
    createdAt: booking.updatedAt,
  });
});
