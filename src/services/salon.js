const { publicImageUrl } = require('../images');

const PUBLIC_STAFF_REVIEWS_LIMIT = 50;
const PUBLIC_SALON_CACHE_TTL_MS = 15_000;
const PUBLIC_SALON_CACHE_MAX = 100;
const SERVICE_TAG_IDS = Object.freeze([
  'wash_cut_blow',
  'color',
  'perm',
  'care',
  'styling',
  'scalp_care',
  'men',
  'women',
  'straight',
  'curly',
  'nutrition',
]);
const SERVICE_TAG_LABELS = Object.freeze({
  wash_cut_blow: '洗剪吹',
  color: '染发',
  perm: '烫发',
  care: '护理',
  styling: '发型设计',
  scalp_care: '头皮护理',
  men: '男士',
  women: '女士',
  straight: '直发',
  curly: '卷发',
  nutrition: '营养',
});
const SERVICE_TAG_IDS_BY_LABEL = new Map(
  Object.entries(SERVICE_TAG_LABELS).map(([id, label]) => [label, id]),
);
const SERVICE_TAG_ID_SET = new Set(SERVICE_TAG_IDS);
const REVIEW_TAGS = [
  '善于沟通',
  '环境舒适',
  '技术一流',
  '服务周到',
  '无推销',
  '环镜整洁',
  '效果好评',
  '好沟通',
];
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

const normalizeServiceTagIds = tagIds => Array.isArray(tagIds)
  ? [...new Set(tagIds.map(id => String(id || '').trim()).filter(id => SERVICE_TAG_ID_SET.has(id)))].slice(0, 3)
  : [];

const serviceTagIdsFromLegacy = tags => Array.isArray(tags)
  ? normalizeServiceTagIds(tags.map(tag => SERVICE_TAG_IDS_BY_LABEL.get(String(tag || '').trim())))
  : [];

const serviceTagLabels = tagIds => normalizeServiceTagIds(tagIds).map(id => SERVICE_TAG_LABELS[id]);

const resolveServiceTagIds = (service = {}, previous = {}) => {
  const tagIds = normalizeServiceTagIds(service.tagIds);
  if (tagIds.length) return tagIds;
  const legacyTagIds = serviceTagIdsFromLegacy(service.tags);
  if (legacyTagIds.length) return legacyTagIds;
  const previousTagIds = normalizeServiceTagIds(previous.tagIds);
  return previousTagIds.length ? previousTagIds : serviceTagIdsFromLegacy(previous.tags);
};

// Released clients echo unknown tagIds while editing tags; new clients do the inverse.
const incomingServiceTagIds = (service = {}, previous = {}) => {
  const current = resolveServiceTagIds(previous);
  const tagIds = normalizeServiceTagIds(service.tagIds);
  const legacyTagIds = serviceTagIdsFromLegacy(service.tags);
  if (service.tags !== undefined
    && JSON.stringify(tagIds) === JSON.stringify(current)
    && JSON.stringify(legacyTagIds) !== JSON.stringify(current)) {
    return legacyTagIds;
  }
  if (service.tagIds !== undefined) return tagIds;
  if (service.tags !== undefined) return legacyTagIds;
  return current;
};

const normalizeSalonTags = (tags) => Array.isArray(tags)
  ? [...new Set(tags.map(tag => String(tag || '').trim()).filter(Boolean))].slice(0, 5)
  : [];

const normalizeReviewTags = (tags) => Array.isArray(tags)
  ? [...new Set(tags.filter(tag => REVIEW_TAGS.includes(tag)))]
  : [];

const serviceImages = (service = {}) => [...new Set(
  (Array.isArray(service.imageUrls) ? service.imageUrls : [service.imageUrl])
    .filter(image => typeof image === 'string' && image.trim())
    .map(image => image.trim()),
)];

// Old clients may echo the new array unchanged while editing the legacy cover.
const incomingServiceImages = (service, previous = {}) => {
  const current = serviceImages(previous);
  if (service.imageUrls !== undefined
    && !(JSON.stringify(serviceImages(service)) === JSON.stringify(current)
      && service.imageUrl !== undefined && service.imageUrl !== (current[0] || ''))) {
    return serviceImages(service);
  }
  if (service.imageUrl === undefined) return current;
  if (!service.imageUrl) return [];
  return serviceImages({ imageUrls: [service.imageUrl, ...current.slice(1)] });
};

const serviceForStorage = (service = {}, fallbackId = '', previous = {}) => {
  const tagIds = incomingServiceTagIds(service, previous);
  return {
    id: String(service.id || fallbackId).trim(),
    name: String(service.name || '').trim(),
    promotionEnabled: typeof service.promotionEnabled === 'boolean'
      ? service.promotionEnabled
      : previous.promotionEnabled === true,
    tags: serviceTagLabels(tagIds),
    tagIds,
    priceFen: service.priceFen,
    durationMinutes: service.durationMinutes,
    note: String(service.note || ''),
    imageUrl: serviceImages(service)[0] || '',
    imageUrls: serviceImages(service),
  };
};

const servicePayload = (service = {}) => {
  const normalized = serviceForStorage(service, service.id);
  return {
    ...normalized,
    imageUrl: publicImageUrl(normalized.imageUrl),
    imageUrls: normalized.imageUrls.map(publicImageUrl),
  };
};

const staffPayload = (profile = {}) => ({
  ...profile,
  imageUrl: publicImageUrl(profile.imageUrl || ''),
});

const ratingSummary = (reviewCount, ratingTotal) => {
  const count = Number(reviewCount) || 0;
  const total = Number(ratingTotal) || 0;
  return {
    rating: count ? Number((total / count).toFixed(1)) : null,
    reviewCount: count,
    ratingTotal: total,
  };
};

const ratingSummaryFromReviews = (reviews = []) => ratingSummary(
  reviews.length,
  reviews.reduce((sum, review) => sum + Number(review.rating || 0), 0),
);

const buildStaffPayload = (person, reviews = [], summary = ratingSummaryFromReviews(reviews)) => {
  const { reviews: _legacyReviews, rating: _legacyRating, ...profile } = person || {};
  const publicReviews = reviews.slice(0, PUBLIC_STAFF_REVIEWS_LIMIT);
  return {
    ...staffPayload(profile),
    reviews: publicReviews,
    rating: summary.rating,
    reviewCount: summary.reviewCount,
  };
};

const publicReviewFromBooking = (bookingDocument, avatarUrl = '') => {
  const bookingValue = normalizeDocument(bookingDocument);
  const { pendingImageUrls, pendingMerchantReply, pendingEdit, ...review } = bookingValue.review || {};
  if (review.merchantReply?.reviewStatus && review.merchantReply.reviewStatus !== 'approved') {
    delete review.merchantReply;
  }
  return {
    ...review,
    imageUrl: publicImageUrl(review.imageUrl || ''),
    imageUrls: (review.imageUrls || []).map(publicImageUrl),
    avatarUrl: publicImageUrl(avatarUrl),
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
  normalizeSalonTags,
  normalizeReviewTags,
  normalizeServiceTagIds,
  normalizeDocument,
  ratingSummary,
  ratingSummaryFromReviews,
  REVIEW_TAGS,
  SERVICE_TAG_IDS,
  SERVICE_TAG_LABELS,
  publicReviewFromBooking,
  serviceImages,
  serviceTagIdsFromLegacy,
  serviceTagLabels,
  resolveServiceTagIds,
  incomingServiceTagIds,
  incomingServiceImages,
  serviceForStorage,
  servicePayload,
  staffPayload,
  stripSensitiveSalonFields,
  toFiniteNumber,
};
