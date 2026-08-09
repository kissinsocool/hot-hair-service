const assert = require('node:assert/strict');
const test = require('node:test');
const {
  bookingStatusData,
  bookingStatusText,
  formatBookingTime,
} = require('./wechat-subscriptions');

test('booking subscription payload uses the configured template fields', () => {
  assert.equal(formatBookingTime('2030-01-02T02:30:00.000Z'), '2030-01-02 10:30');
  assert.equal(bookingStatusText('accepted'), '预约成功');
  assert.deepEqual(bookingStatusData({
    serviceName: '染发与修复',
    salonName: '靓丝造型',
    startTime: '2030-01-02T02:30:00.000Z',
    userMessage: '商家已确认，预约成功！',
  }, 'accepted'), {
    thing1: { value: '染发与修复' },
    time2: { value: '2030-01-02 10:30' },
    phrase3: { value: '预约成功' },
    thing4: { value: '靓丝造型' },
    thing5: { value: '商家已确认，预约成功！' },
  });
});
