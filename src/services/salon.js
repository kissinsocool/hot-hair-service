const booking = require('./booking');
const { publicImageUrl } = require('../images');

const PUBLIC_STAFF_REVIEWS_LIMIT = 50;
const PUBLIC_SALON_CACHE_TTL_MS = 15_000;
const PUBLIC_SALON_CACHE_MAX = 100;
const publicSalonDetailCache = new Map();

const normalizeDocument = document => typeof document?.toObject === 'function'
  ? document.toObject()
  : document;

const toFiniteNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const validCoordinates = (latitude, longitude) => latitude !== null && longitude !== null
  && latitude >= -90 && latitude <= 90
  && longitude >= -180 && longitude <= 180;

const getCoordinates = (location) => {
  if (!location) return null;
  if (typeof location === 'string') {
    const [longitude, latitude] = location.split(',').map(toFiniteNumber);
    return validCoordinates(latitude, longitude) ? { latitude, longitude } : null;
  }
  if (Array.isArray(location?.coordinates)) {
    const [longitude, latitude] = location.coordinates.map(toFiniteNumber);
    return validCoordinates(latitude, longitude) ? { latitude, longitude } : null;
  }
  const latitude = toFiniteNumber(location.latitude ?? location.lat);
  const longitude = toFiniteNumber(location.longitude ?? location.lng ?? location.lon);
  return validCoordinates(latitude, longitude) ? { latitude, longitude } : null;
};

const buildGeoLocation = (location) => {
  const coordinates = getCoordinates(location);
  return coordinates
    ? { type: 'Point', coordinates: [coordinates.longitude, coordinates.latitude] }
    : null;
};

