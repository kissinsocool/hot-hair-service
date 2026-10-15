const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const { Salon, StaffProfile } = require('../src/models');
const salonDomain = require('../src/services/salon');

const BATCH_SIZE = 200;

const staffForMigration = (profile = {}) => {
  const roleId = salonDomain.normalizeStaffRoleId(profile.roleId)
    || salonDomain.staffRoleIdFromLegacy(profile.role);
  if (!roleId) {
    throw new Error(
      `Unsupported staff role ${JSON.stringify(profile.role || profile.roleId || '')}`
      + ` for ${profile.id || 'unknown staff'}`,
    );
  }
  return {
    id: profile.id,
    name: profile.name,
    roleId,
    experience: profile.experience,
    extraServiceFeeFen: profile.extraServiceFeeFen,
    imageUrl: profile.imageUrl,
    bio: profile.bio,
    weeklyClosedDays: profile.weeklyClosedDays,
    unavailableSlots: profile.unavailableSlots,
  };
};

const validateExistingRoles = async () => {
  for await (const profile of StaffProfile.collection.find({})) staffForMigration(profile);
  for await (const salon of Salon.collection.find({ 'pendingContent.staff.0': { $exists: true } })) {
    salon.pendingContent.staff.forEach(staffForMigration);
  }
};

const flush = async (collection, operations, counters) => {
  if (!operations.length) return;
  const result = await collection.bulkWrite(operations, { ordered: false });
  counters.matched += result.matchedCount;
  counters.modified += result.modifiedCount;
  operations.length = 0;
};

const migrateCollection = async (collection, cursor, updateFor) => {
  const counters = { scanned: 0, matched: 0, modified: 0 };
  const operations = [];
  for await (const document of cursor) {
    counters.scanned += 1;
    operations.push({ updateOne: { filter: { _id: document._id }, update: updateFor(document) } });
    if (operations.length >= BATCH_SIZE) await flush(collection, operations, counters);
  }
  await flush(collection, operations, counters);
  return counters;
};

const migrate = async () => {
  const mongoUri = String(process.env.MONGODB_URI || '').trim();
  if (!mongoUri) throw new Error('MONGODB_URI is missing');
  await mongoose.connect(mongoUri);
  try {
    await validateExistingRoles();
    const staff = await migrateCollection(
      StaffProfile.collection,
      StaffProfile.collection.find({}),
      profile => ({ $set: { roleId: staffForMigration(profile).roleId }, $unset: { role: '' } }),
    );
    const pendingStaff = await migrateCollection(
      Salon.collection,
      Salon.collection.find({ 'pendingContent.staff.0': { $exists: true } }),
      salon => ({
        $set: { 'pendingContent.staff': salon.pendingContent.staff.map(staffForMigration) },
      }),
    );
    console.log(JSON.stringify({ staff, pendingStaff }));
  } finally {
    await mongoose.disconnect();
  }
};

if (require.main === module) {
  migrate().catch((error) => {
    console.error('Staff role ID migration failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { staffForMigration };
