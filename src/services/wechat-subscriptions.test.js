const assert = require('node:assert/strict');
const test = require('node:test');
const {
  bookingAcceptedData,
  formatBookingTime,
} = require('./wechat-subscriptions');

test('booking accepted subscription payload uses template 375 fields', () => {
  assert.equal(formatBookingTime('2030-01-02T02:30:00.000Z'), '2030-01-02 10:30');
  assert.deepEqual(bookingAcceptedData({
    serviceName: '染发与修复',
    salonName: '靓丝造型',
    startTime: '2030-01-02T02:30:00.000Z',
  }), {
    thing1: { value: '染发与修复' },
    thing8: { value: '靓丝造型' },
    phrase11: { value: '预约成功' },
    time10: { value: '2030-01-02 10:30' },
  });
});
