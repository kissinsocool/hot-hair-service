const crypto = require('node:crypto');
const mongoose = require('mongoose');
const { Booking, SlotOccupancy } = require('./models');

const mongoUri = String(process.env.TEST_MONGODB_URI || '').trim();
const describeWithMongo = mongoUri ? describe : describe.skip;

describeWithMongo('MongoDB replica set booking integration', () => {
  const databaseName = `hot_hair_test_${crypto.randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    await mongoose.connect(mongoUri, {
      dbName: databaseName,
      serverSelectionTimeoutMS: 10000,
    });
    await Promise.all([Booking.createIndexes(), SlotOccupancy.createIndexes()]);
  });

  afterEach(async () => {
    await Promise.all([
      Booking.deleteMany({}),
      SlotOccupancy.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    if (mongoose.connection.readyState === 0) return;
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  test('commits a booking and its slot occupancy in one transaction', async () => {
    const session = await mongoose.startSession();
    const startTime = new Date('2030-01-01T10:00:00.000Z');

    try {
      await session.withTransaction(async () => {
        await new SlotOccupancy({
          bookingId: 'BK-1',
          staffId: 'staff-1',
          startTime,
        }).save({ session });
        await new Booking({
          id: 'BK-1',
          serviceId: 'service-1',
          staffId: 'staff-1',
          startTime,
        }).save({ session });
      });
    } finally {
      await session.endSession();
    }

    await expect(Booking.findOne({ id: 'BK-1' }).lean()).resolves.toMatchObject({
      id: 'BK-1',
      serviceId: 'service-1',
      staffId: 'staff-1',
      startTime,
    });
    await expect(SlotOccupancy.findOne({ bookingId: 'BK-1' }).lean()).resolves.toMatchObject({
      bookingId: 'BK-1',
      staffId: 'staff-1',
      startTime,
    });
  });

  test('rejects duplicate occupancy for the same staff member and start time', async () => {
    const startTime = new Date('2030-01-01T10:00:00.000Z');
    await SlotOccupancy.create({ bookingId: 'BK-1', staffId: 'staff-1', startTime });

    await expect(SlotOccupancy.create({
      bookingId: 'BK-2',
      staffId: 'staff-1',
      startTime,
    })).rejects.toMatchObject({ code: 11000 });

    await expect(SlotOccupancy.countDocuments({ staffId: 'staff-1', startTime }))
      .resolves.toBe(1);
  });
});
