const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const { Booking, Salon, StaffProfile } = require('../src/models');
const bookingDomain = require('../src/services/booking');
const salonDomain = require('../src/services/salon');

const BATCH_SIZE = 200;
const legacyYuanToFen = value => bookingDomain.priceFen(String(value ?? 0));

const serviceForMigration = (service = {}, fallbackId = '') => salonDomain.serviceForStorage({
  ...service,
  priceFen: Number.isSafeInteger(service.priceFen)
    ? service.priceFen
    : legacyYuanToFen(service.price),
}, fallbackId);

const bookingPatch = (document) => {
  const servicePriceFen = Number.isSafeInteger(document.servicePriceFen)
    ? document.servicePriceFen
    : legacyYuanToFen(document.servicePrice || document.serviceBasePrice);
  const serviceDurationMinutes = Number.isSafeInteger(document.serviceDurationMinutes)
    ? document.serviceDurationMinutes
    : bookingDomain.durationMinutes(document.serviceDuration);
  const staffExtraServiceFeeFen = Number.isSafeInteger(document.staffExtraServiceFeeFen)
    ? document.staffExtraServiceFeeFen
    : legacyYuanToFen(document.staffExtraServiceFee);
  const originalAmountFen = Number.isSafeInteger(document.originalAmountFen)
    ? document.originalAmountFen
    : document.totalPrice !== undefined
      ? legacyYuanToFen(document.totalPrice)
      : servicePriceFen + staffExtraServiceFeeFen;
  const payableAmountFen = Number.isSafeInteger(document.payableAmountFen)
    ? document.payableAmountFen
    : Math.max(0, originalAmountFen - (document.couponDiscountFen || 0));

  return {
    servicePriceFen,
    serviceDurationMinutes,
    staffExtraServiceFeeFen,
    originalAmountFen,
    payableAmountFen,
    timeZone: document.timeZone || bookingDomain.businessTimeZone,
  };
};

const flush = async (collection, operations, counters) => {
  if (!operations.length) return;
  const result = await collection.bulkWrite(operations, { ordered: false });
  counters.matched += result.matchedCount;
  counters.modified += result.modifiedCount;
  operations.length = 0;
};

const migrateCollection = async (collection, buildUpdate) => {
  const counters = { scanned: 0, matched: 0, modified: 0 };
  const operations = [];
  for await (const document of collection.find({})) {
    counters.scanned += 1;
    const update = buildUpdate(document);
    if (update) operations.push({ updateOne: { filter: { _id: document._id }, update } });
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
    const salons = await migrateCollection(Salon.collection, (document) => {
      const set = {};
      if (document.location) {
        const coordinates = salonDomain.getCoordinates(document.location);
        if (coordinates) set.location = coordinates;
      }
      if (Array.isArray(document.services)) {
        set.services = document.services.map((service, index) =>
          serviceForMigration(service, `service-${document.id}-${index}`));
      }
      if (document.pendingContent && typeof document.pendingContent === 'object') {
        const pendingContent = { ...document.pendingContent };
        if (pendingContent.location) {
          const coordinates = salonDomain.getCoordinates(pendingContent.location);
          if (coordinates) pendingContent.location = coordinates;
        }
        if (Array.isArray(pendingContent.services)) {
          pendingContent.services = pendingContent.services.map((service, index) =>
            serviceForMigration(service, `pending-service-${document.id}-${index}`));
        }
        if (Array.isArray(pendingContent.staff)) {
          pendingContent.staff = pendingContent.staff.map(profile => ({
            id: profile.id,
            name: profile.name,
            role: profile.role,
            experience: profile.experience,
            extraServiceFeeFen: profile.extraServiceFeeFen,
            imageUrl: profile.imageUrl,
            bio: profile.bio,
            unavailableSlots: profile.unavailableSlots,
          }));
        }
        set.pendingContent = pendingContent;
      }
      return Object.keys(set).length ? { $set: set } : null;
    });

    const staff = await migrateCollection(StaffProfile.collection, () => ({
      $unset: { extraServiceFee: '' },
    }));

    const bookings = await migrateCollection(Booking.collection, document => ({
      $set: bookingPatch(document),
    }));

    console.log(JSON.stringify({ salons, staff, bookings }));
  } finally {
    await mongoose.disconnect();
  }
};

if (require.main === module) {
  migrate().catch((error) => {
    console.error('Booking domain migration failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { bookingPatch, serviceForMigration };