const calculateDistanceKm = (from, to) => {
  const toRadians = degrees => degrees * Math.PI / 180;
  const deltaLatitude = toRadians(to.latitude - from.latitude);
  const deltaLongitude = toRadians(to.longitude - from.longitude);
  const startLatitude = toRadians(from.latitude);
  const endLatitude = toRadians(to.latitude);
  const a = Math.sin(deltaLatitude / 2) ** 2
    + Math.cos(startLatitude) * Math.cos(endLatitude) * Math.sin(deltaLongitude / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const normalizeServiceTags = (tags) => {
  const values = Array.isArray(tags) ? tags : typeof tags === 'string' ? tags.split(/[,，、]/) : [];
  return [...new Set(values.map(tag => String(tag || '').trim()).filter(Boolean))].slice(0, 6);
};

const serviceForStorage = (service = {}, fallbackId = '') => ({
  id: String(service.id || fallbackId).trim(),
  name: String(service.name || '').trim(),
  tags: normalizeServiceTags(service.tags),
  priceFen: Number.isSafeInteger(service.priceFen)
    ? service.priceFen
    : booking.priceFen(String(service.price || 0)),
  durationMinutes: Number.isSafeInteger(service.durationMinutes)
    ? service.durationMinutes
    : booking.durationMinutes(service.duration),
  note: String(service.note || ''),
  imageUrl: String(service.imageUrl || ''),
});

const servicePayload = (service = {}) => {
  const normalized = serviceForStorage(service, service.id);
  const amount = normalized.priceFen / 100;
  return {
    ...normalized,
    imageUrl: publicImageUrl(normalized.imageUrl),
    price: `¥${Number.isInteger(amount) ? amount : amount.toFixed(2)}`,
    duration: `${normalized.durationMinutes}分钟`,
  };
};

const staffExtraServiceFeeFen = (profile = {}) => Number.isSafeInteger(profile.extraServiceFeeFen)
  ? profile.extraServiceFeeFen
  : booking.priceFen(String(profile.extraServiceFee || 0));

const staffPayload = (profile = {}) => ({
  ...profile,
  imageUrl: publicImageUrl(profile.imageUrl || ''),
  extraServiceFeeFen: staffExtraServiceFeeFen(profile),
  extraServiceFee: staffExtraServiceFeeFen(profile) / 100,
});

const calculateStaffRating = (reviews = []) => {
  if (!reviews.length) return 5;
  const total = reviews.reduce((sum, review) => sum + Number(review.rating || 0), 0);
  return Number((total / reviews.length).toFixed(1));
};

const buildStaffPayload = (person, reviews = []) => {
  const { reviews: _legacyReviews, rating: _legacyRating, ...profile } = person || {};
  const publicReviews = reviews.slice(0, PUBLIC_STAFF_REVIEWS_LIMIT);
  return {
    ...staffPayload(profile),
    reviews: publicReviews,
    rating: calculateStaffRating(publicReviews),
  };
};

const publicReviewFromBooking = (bookingDocument) => {
  const bookingValue = normalizeDocument(bookingDocument);
  const { pendingImageUrls, pendingMerchantReply, pendingEdit, ...review } = bookingValue.review || {};
  if (review.merchantReply?.reviewStatus && review.merchantReply.reviewStatus !== 'approved') {
    delete review.merchantReply;
  }
  return {
    ...review,
    imageUrl: publicImageUrl(review.imageUrl || ''),
    imageUrls: (review.imageUrls || []).map(publicImageUrl),
    bookingId: review.bookingId || bookingValue.id,
    staffId: bookingValue.staffId,
    staffName: bookingValue.staffName,
  };
};

const groupReviewsByStaff = (reviews = []) => reviews.reduce((grouped, review) => {
  (grouped[review.staffId] ||= []).push(review);
  return grouped;
}, {});

const buildSalonImageList = (salon) => {
  const images = [
    ...(Array.isArray(salon?.promoImages) ? salon.promoImages : []),
    ...(Array.isArray(salon?.images) ? salon.images : []),
  ];
  return [...new Set(images.filter(image => typeof image === 'string' && image.trim()))].slice(0, 20);
};

const stripSensitiveSalonFields = (salon = {}) => {
  const {
    licenseUrl,
    legalPersonIdFrontUrl,
    legalPersonIdBackUrl,
    addressProofUrl,
    licenseStatus,
    licenseRejectReason,
    licenseSubmittedAt,
    licenseReviewedAt,
    pendingContent,
    contentReviewStatus,
    contentRejectReason,
    contentReviewedAt,
    ...publicSalon
  } = salon || {};
  return publicSalon;
};

// ponytail: process-local and short-lived; use Redis only when multiple backend instances need a shared cache.
const buildPublicSalonDetail = async (salonDocument, builder, now = Date.now()) => {
  const salon = normalizeDocument(salonDocument);
  const id = String(salon?.id || salon?._id || '');
  if (!id) return builder(salonDocument);
  const version = new Date(salon.updatedAt || 0).getTime() || 0;
  const key = `${id}:${version}`;
  const cached = publicSalonDetailCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;

  const value = Promise.resolve().then(() => builder(salonDocument));
  publicSalonDetailCache.set(key, { expiresAt: now + PUBLIC_SALON_CACHE_TTL_MS, value });
  while (publicSalonDetailCache.size > PUBLIC_SALON_CACHE_MAX) {
    publicSalonDetailCache.delete(publicSalonDetailCache.keys().next().value);
  }
  try {
    return await value;
  } catch (error) {
    if (publicSalonDetailCache.get(key)?.value === value) publicSalonDetailCache.delete(key);
    throw error;
  }
};

const clearPublicSalonDetailCache = () => publicSalonDetailCache.clear();

module.exports = {
  buildGeoLocation,
  buildPublicSalonDetail,
  buildSalonImageList,
  buildStaffPayload,
  calculateDistanceKm,
  clearPublicSalonDetailCache,
  getCoordinates,
  groupReviewsByStaff,
  normalizeServiceTags,
  normalizeDocument,
  publicReviewFromBooking,
  serviceForStorage,
  servicePayload,
  staffExtraServiceFeeFen,
  staffPayload,
  stripSensitiveSalonFields,
  toFiniteNumber,
};
