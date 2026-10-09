const path = require('node:path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const {
  Booking,
  ClientUser,
  FavoriteSalon,
  SlotOccupancy,
  SupportMessage,
  UserCoupon,
  UserPolicy,
} = require('../src/models');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const readCleanupConfig = (env = process.env) => {
  const mongoUri = String(env.MONGODB_URI || '').trim();
  const prefix = String(env.K6_USER_PREFIX || 'k6-load').trim().toLowerCase();
  const runId = String(env.K6_RUN_ID || '').trim().toLowerCase();
  if (!mongoUri) throw new Error('MONGODB_URI is required');
  if (!/^[a-z0-9_-]{1,40}$/.test(prefix)) {
    throw new Error('K6_USER_PREFIX may contain only a-z, 0-9, _ and -');
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(runId)) {
    throw new Error('K6_RUN_ID is required and may contain only a-z, 0-9, _ and -');
  }
  const expectedConfirmation = `delete-k6-${runId}`;
  return {
    mongoUri,
    prefix,
    runId,
    apply: env.K6_CLEANUP_CONFIRM === expectedConfirmation,
    expectedConfirmation,
  };
};

const cleanupLoadTestData = async (env = process.env) => {
  const config = readCleanupConfig(env);
  await mongoose.connect(config.mongoUri);

  const accountPattern = new RegExp(`^${escapeRegExp(config.prefix)}-${escapeRegExp(config.runId)}-\\d{3}$`);
  const users = await ClientUser.find({ account: accountPattern }, { _id: 0, id: 1, account: 1 }).lean();
  const userIds = users.map(user => user.id);
  const bookingFilter = { userId: { $in: userIds }, note: `k6:${config.runId}` };
  const bookings = userIds.length
    ? await Booking.find(bookingFilter, { _id: 0, id: 1, userId: 1, status: 1 }).lean()
    : [];
  const bookingIds = bookings.map(booking => booking.id);
  const otherBookings = userIds.length
    ? await Booking.countDocuments({ userId: { $in: userIds }, note: { $ne: `k6:${config.runId}` } })
    : 0;
  const counts = {
    users: users.length,
    bookings: bookings.length,
    otherBookings,
    slotOccupancies: bookingIds.length ? await SlotOccupancy.countDocuments({ bookingId: { $in: bookingIds } }) : 0,
    coupons: userIds.length ? await UserCoupon.countDocuments({ userId: { $in: userIds } }) : 0,
    policies: userIds.length ? await UserPolicy.countDocuments({ userId: { $in: userIds } }) : 0,
    favorites: userIds.length ? await FavoriteSalon.countDocuments({ userId: { $in: userIds } }) : 0,
    supportMessages: userIds.length ? await SupportMessage.countDocuments({ userId: { $in: userIds } }) : 0,
  };

  console.log(JSON.stringify({
    mode: config.apply ? 'apply' : 'dry-run',
    runId: config.runId,
    counts,
    sampleUsers: users.slice(0, 5),
    sampleBookings: bookings.slice(0, 5),
  }, null, 2));

  if (!config.apply) {
    console.log(`Dry run only. Set K6_CLEANUP_CONFIRM=${config.expectedConfirmation} to delete this batch.`);
    return counts;
  }
  if (otherBookings) {
    throw new Error(`Refusing cleanup: ${otherBookings} booking(s) for this batch do not have the expected run marker`);
  }

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      if (bookingIds.length) await SlotOccupancy.deleteMany({ bookingId: { $in: bookingIds } }, { session });
      if (userIds.length) {
        await Booking.deleteMany(bookingFilter, { session });
        await UserCoupon.deleteMany({ userId: { $in: userIds } }, { session });
        await UserPolicy.deleteMany({ userId: { $in: userIds } }, { session });
        await FavoriteSalon.deleteMany({ userId: { $in: userIds } }, { session });
        await SupportMessage.deleteMany({ userId: { $in: userIds } }, { session });
        await ClientUser.deleteMany({ id: { $in: userIds }, account: accountPattern }, { session });
      }
    });
  } finally {
    await session.endSession();
  }
  console.log(`Deleted load-test batch ${config.runId}.`);
  return counts;
};

if (require.main === module) {
  cleanupLoadTestData()
    .catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => mongoose.disconnect());
}

module.exports = { cleanupLoadTestData, readCleanupConfig };
