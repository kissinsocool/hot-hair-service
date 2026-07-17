const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const mongoose = require('mongoose');
const { Booking, SlotOccupancy } = require('./models');

const mongoUri = String(process.env.TEST_MONGODB_URI || '').trim();

test('real MongoDB replica set commits bookings and rejects duplicate slot occupancy', {
  skip: mongoUri ? false : 'TEST_MONGODB_URI is not configured',
}, async () => {
  const databaseName = `hot_hair_test_${crypto.randomUUID().replaceAll('-', '')}`;
  await mongoose.connect(mongoUri, { dbName: databaseName, serverSelectionTimeoutMS: 10000 });
  const session = await mongoose.startSession();
  try {
    await Promise.all([Booking.createIndexes(), SlotOccupancy.createIndexes()]);
    const startTime = new Date('2030-01-01T10:00:00.000Z');
    await session.withTransaction(async () => {
      await SlotOccupancy.create([{ bookingId: 'BK-1', staffId: 'staff-1', startTime }], { session });
      await Booking.create([{ id: 'BK-1', serviceId: 'service-1', staffId: 'staff-1', startTime }], { session });
    });

    assert.equal(await Booking.countDocuments({ id: 'BK-1' }), 1);
    await assert.rejects(
      session.withTransaction(() => SlotOccupancy.create([
        { bookingId: 'BK-2', staffId: 'staff-1', startTime },
      ], { session })),
      error => error?.code === 11000,
    );
  } finally {
    await session.endSession();
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
