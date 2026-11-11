const test = require('node:test');
const assert = require('node:assert/strict');
const { unusedIndexNames } = require('./drop-unused-analytics-indexes');

test('only the unused single-field analytics indexes are selected for removal', () => {
  assert.deepEqual(unusedIndexNames([
    { name: '_id_', key: { _id: 1 } },
    { name: 'eventId_1', key: { eventId: 1 }, unique: true },
    { name: 'name_1', key: { name: 1 } },
    { name: 'userId_1', key: { userId: 1 } },
    { name: 'salonId_1', key: { salonId: 1 } },
    { name: 'bookingId_1', key: { bookingId: 1 } },
    { name: 'name_1_createdAt_-1', key: { name: 1, createdAt: -1 } },
    { name: 'createdAt_1', key: { createdAt: 1 }, expireAfterSeconds: 15552000 },
  ]), ['name_1', 'userId_1', 'salonId_1', 'bookingId_1']);
});
