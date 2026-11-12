const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const http = require('http');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { WebSocket, WebSocketServer } = require('ws');
const {
  PORT,
  listenHost,
  amapWebServiceKey,
  publicBaseUrl,
  wechatAppId,
  wechatAppSecret,
  wechatBookingStatusTemplateId,
  trustProxyHops,
  wsMaxConnections,
  wsMaxConnectionsPerIp,
  requireQualificationForPublishing,
  pendingBookingTimeoutHours,
  isAllowedOrigin,
} = require('./src/config');
const {
  Booking,
  ReviewHelpful,
  BookingMessage,
  SlotOccupancy,
  UserPolicy,
  FavoriteSalon,
  FavoriteStaff,
  FavoritePost,
  Salon,
  StaffProfile,
  SalonPost,
  MerchantUser,
  AdminUser,
  ClientUser,
  AdConfig,
  CouponCampaign,
  UserCoupon,
  SupportMessage,
  AnalyticsEvent,
  StaffRatingSummary,
} = require('./src/models');
const {
  campaignPayload,
  couponDiscountForOrder,
  couponPayload,
  couponStatus,
  validateCampaignInput,
} = require('./src/coupons');
const {
  deleteModeratedImages,
  publishModeratedImage,
  createMerchantUploadPolicies,
  createModeratedUploadPolicies,
  publicImageUrl,
  privateImageUrl,
  verifyMerchantQualificationObjects,
  verifyModeratedImageObjects,
} = require('./src/images');
const { rateLimits } = require('./src/rate-limit');
const { hashPassword, verifyPassword } = require('./src/passwords');
const {
  connectRedis,
  disconnectRedis,
  getRedisClient,
  publishSessionRevocation,
  subscribeSessionRevocations,
} = require('./src/redis');
const { errorLogger, requestLogger } = require('./src/observability');
const { createPublicResponseCaches } = require('./src/ttl-cache');
const authDomain = require('./src/services/auth');
const bookingDomain = require('./src/services/booking');
const salonDomain = require('./src/services/salon');
const salonPosts = require('./src/services/salon-posts');
const favoritesDomain = require('./src/services/favorites');
const { getSalonReviewsPage, getApprovedReviewTagCountsByStaffIds } = require('./src/services/salon-reviews');
const { refreshStaffRatingSummaries, readStaffRatingSummaries } = require('./src/services/staff-ratings');
const {
  SALON_RATING_STATS_SELECTION,
  refreshSalonRatingSummaries,
  salonRatingSummary,
} = require('./src/services/salon-ratings');
const { addReviewHelpfulState, recordReviewHelpful } = require('./src/services/review-helpful');
const {
  activeSessionQuery,
  buildAdminUserPayload,
  buildClientUserPayload,
  buildMerchantUserPayload,
  createClientUserWithSignupCoupons,
  createSession,
  decryptWechatPhoneNumber,
  getWechatPhoneNumber,
  getWechatOpenId,
  hashSessionToken,
  merchantHasSalon,
  normalizeUserId,
  sessionTokenFromRequest,
  userIdAliases,
} = authDomain;
const { sendBookingAcceptedNotification } = require('./src/services/wechat-subscriptions');
const { completeDueBookings, expirePendingBookings } = require('./src/services/auto-complete-bookings');

const app = express();
const server = http.createServer(app);
const socketConnectionCounts = new Map();
const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: 4 * 1024,
  perMessageDeflate: false,
  verifyClient: ({ origin }, done) => {
    if (!isAllowedOrigin(origin)) return done(false, 403, 'Origin not allowed');
    if (wss.clients.size >= wsMaxConnections) return done(false, 503, 'WebSocket capacity reached');
    done(true);
  },
});

if (trustProxyHops > 0) app.set('trust proxy', trustProxyHops);

// Set once a shutdown signal arrives: /ready reports 503 and responses ask clients to drop keep-alive connections.
let shuttingDown = false;
app.use(requestLogger);
// Behind a reverse proxy every request must carry the real client address, or all clients share one rate-limit
// bucket and one WebSocket quota. Warn once when a proxy header arrives while no proxy hop is trusted.
let untrustedProxyWarned = false;
app.use((req, res, next) => {
  if (shuttingDown) res.set('Connection', 'close');
  if (!untrustedProxyWarned && trustProxyHops === 0 && req.headers['x-forwarded-for']) {
    untrustedProxyWarned = true;
    console.warn(JSON.stringify({
      level: 'warn',
      event: 'proxy_not_trusted',
      message: 'X-Forwarded-For received but TRUST_PROXY_HOPS is 0: rate limits see the proxy address. Set NODE_ENV=production or TRUST_PROXY_HOPS=1.',
    }));
  }
  next();
});
app.use(cors({
  origin: (origin, callback) => {
    if (isAllowedOrigin(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  exposedHeaders: ['X-Total-Count', 'X-Page', 'X-Page-Size', 'X-Has-More'],
}));

app.get('/health', (_req, res) => {
  res.set('Cache-Control', 'no-store').json({ status: 'ok', uptimeSeconds: Math.floor(process.uptime()) });
});
app.get('/ready', (_req, res) => {
  if (shuttingDown) {
    return res.status(503).set('Cache-Control', 'no-store').json({ status: 'shutting_down' });
  }
  const mongoReady = mongoose.connection.readyState === 1;
  const redisRequired = Boolean(String(process.env.REDIS_URL || '').trim());
  const redisReady = !redisRequired || Boolean(getRedisClient());
  res.status(mongoReady && redisReady ? 200 : 503).set('Cache-Control', 'no-store').json({
    status: mongoReady && redisReady ? 'ready' : 'not_ready',
    mongodb: mongoReady ? 'up' : 'down',
    redis: redisReady ? 'up' : 'down',
  });
});
// Images are uploaded to and served from OSS; this process serves no files from local disk.

const normalizeAdLink = (value) => {
  const link = String(value || '').trim();
  if (link.length > 2048) return '';
  if (/^\/pages\/[A-Za-z0-9_/-]+(?:\?[^#\s]*)?$/.test(link) && !link.includes('..')) return link;
  try {
    const url = new URL(link);
    return url.protocol === 'https:' && !url.username && !url.password ? link : '';
  } catch (_) {
    return '';
  }
};

const buildAdPayload = (config) => ({
  imageUrl: publicImageUrl(config?.imageUrl || ''),
  link: normalizeAdLink(config?.link),
  enabled: config?.enabled !== false,
});

const stripSensitiveSalonFields = salonDomain.stripSensitiveSalonFields;

// Review text is not part of this payload: the admin app reads reviews from the moderation endpoints, and loading
// up to 150 reviews per merchant made the merchant list the heaviest request in the service. The reviews fields
// stay as empty lists so the response shape is unchanged. The merchant list passes the stylists and rating
// summaries of the whole page as `preloaded`, so a page costs two queries instead of several per merchant.
const buildAdminMerchantPayload = async (user, salonDocument = {}, preloaded) => {
  const salon = normalizeDocument(salonDocument);
  const staffIds = salon.staffIds || [];
  const [staffMap, ratingSummaries] = preloaded
    ? [preloaded.staffMap, preloaded.ratingSummaries]
    : await Promise.all([getStaffMapByIds(staffIds), getApprovedRatingSummariesByStaffIds(staffIds)]);
  const publicSalon = {
    ...stripSensitiveSalonFields(salon),
    staff: staffIds.map(id => staffMap[id]).filter(Boolean)
      .map(person => buildStaffPayload(person, [], ratingSummaries[person.id])),
  };
  const salonPayload = salon.pendingContent ? { ...publicSalon, ...salon.pendingContent } : publicSalon;
  const liveServices = new Map((publicSalon.services || []).map(service => [service.id, service]));
  salonPayload.services = (salonPayload.services || []).map(service => ({
    ...service,
    ...(liveServices.has(service.id) ? {
      staffSelectionRestricted: liveServices.get(service.id).staffSelectionRestricted === true
        || liveServices.get(service.id).staffSelectionDisabled === true,
      selectableStaffIds: liveServices.get(service.id).selectableStaffIds || [],
      promotionEnabled: liveServices.get(service.id).promotionEnabled,
      promotionReviewStatus: liveServices.get(service.id).promotionReviewStatus,
      promotionRejectReason: liveServices.get(service.id).promotionRejectReason,
      promotionReviewedAt: liveServices.get(service.id).promotionReviewedAt,
    } : {}),
  }));
  salonPayload.staff = (salonPayload.staff || [])
    .map(person => buildStaffPayload(person, [], ratingSummaries[person.id]));
  salonPayload.reviews = [];
  return {
    ...buildMerchantUserPayload(user),
    salonName: salon.name || '',
    publishStatus: salon.publishStatus || 'offline',
    licenseUrl: privateImageUrl(salon.licenseUrl || ''),
    legalPersonIdFrontUrl: privateImageUrl(salon.legalPersonIdFrontUrl || ''),
    legalPersonIdBackUrl: privateImageUrl(salon.legalPersonIdBackUrl || ''),
    addressProofUrl: privateImageUrl(salon.addressProofUrl || ''),
    licenseStatus: salon.licenseStatus || 'unsubmitted',
    licenseRejectReason: salon.licenseRejectReason || '',
    licenseSubmittedAt: salon.licenseSubmittedAt,
    licenseReviewedAt: salon.licenseReviewedAt,
    contentReviewStatus: salon.contentReviewStatus || 'pending',
    contentRejectReason: salon.contentRejectReason || '',
    contentSubmittedAt: salon.contentSubmittedAt || (salon.pendingContent ? salon.updatedAt : undefined),
    contentReviewedAt: salon.contentReviewedAt,
    salon: salonPayload,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt,
  };
};

// The merchant list row: account, review states and the few salon fields the list card shows. Like the full
// payload, name, address and phone prefer the merchant's unreviewed draft. Everything else (services, stylists,
// gallery, the draft itself) is served per merchant by GET /api/admin/merchants/:id.
const ADMIN_MERCHANT_SUMMARY_SALON_PROJECTION = [
  'id', 'name', 'address', 'phone', 'tags', 'businessDistrict', 'isFeatured', 'publishStatus',
  'licenseUrl', 'licenseStatus', 'licenseRejectReason', 'licenseSubmittedAt', 'licenseReviewedAt',
  'contentReviewStatus', 'contentRejectReason', 'contentSubmittedAt', 'contentReviewedAt', 'updatedAt',
  'pendingContent.name', 'pendingContent.address', 'pendingContent.phone',
].join(' ');
const buildAdminMerchantSummary = (user, salonDocument = {}) => {
  const salon = normalizeDocument(salonDocument) || {};
  const draft = salon.pendingContent || {};
  return {
    ...buildMerchantUserPayload(user),
    salonName: salon.name || '',
    publishStatus: salon.publishStatus || 'offline',
    licenseUrl: privateImageUrl(salon.licenseUrl || ''),
    licenseStatus: salon.licenseStatus || 'unsubmitted',
    licenseRejectReason: salon.licenseRejectReason || '',
    licenseSubmittedAt: salon.licenseSubmittedAt,
    licenseReviewedAt: salon.licenseReviewedAt,
    contentReviewStatus: salon.contentReviewStatus || 'pending',
    contentRejectReason: salon.contentRejectReason || '',
    contentSubmittedAt: salon.contentSubmittedAt || (salon.pendingContent ? salon.updatedAt : undefined),
    contentReviewedAt: salon.contentReviewedAt,
    salon: {
      id: salon.id,
      name: draft.name ?? salon.name ?? '',
      address: draft.address ?? salon.address ?? '',
      phone: draft.phone ?? salon.phone ?? '',
      tags: salon.tags || [],
      businessDistrict: salon.businessDistrict || '',
      isFeatured: salon.isFeatured === true,
    },
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt,
  };
};

const socketSubscriptions = new WeakMap();
const closeSocketsBySessionHash = (sessionHash) => {
  if (!sessionHash) return;
  wss.clients.forEach((socket) => {
    if (socketSubscriptions.get(socket)?.sessionHash === sessionHash) {
      socket.close(1008, 'Session expired');
    }
  });
};
const revokeSessionHash = async (sessionHash) => {
  if (!sessionHash) return;
  closeSocketsBySessionHash(sessionHash);
  try {
    await publishSessionRevocation(sessionHash);
  } catch (error) {
    console.error('Session revocation publish error:', error.message);
  }
};
const {
  loginClientByPhone,
  logoutSession,
  requireAdminAuth,
  requireClientAuth,
  requireMerchantAuth,
  rotateSession,
} = authDomain.createAuthService({ revokeSessionHash });

// Request body limits: images upload directly to OSS, so no route needs a large JSON body.
// JSON_LIMIT can tighten the default (e.g. 100kb); merchant salon saves keep 1mb for large service/staff lists.
const MERCHANT_SALON_JSON_PATH = '/api/merchant/salon';
const jsonDefault = express.json({ limit: process.env.JSON_LIMIT || '1mb' });
const jsonMerchantSalon = express.json({ limit: '1mb' });
app.use((req, res, next) => (
  req.path === MERCHANT_SALON_JSON_PATH
    ? jsonMerchantSalon(req, res, next)
    : jsonDefault(req, res, next)
));

const sendSocketMessage = (socket, payload) => {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > 1024 * 1024) {
    socket.close(1013, 'Client is too slow');
    return;
  }
  socket.send(JSON.stringify(payload));
};

const socketCanReceiveBooking = (subscription, booking) => {
  if (!subscription || !booking) return false;
  if (subscription.role === 'admin') return true;
  if (subscription.role === 'merchant') return String(subscription.salonId) === String(booking.salonId);
  return subscription.role === 'client'
    && normalizeUserId(subscription.userId) === normalizeUserId(booking.userId);
};

const broadcastBookingEvent = (event, booking) => {
  const normalized = normalizeBooking(booking);
  const payload = {
    event,
    booking: normalized,
  };

  wss.clients.forEach((client) => {
    if (socketCanReceiveBooking(socketSubscriptions.get(client), normalized)) {
      sendSocketMessage(client, payload);
    }
  });
};

const authenticateSocket = async (role, token) => {
  if (role === 'client') {
    const user = await ClientUser.findOne({
      ...activeSessionQuery(token),
      authProvider: 'wechat',
    }).select('id sessionExpiresAt').lean();
    return user ? { role, userId: normalizeUserId(user.id), sessionExpiresAt: user.sessionExpiresAt, sessionHash: hashSessionToken(token) } : null;
  }
  if (role === 'merchant') {
    const user = await MerchantUser.findOne(activeSessionQuery(token)).select('salonId sessionExpiresAt').lean();
    return merchantHasSalon(user) ? { role, salonId: user.salonId, sessionExpiresAt: user.sessionExpiresAt, sessionHash: hashSessionToken(token) } : null;
  }
  if (role === 'admin') {
    const user = await AdminUser.findOne(activeSessionQuery(token)).select('id sessionExpiresAt').lean();
    return user ? { role, sessionExpiresAt: user.sessionExpiresAt, sessionHash: hashSessionToken(token) } : null;
  }
  return null;
};

const socketIpAddress = (request) => {
  const forwarded = String(request.headers['x-forwarded-for'] || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  return trustProxyHops > 0 && forwarded.length >= trustProxyHops
    ? forwarded[forwarded.length - trustProxyHops]
    : request.socket.remoteAddress || 'unknown';
};

wss.on('connection', (socket, request) => {
  const ipAddress = socketIpAddress(request);
  const connectionCount = socketConnectionCounts.get(ipAddress) || 0;
  if (connectionCount >= wsMaxConnectionsPerIp) {
    socket.close(1013, 'Too many connections');
    return;
  }
  socketConnectionCounts.set(ipAddress, connectionCount + 1);
  socket.on('close', () => {
    const remaining = (socketConnectionCounts.get(ipAddress) || 1) - 1;
    if (remaining > 0) socketConnectionCounts.set(ipAddress, remaining);
    else socketConnectionCounts.delete(ipAddress);
  });

  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });
  socket.on('error', () => {});

  const authTimeout = setTimeout(() => socket.close(1008, 'Authentication timeout'), 5000);
  authTimeout.unref();
  socket.on('close', () => {
    clearTimeout(authTimeout);
    clearTimeout(socket.sessionExpiryTimer);
  });

  sendSocketMessage(socket, {
    event: 'auth.required',
    message: 'Send {"event":"authenticate","role":"client|merchant|admin","token":"..."}.',
  });

  socket.on('message', async (raw, isBinary) => {
    if (socketSubscriptions.has(socket) || socket.authenticating) return;
    if (isBinary) return socket.close(1003, 'Text messages only');

    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return socket.close(1008, 'Invalid authentication message');
    }
    const role = String(message?.role || '').trim();
    const token = String(message?.token || '').trim();
    if (message?.event !== 'authenticate' || !['client', 'merchant', 'admin'].includes(role) || !token || token.length > 256) {
      return socket.close(1008, 'Invalid authentication message');
    }

    socket.authenticating = true;
    try {
      const subscription = await authenticateSocket(role, token);
      if (!subscription) return socket.close(1008, 'Authentication failed');
      socketSubscriptions.set(socket, subscription);
      clearTimeout(authTimeout);
      const closeWhenExpired = () => {
        const remaining = new Date(subscription.sessionExpiresAt).getTime() - Date.now();
        if (remaining <= 0) return socket.close(1008, 'Session expired');
        socket.sessionExpiryTimer = setTimeout(closeWhenExpired, Math.min(remaining, 2147000000));
        socket.sessionExpiryTimer.unref();
      };
      closeWhenExpired();
      sendSocketMessage(socket, { event: 'authenticated', role: subscription.role });
    } catch {
      socket.close(1011, 'Authentication unavailable');
    } finally {
      socket.authenticating = false;
    }
  });
});

const socketHeartbeat = setInterval(() => {
  wss.clients.forEach((socket) => {
    if (!socket.isAlive) return socket.terminate();
    socket.isAlive = false;
    socket.ping();
  });
}, 30000);
socketHeartbeat.unref();
server.on('close', () => clearInterval(socketHeartbeat));

const normalizeDocument = salonDomain.normalizeDocument;
const toFiniteNumber = salonDomain.toFiniteNumber;
const getCoordinates = salonDomain.getCoordinates;
const buildGeoLocation = salonDomain.buildGeoLocation;
const calculateDistanceKm = salonDomain.calculateDistanceKm;

const normalizeLimit = (value, fallback = 50, max = 100) => {
  const limit = Math.floor(Number(value));
  return Number.isFinite(limit) && limit > 0 ? Math.min(limit, max) : fallback;
};

const normalizeRadiusKm = (value, fallback, max, min = 0.1) => {
  const radius = toFiniteNumber(value);
  return radius === null ? fallback : Math.min(Math.max(radius, min), max);
};

const normalizePagination = (query = {}, fallback = 50, max = 100) => {
  const requestedPage = Math.floor(Number(query.page));
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? Math.min(requestedPage, 10000) : 1;
  const limit = normalizeLimit(query.limit, fallback, max);
  return { page, limit, skip: (page - 1) * limit };
};

const buildMerchantBookingScope = bookingDomain.buildMerchantBookingScope;

const setPaginationHeaders = (res, pagination, total) => {
  res.set({
    'X-Total-Count': String(total),
    'X-Page': String(pagination.page),
    'X-Page-Size': String(pagination.limit),
  });
};

const INPUT_LIMITS = Object.freeze({
  complaint: 2000,
  contentStaff: 50,
  note: 500,
  review: 1000,
  reviewReply: 1000,
  services: 50,
  closedDates: 500,
  unavailableSlots: 500,
});

// The public salon list renders cards only: drop private fields and heavy detail fields at the query.
// staffIds, images and location stay because ratings, cover images and distances are derived from them.
const SALON_LIST_EXCLUDED_FIELDS = Object.freeze([
  'licenseUrl', 'legalPersonIdFrontUrl', 'legalPersonIdBackUrl', 'addressProofUrl', 'licenseStatus',
  'licenseRejectReason', 'licenseSubmittedAt', 'licenseReviewedAt', 'pendingContent', 'contentReviewStatus',
  'contentRejectReason', 'contentReviewedAt', 'bookingCreationFence',
  'services', 'fullDescription', 'openingHours', 'weeklyClosedDays', 'afterSalesPolicyIds', 'phone', 'staff', 'reviews',
]);
const SALON_LIST_PROJECTION = SALON_LIST_EXCLUDED_FIELDS.map(field => `-${field}`).join(' ');

const findNearbySalons = async (userLocation, radiusKm, limit, skip = 0, keyword = '') => {
  const query = {
    publishStatus: 'online',
    ...(keyword ? { name: { $regex: keyword, $options: 'i' } } : {}),
    geoLocation: {
      $nearSphere: {
        $geometry: {
          type: 'Point',
          coordinates: [userLocation.longitude, userLocation.latitude],
        },
        ...(radiusKm == null ? {} : { $maxDistance: Math.max(radiusKm, 0.1) * 1000 }),
      },
    },
  };
  const salonList = await Salon.find(query)
    .select(`${SALON_LIST_PROJECTION} ${SALON_RATING_STATS_SELECTION}`)
    .skip(skip).limit(limit).lean();
  return salonList
    .map((salon) => {
      const salonLocation = getCoordinates(salon.location || salon.geoLocation);
      return salonLocation
        ? { ...salon, distanceKm: Number(calculateDistanceKm(userLocation, salonLocation).toFixed(2)) }
        : salon;
    });
};

const getNearbySalons = async (userLocation, _radiusKm, limit, minResults = 10, maxRadiusKm = 50, skip = 0, keyword = '', sort = 'distance') => {
  if (sort === 'rating') {
    const geoNear = radiusKm => ({ $geoNear: {
      near: { type: 'Point', coordinates: [userLocation.longitude, userLocation.latitude] },
      distanceField: 'distanceMeters',
      spherical: true,
      key: 'geoLocation',
      query: {
        publishStatus: 'online',
        ...(keyword ? { name: { $regex: keyword, $options: 'i' } } : {}),
      },
      ...(radiusKm == null ? {} : { maxDistance: Math.max(radiusKm, 0.1) * 1000 }),
    } });
    const probe = await Salon.aggregate([geoNear(maxRadiusKm), { $limit: minResults }, { $count: 'count' }]);
    const radiusKm = (probe[0]?.count || 0) < minResults ? null : maxRadiusKm;
    return Salon.aggregate([
      geoNear(radiusKm),
      { $unset: [...SALON_LIST_EXCLUDED_FIELDS] },
      // Salon ratings are stored on the salon (see services/salon-ratings.js), so sorting needs no lookup.
      { $set: {
        reviewCount: { $ifNull: ['$ratingStats.reviewCount', 0] },
        ratingTotal: { $ifNull: ['$ratingStats.ratingTotal', 0] },
      } },
      { $set: {
        rating: { $cond: [
          { $gt: ['$reviewCount', 0] },
          { $divide: [
            { $floor: { $add: [
              { $divide: [{ $multiply: ['$ratingTotal', 100] }, '$reviewCount'] },
              0.5,
            ] } },
            100,
          ] },
          null,
        ] },
        distanceKm: { $round: [{ $divide: ['$distanceMeters', 1000] }, 2] },
      } },
      { $sort: { rating: -1, distanceKm: 1, id: 1 } },
      { $skip: skip },
      { $limit: limit },
      { $unset: ['ratingStats', 'ratingTotal', 'distanceMeters'] },
    ]).option({ maxTimeMS: 5000, allowDiskUse: true });
  }
  const probeLimit = skip ? minResults : limit;
  const nearbySalons = await findNearbySalons(userLocation, maxRadiusKm, probeLimit, 0, keyword);
  if (nearbySalons.length < minResults) {
    return findNearbySalons(userLocation, null, limit, skip, keyword);
  }
  return skip ? findNearbySalons(userLocation, maxRadiusKm, limit, skip, keyword) : nearbySalons;
};

const getServiceById = async (serviceId) => {
  const salon = await Salon.findOne({ 'services.id': serviceId }).select('services').lean();
  return salon?.services?.find(item => item.id === serviceId) || null;
};

// Every caller reads the salon for slots, staff details or booking checks and never saves it.
const getSalonByStaffId = (staffId) => Salon.findOne({ staffIds: staffId })
  .select(salonDomain.BOOKING_SALON_PROJECTION);

const getStaffById = (staffId) => StaffProfile.findOne({ id: staffId });

const getStaffMapByIds = async (staffIds = []) => {
  const profiles = await StaffProfile.find({ id: { $in: staffIds } }).lean();
  return Object.fromEntries(profiles.map(profile => [profile.id, profile]));
};

const validateSalonStaffIds = async (salon, profiles, allowPending = false) => {
  const ids = profiles.map(profile => String(profile?.id || '').trim()).filter(Boolean);
  if (new Set(ids).size !== ids.length) return '理发师 ID 不能重复';
  const owned = new Set((salon.staffIds || []).map(String));
  const allowed = new Set(owned);
  if (allowPending) {
    (salon.pendingContent?.staff || []).forEach(profile => allowed.add(String(profile.id)));
  }
  if (ids.some(id => !allowed.has(id))) return '理发师不属于当前店铺';
  if (ids.length && await Salon.exists({ id: { $ne: salon.id }, staffIds: { $in: ids } })) {
    return '理发师已关联其他店铺';
  }
  const notYetOwned = ids.filter(id => !owned.has(id));
  if (notYetOwned.length && await StaffProfile.exists({ id: { $in: notYetOwned } })) {
    return '理发师 ID 已存在';
  }
  return '';
};

const formatMinutesAsTime = bookingDomain.formatMinutesAsTime;
const parseOpeningHours = bookingDomain.parseOpeningHours;

const normalizeDeposit = (deposit) => {
  const value = Number(String(deposit ?? 0).replace(/[^\d.-]/g, ''));
  return Number.isFinite(value) && value >= 0 ? value : null;
};

const fetchJson = async (url, options = {}) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { 'User-Agent': 'hot-hair-service/1.0', ...(options.headers || {}) },
    });
    if (!response.ok) return null;
    return response.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
};

const parseAmapReverseAddress = (data) => {
  const raw = data?.regeocode;
  if (!raw || typeof raw !== 'object') return '';
  const address = String(raw.formatted_address || '').trim();
  if (address) return address;

  const component = raw.addressComponent;
  if (!component || typeof component !== 'object') return '';
  return [
    component.province,
    component.city,
    component.district,
    component.township,
  ].map(part => String(part || '').trim()).filter(Boolean).join('');
};

const generateHalfHourSlots = bookingDomain.generateHalfHourSlots;
const normalizeUnavailableSlots = bookingDomain.normalizeUnavailableSlots;
const normalizeClosedDates = bookingDomain.normalizeClosedDates;
const normalizeWeeklyClosedDays = bookingDomain.normalizeWeeklyClosedDays;
const expandedSalonClosedDates = bookingDomain.expandedSalonClosedDates;
const isSalonClosedOnDate = bookingDomain.isSalonClosedOnDate;

const isSameDayBookingBlocked = bookingDomain.isSameDayBookingBlocked;

const isStaffUnavailable = async (staffId, startTime, duration = 30) => {
  const person = await getStaffById(staffId).lean();
  if (!person) return false;
  if (isSalonClosedOnDate({ weeklyClosedDays: person.weeklyClosedDays }, startTime)) return true;
  const unavailable = new Set(normalizeUnavailableSlots(person.unavailableSlots));
  return bookingDomain.occupiedSlotStarts(startTime, duration).some(slot =>
    unavailable.has(`${bookingDomain.localDateKey(slot)} ${bookingDomain.formatMinutesAsTime(bookingDomain.localTimeMinutes(slot))}`));
};

const findActiveBookingAtTime = (staffId, startTime) =>
  Booking.findOne({
    staffId,
    startTime: bookingDomain.parseBookingTime(startTime),
    status: { $in: ['pending', 'accepted'] },
  });

const findActiveBookingAtTimeExcluding = (staffId, startTime, bookingId) =>
  Booking.findOne({
    staffId,
    startTime: bookingDomain.parseBookingTime(startTime),
    id: { $ne: bookingId },
    status: { $in: ['pending', 'accepted'] },
  });

const parseMerchantRescheduleTime = bookingDomain.parseMerchantRescheduleTime;
const acceptedBookingAtTimeQuery = bookingDomain.acceptedBookingAtTimeQuery;

const findAcceptedBookingAtTimeExcluding = (staffId, startTime, bookingId) =>
  Booking.findOne(acceptedBookingAtTimeQuery(staffId, startTime, bookingId));

const normalizeBookingPayload = bookingDomain.normalizeBookingPayload;

const normalizeBooking = booking => normalizeBookingPayload(booking);
const normalizeMerchantBooking = booking => normalizeBookingPayload(booking, true);

const USER_CANCEL_WINDOW_MS = 3 * 60 * 60 * 1000;
const BLACKLIST_NO_SHOW_LIMIT = 3;

// Called inside the booking-creation transaction. The fence write makes parallel submissions by one client
// conflict, so the active-booking cap counted in that transaction cannot be passed by a burst of requests.
const getUserPolicy = async (userId, session) =>
  UserPolicy.findOneAndUpdate(
    { userId },
    {
      $setOnInsert: { userId, noShowCount: 0, isBlacklisted: false },
      $inc: { bookingCreationFence: 1 },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true, session },
  );

const updateNoShowCount = (userId, delta, session) => {
  const incrementing = delta > 0;
  const nextCount = { $add: [{ $ifNull: ['$noShowCount', 0] }, delta] };
  return UserPolicy.findOneAndUpdate(
    incrementing ? { userId } : { userId, noShowCount: { $gt: 0 } },
    [{
      $set: {
        userId,
        noShowCount: nextCount,
        isBlacklisted: { $gte: [nextCount, BLACKLIST_NO_SHOW_LIMIT] },
        updatedAt: new Date(),
      },
    }],
    { upsert: incrementing, new: true, updatePipeline: true, session },
  );
};

const incrementNoShowCount = (userId, session) => updateNoShowCount(userId, 1, session);
const reverseNoShowCount = (userId, session) => updateNoShowCount(userId, -1, session);

const PUBLIC_SALON_REVIEWS_LIMIT = 150;
// The salon detail page previews this many reviews; the rest come from /api/salons/:id/reviews.
const PUBLIC_SALON_DETAIL_REVIEWS_LIMIT = 3;
const buildStaffPayload = salonDomain.buildStaffPayload;
const buildPublicStaffSummary = salonDomain.buildPublicStaffSummary;
const publicReviewFromBooking = salonDomain.publicReviewFromBooking;

const getApprovedReviewsByStaffIds = async (staffIds = [], limit = PUBLIC_SALON_REVIEWS_LIMIT) => {
  const ids = [...new Set(staffIds.map(String).filter(Boolean))];
  if (!ids.length) return [];
  const bookings = await Booking.find({
    staffId: { $in: ids },
    'review.reviewStatus': 'approved',
  })
    .select('id userId staffId staffName review updatedAt')
    .sort({ updatedAt: -1 })
    .limit(limit)
    .lean();
  const userIds = [...new Set(bookings.flatMap(booking => userIdAliases(booking.userId)))];
  const users = userIds.length
    ? await ClientUser.find({ id: { $in: userIds } }).select('id avatarUrl').lean()
    : [];
  const avatars = new Map(users.map(user => [normalizeUserId(user.id), user.avatarUrl]));
  return bookings.map(booking => publicReviewFromBooking(
    booking,
    avatars.get(normalizeUserId(booking.userId)) || '',
  ));
};

// Reads the stored per-stylist totals maintained by refreshStaffRatingSummaries.
const getApprovedRatingSummariesByStaffIds = staffIds => readStaffRatingSummaries(staffIds);

// Turns the stored totals each salon was read with (SALON_RATING_STATS_SELECTION) into its public rating.
// Async because callers await it; it runs no query.
const addApprovedSalonRatings = async (salons = []) => salons.map(({ ratingStats, ...salon }) => ({
  ...salon,
  ...salonRatingSummary({ ratingStats }),
}));

// Salon lists are read without services (SALON_LIST_EXCLUDED_FIELDS), so the "from" price of a page of salons
// comes from one extra read of only the fields that decide it.
const getCutPriceFromFenBySalonIds = async (salonIds = []) => {
  if (!salonIds.length) return new Map();
  const salons = await Salon.find({ id: { $in: salonIds } })
    .select('id services.priceFen services.tagIds services.tags')
    .lean();
  return new Map(salons.map(salon => [salon.id, salonDomain.cutPriceFromFen(salon.services)]));
};

const groupReviewsByStaff = salonDomain.groupReviewsByStaff;
const buildSalonImageList = salonDomain.buildSalonImageList;

const existingSalonImages = async salon => buildSalonImageList(salon).map(publicImageUrl);

const salonCoverImage = async (salon) => {
  const cover = [salon?.image, ...buildSalonImageList(salon)]
    .find(image => typeof image === 'string' && image.trim());
  return publicImageUrl(cover || '');
};

const buildSalonDetail = async (salonDocument) => {
  const salon = normalizeDocument(salonDocument);
  const staffMap = await getStaffMapByIds(salon.staffIds);
  const staffList = salon.staffIds.map(id => staffMap[id]).filter(Boolean);
  const [reviewPage, ratingSummaries] = await Promise.all([
    getSalonReviewsPage(salon, { page: 1, limit: PUBLIC_SALON_DETAIL_REVIEWS_LIMIT, skip: 0 }, 'latest'),
    getApprovedRatingSummariesByStaffIds(salon.staffIds),
  ]);
  const images = await existingSalonImages(salon);
  const staff = staffList.map(person => buildPublicStaffSummary(
    person,
    ratingSummaries[person.id],
  ));
  const publicSalon = stripSensitiveSalonFields(salon);
  const { rating, reviewCount } = salonRatingSummary(salon);
  return {
    ...publicSalon,
    rating,
    reviewCount,
    services: (publicSalon.services || []).map(salonDomain.servicePayload),
    image: await salonCoverImage(salon),
    images,
    promoImages: images,
    staff,
    reviews: reviewPage.items,
    reviewTags: reviewPage.reviewTags,
  };
};

const PUBLIC_SALON_DETAIL_PROJECTION = '-licenseUrl -legalPersonIdFrontUrl -legalPersonIdBackUrl -addressProofUrl -licenseStatus -licenseRejectReason -licenseSubmittedAt -licenseReviewedAt -pendingContent -contentReviewStatus -contentRejectReason -contentReviewedAt';

// The detail cache is keyed by salon id and updatedAt, so the route reads only those two fields and the full
// salon document is loaded only when the cached detail is missing or stale. Null when it went offline meanwhile.
const buildSalonDetailFromVersion = async (current) => {
  const salon = await Salon.findOne({ id: current.id, publishStatus: 'online' })
    .select(`${PUBLIC_SALON_DETAIL_PROJECTION} ${SALON_RATING_STATS_SELECTION}`);
  return salon ? buildSalonDetail(salon) : null;
};

const buildPublicSalonDetail = (salonDocument, builder = buildSalonDetailFromVersion, now = Date.now()) =>
  salonDomain.buildPublicSalonDetail(salonDocument, async document => {
    const detail = await builder(document);
    if (!detail) return null;
    if (detail.closedDates === undefined && detail.weeklyClosedDays === undefined) return detail;
    return {
      ...detail,
      weeklyClosedDays: normalizeWeeklyClosedDays(detail.weeklyClosedDays),
      closedDates: expandedSalonClosedDates(detail, new Date(now)),
    };
  }, now);
const clearPublicSalonDetailCache = salonDomain.clearPublicSalonDetailCache;

// ponytail: process-local, like the salon detail cache; several backend instances would need to broadcast these.
const publicResponseCaches = createPublicResponseCaches();
const clearAdCache = () => publicResponseCaches.ad.clear();
const clearCouponCampaignCache = () => publicResponseCaches.couponCampaign.clear();
// The promoted gallery is built from every online salon's services, images, promotion review state and publish
// state. Rather than track which salon fields matter, every route that saves a salon clears it.
const clearPromotedServicesCache = () => publicResponseCaches.promotedServices.clear();

const contentFields = [
  'name',
  'address',
  'addressRegion',
  'addressDetail',
  'location',
  'description',
  'fullDescription',
  'afterSalesPolicyIds',
  'image',
  'images',
  'promoImages',
  'openingHours',
  'acceptsSameDayBooking',
  'weeklyClosedDays',
  'closedDates',
  'phone',
  'services',
  'staff',
];

const normalizeSalonTags = salonDomain.normalizeSalonTags;
const normalizeAfterSalesPolicyIds = salonDomain.normalizeAfterSalesPolicyIds;
const normalizeServiceTagIds = salonDomain.normalizeServiceTagIds;

const hasReviewableContentChanges = (current = {}, payload = {}) => {
  const changed = (field, normalize = value => value) =>
    payload[field] !== undefined
    && JSON.stringify(normalize(payload[field])) !== JSON.stringify(normalize(current[field]));
  const text = value => String(value || '').trim();
  const images = value => (Array.isArray(value) ? value : [])
    .map(item => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 20);

  if (['name', 'address', 'addressDetail', 'description', 'fullDescription', 'image'].some(field => changed(field, text))) return true;
  if (changed('addressRegion') || changed('location')) return true;
  if (payload.images !== undefined || payload.promoImages !== undefined) {
    const incoming = payload.promoImages ?? payload.images;
    const currentImages = new Set(images(current.promoImages ?? current.images));
    if (images(incoming).some(image => !currentImages.has(image))) return true;
  }

  const currentServices = new Map((current.services || []).map(item => [String(item.id || ''), item]));
  if ((payload.services || []).some(service => {
    const previous = currentServices.get(String(service?.id || '')) || {};
    const previousImages = new Set(salonDomain.serviceImages(previous));
    if (salonDomain.incomingServiceImages(service, previous).some(image => !previousImages.has(image))) return true;
    return ['name', 'note'].some(field =>
      service?.[field] !== undefined && text(service[field]) !== text(previous[field]));
  })) return true;

  const currentStaff = new Map((current.staff || []).map(item => [String(item.id || ''), item]));
  return (payload.staff || []).some(profile => {
    const previous = currentStaff.get(String(profile?.id || '')) || {};
    return ['name', 'bio', 'imageUrl'].some(field =>
      profile?.[field] !== undefined && text(profile[field]) !== text(previous[field]));
  });
};

const applyDirectSalonContent = async (salon, payload = {}) => {
  const set = (key, value) => {
    if (value !== undefined) salon[key] = value;
  };
  set('openingHours', typeof payload.openingHours === 'string' ? payload.openingHours : undefined);
  set('acceptsSameDayBooking', typeof payload.acceptsSameDayBooking === 'boolean' ? payload.acceptsSameDayBooking : undefined);
  set('afterSalesPolicyIds', Array.isArray(payload.afterSalesPolicyIds)
    ? normalizeAfterSalesPolicyIds(payload.afterSalesPolicyIds)
    : undefined);
  set('weeklyClosedDays', Array.isArray(payload.weeklyClosedDays)
    ? normalizeWeeklyClosedDays(payload.weeklyClosedDays)
    : undefined);
  set('closedDates', Array.isArray(payload.closedDates) ? normalizeClosedDates(payload.closedDates) : undefined);
  set('phone', typeof payload.phone === 'string' ? payload.phone : undefined);
  if (payload.image === '') salon.image = '';
  if (Array.isArray(payload.promoImages) || Array.isArray(payload.images)) {
    const currentImages = new Set(buildSalonImageList(salon));
    const retained = [...new Set((payload.promoImages ?? payload.images)
      .map(image => String(image || '').trim())
      .filter(Boolean))]
      .filter(image => currentImages.has(image));
    salon.images = retained;
    salon.promoImages = retained;
  }
  if (Array.isArray(payload.services)) {
    const currentServices = new Map((salon.services || []).map(item => [String(item.id || ''), item]));
    salon.services = payload.services.flatMap((service, index) => {
      const id = String(service?.id || `s1-${Date.now()}-${index}`).trim();
      const previous = currentServices.get(id);
      if (!previous) return [];
      const current = normalizeDocument(previous);
      const promotion = {
        enabled: current.promotionEnabled === true,
        status: current.promotionReviewStatus || (current.promotionEnabled ? 'approved' : 'unsubmitted'),
        reason: current.promotionRejectReason || '',
        reviewedAt: current.promotionReviewedAt,
      };
      const promotionCategoryChanged = JSON.stringify(salonDomain.incomingServiceTagIds(service, current))
        !== JSON.stringify(salonDomain.resolveServiceTagIds(current));
      if (typeof service.promotionEnabled === 'boolean') {
        if (service.promotionEnabled && !promotion.enabled) {
          promotion.status = 'pending';
          promotion.reason = '';
          promotion.reviewedAt = undefined;
        } else if (!service.promotionEnabled
          && (promotion.enabled || promotion.status === 'pending')) {
          promotion.enabled = false;
          promotion.status = 'unsubmitted';
          promotion.reason = '';
          promotion.reviewedAt = undefined;
        }
      }
      if (promotion.enabled && promotionCategoryChanged) {
        promotion.enabled = false;
        promotion.status = 'pending';
        promotion.reason = '';
        promotion.reviewedAt = undefined;
      }
      return [salonDomain.serviceForStorage({
        ...current,
        promotionEnabled: promotion.enabled,
        promotionReviewStatus: promotion.status,
        promotionRejectReason: promotion.reason,
        promotionReviewedAt: promotion.reviewedAt,
        tagIds: service.tagIds,
        tags: service.tags,
        priceFen: service.priceFen ?? current.priceFen,
        originalPriceFen: service.originalPriceFen === undefined
          ? current.originalPriceFen
          : service.originalPriceFen,
        discountTenths: service.discountTenths === undefined
          ? current.discountTenths
          : service.discountTenths,
        staffSelectionRestricted: typeof service.staffSelectionRestricted === 'boolean'
          ? service.staffSelectionRestricted
          : typeof service.staffSelectionDisabled === 'boolean'
            ? service.staffSelectionDisabled
            : current.staffSelectionRestricted === true || current.staffSelectionDisabled === true,
        selectableStaffIds: service.selectableStaffIds ?? current.selectableStaffIds ?? [],
        durationMinutes: service.durationMinutes ?? current.durationMinutes,
        note: service.note === '' ? '' : current.note,
        imageUrls: salonDomain.incomingServiceImages(service, current)
          .filter(image => salonDomain.serviceImages(current).includes(image)),
        id,
      }, id, current)];
    });
  }

  if (Array.isArray(payload.staff)) {
    const ids = payload.staff.map(profile => String(profile?.id || '').trim()).filter(Boolean);
    const currentStaff = await getStaffMapByIds(ids);
    const directStaff = payload.staff.filter(profile => currentStaff[profile?.id]);
    salon.staffIds = directStaff.map(profile => profile.id);
    await Promise.all(directStaff.map(profile => StaffProfile.updateOne(
      { id: profile.id },
      { $set: {
        roleId: salonDomain.normalizeStaffRoleId(profile.roleId),
        experience: profile.experience || '',
        extraServiceFeeFen: profile.extraServiceFeeFen,
        ...(profile.bio === '' ? { bio: '' } : {}),
        ...(profile.imageUrl === '' ? { imageUrl: '' } : {}),
        weeklyClosedDays: normalizeWeeklyClosedDays(profile.weeklyClosedDays),
        unavailableSlots: normalizeUnavailableSlots(profile.unavailableSlots),
      }, $unset: { role: '' } },
    )));
  }
};

const buildContentDraft = async (salon, payload, liveContent) => {
  const base = normalizeDocument(salon.pendingContent) || liveContent || await buildSalonDetail(salon);
  const draft = structuredClone(base);
  const set = (key, value) => {
    if (value !== undefined) draft[key] = value;
  };

  set('name', typeof payload.name === 'string' ? payload.name.trim() : undefined);
  set('address', typeof payload.address === 'string' ? payload.address : undefined);
  set('addressRegion', payload.addressRegion && typeof payload.addressRegion === 'object' ? payload.addressRegion : undefined);
  set('addressDetail', typeof payload.addressDetail === 'string' ? payload.addressDetail : undefined);
  set('location', payload.location && typeof payload.location === 'object'
    ? getCoordinates(payload.location)
    : undefined);
  set('description', typeof payload.description === 'string' ? payload.description : undefined);
  set('fullDescription', typeof payload.fullDescription === 'string' ? payload.fullDescription : undefined);
  set('afterSalesPolicyIds', Array.isArray(payload.afterSalesPolicyIds)
    ? normalizeAfterSalesPolicyIds(payload.afterSalesPolicyIds)
    : undefined);
  set('image', typeof payload.image === 'string' ? payload.image : undefined);
  set('openingHours', typeof payload.openingHours === 'string' ? payload.openingHours : undefined);
  set('acceptsSameDayBooking', typeof payload.acceptsSameDayBooking === 'boolean' ? payload.acceptsSameDayBooking : undefined);
  set('weeklyClosedDays', Array.isArray(payload.weeklyClosedDays)
    ? normalizeWeeklyClosedDays(payload.weeklyClosedDays)
    : undefined);
  set('closedDates', Array.isArray(payload.closedDates) ? normalizeClosedDates(payload.closedDates) : undefined);
  set('phone', typeof payload.phone === 'string' ? payload.phone : undefined);

  if (Array.isArray(payload.promoImages) || Array.isArray(payload.images)) {
    const incomingImages = Array.isArray(payload.promoImages) ? payload.promoImages : payload.images;
    draft.promoImages = [
      ...new Set(incomingImages.map(item => item?.toString().trim()).filter(Boolean)),
    ].slice(0, 20);
    draft.images = draft.promoImages;
  }

  if (Array.isArray(payload.services)) {
    draft.services = payload.services
      .filter(service => service && service.name)
      .map((service, index) => {
        const previous = (base.services || []).find(item => item.id === service.id) || {};
        return salonDomain.serviceForStorage(
          { ...service, imageUrls: salonDomain.incomingServiceImages(service, previous) },
          `s1-${Date.now()}-${index}`,
          previous,
        );
      });
  }

  if (Array.isArray(payload.staff)) {
    draft.staff = payload.staff
      .filter(profile => profile && profile.name)
      .map((profile, index) => {
        const id = profile.id || `merchant-staff-${crypto.randomUUID()}`;
        return {
          id,
          name: profile.name,
          roleId: salonDomain.normalizeStaffRoleId(profile.roleId),
          experience: profile.experience || '',
          extraServiceFeeFen: profile.extraServiceFeeFen,
          imageUrl: profile.imageUrl || '',
          bio: profile.bio || '',
          weeklyClosedDays: normalizeWeeklyClosedDays(profile.weeklyClosedDays),
          unavailableSlots: normalizeUnavailableSlots(profile.unavailableSlots),
        };
      });
  }

  if (Array.isArray(draft.staff)) {
    draft.staff = draft.staff.map(({ reviews, rating, ...profile }) => profile);
  }

  return Object.fromEntries(contentFields.map(key => [key, draft[key]]));
};

const applyPendingContent = async (salon) => {
  const draft = normalizeDocument(salon.pendingContent) || {};
  if (Array.isArray(draft.staff)) {
    const staffError = await validateSalonStaffIds(salon, draft.staff, true);
    if (staffError) throw Object.assign(new Error(staffError), { httpStatus: 409 });
  }
  contentFields
    .filter(key => key !== 'staff' && key !== 'services')
    .forEach(key => {
      if (draft[key] !== undefined) salon[key] = draft[key];
    });
  if (draft.location !== undefined) salon.geoLocation = buildGeoLocation(draft.location);

  if (Array.isArray(draft.services)) {
    const currentServices = new Map((salon.services || [])
      .map(service => [String(service.id || ''), normalizeDocument(service)]));
    salon.services = draft.services.map((service, index) => {
      const id = String(service.id || `s1-${Date.now()}-${index}`);
      const current = currentServices.get(id);
      const promotionRequested = !current && service.promotionEnabled === true;
      return salonDomain.serviceForStorage({
        ...service,
        staffSelectionRestricted: current
          ? current.staffSelectionRestricted === true || current.staffSelectionDisabled === true
          : service.staffSelectionRestricted === true || service.staffSelectionDisabled === true,
        selectableStaffIds: current ? current.selectableStaffIds : service.selectableStaffIds,
        promotionEnabled: current?.promotionEnabled === true,
        promotionReviewStatus: current?.promotionReviewStatus
          || (promotionRequested ? 'pending' : 'unsubmitted'),
        promotionRejectReason: current?.promotionRejectReason || '',
        promotionReviewedAt: current?.promotionReviewedAt,
      }, id, current || {});
    });
  }

  if (Array.isArray(draft.staff)) {
    const owned = new Set((salon.staffIds || []).map(String));
    // A draft can wait for review; slots that passed in the meantime are not published.
    const approvedStaff = bookingDomain.withoutExpiredStaffUnavailableSlots(draft.staff).map(profile => ({
      ...profile,
      id: owned.has(String(profile.id)) ? profile.id : `merchant-staff-${crypto.randomUUID()}`,
    }));
    const approvedIds = new Map(draft.staff.map((profile, index) => [profile.id, approvedStaff[index].id]));
    for (const service of salon.services || []) {
      service.selectableStaffIds = (service.selectableStaffIds || [])
        .filter(id => approvedIds.has(id)).map(id => approvedIds.get(id));
    }
    salon.staffIds = approvedStaff.map(profile => profile.id).filter(Boolean);
    await Promise.all(approvedStaff.map(profile =>
      StaffProfile.findOneAndUpdate(
        { id: profile.id },
        { $set: profile, $unset: { role: '' } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
    ));
  }

  salon.pendingContent = undefined;
};

const buildMerchantSalonPayload = async (salonId) => {
  const salon = await Salon.findOne({ id: salonId }).select(SALON_RATING_STATS_SELECTION);
  if (!salon) return null;
  const payload = await buildSalonDetail(salon);
  const merged = {
    ...payload,
    ...(normalizeDocument(salon.pendingContent) || {}),
    contentReviewStatus: salon.contentReviewStatus || 'pending',
    contentRejectReason: salon.contentRejectReason || '',
    contentReviewedAt: salon.contentReviewedAt,
  };
  const liveServices = new Map((payload.services || []).map(service => [service.id, service]));
  merged.services = (merged.services || []).map(service => salonDomain.servicePayload({
    ...service,
    ...(liveServices.has(service.id) ? {
      staffSelectionRestricted: liveServices.get(service.id).staffSelectionRestricted === true
        || liveServices.get(service.id).staffSelectionDisabled === true,
      selectableStaffIds: liveServices.get(service.id).selectableStaffIds || [],
      promotionEnabled: liveServices.get(service.id).promotionEnabled,
      promotionReviewStatus: liveServices.get(service.id).promotionReviewStatus,
      promotionRejectReason: liveServices.get(service.id).promotionRejectReason,
      promotionReviewedAt: liveServices.get(service.id).promotionReviewedAt,
    } : {}),
  }));
  const reviewsByStaff = groupReviewsByStaff(payload.reviews);
  const liveStaff = Object.fromEntries((payload.staff || []).map(person => [person.id, person]));
  merged.staff = (merged.staff || [])
    .map((person) => {
      const live = liveStaff[person.id];
      const summary = live ? { techniqueRating: live.rating, reviewCount: live.reviewCount } : undefined;
      return buildStaffPayload(person, reviewsByStaff[person.id] || [], summary);
    });
  merged.reviews = payload.reviews;
  return merged;
};

const ensureSalonForMerchant = async ({ salonId, displayName }) => {
  const normalizedSalonId = String(salonId || '').trim();
  const existingSalon = await Salon.findOne({ id: normalizedSalonId });
  if (existingSalon) return existingSalon;

  return Salon.create({
    id: normalizedSalonId,
    name: '',
    address: '',
    addressRegion: {},
    addressDetail: '',
    location: null,
    geoLocation: null,
    image: '',
    images: [],
    promoImages: [],
    tags: [],
    description: '',
    fullDescription: '',
    afterSalesPolicyIds: [],
    openingHours: '10:00 - 20:00',
    acceptsSameDayBooking: true,
    weeklyClosedDays: [],
    closedDates: [],
    phone: '',
    staffIds: [],
    services: [],
    publishStatus: 'offline',
    licenseUrl: '',
    legalPersonIdFrontUrl: '',
    legalPersonIdBackUrl: '',
    addressProofUrl: '',
    licenseStatus: 'unsubmitted',
    licenseRejectReason: '',
  });
};

const readFavoriteSalonIds = async (userId) => {
  const favorites = await FavoriteSalon
    .find({ userId: { $in: userIdAliases(userId) } })
    .select('salonId')
    .sort({ createdAt: -1 })
    .lean();
  return [...new Set(favorites.map(favorite => favorite.salonId))];
};

const readFavoriteSalons = async (userId) => {
  const favoriteSalonIds = await readFavoriteSalonIds(userId);
  const salons = await Salon.find({
    id: { $in: favoriteSalonIds },
    publishStatus: 'online',
  }).select(`id name description image images promoImages ${SALON_RATING_STATS_SELECTION}`).lean();
  const ratedSalons = await addApprovedSalonRatings(salons);
  const salonsById = new Map(ratedSalons.map(salon => [salon.id, salon]));
  return Promise.all(
    favoriteSalonIds
      .map(salonId => salonsById.get(salonId))
      .filter(Boolean)
      .map(async salon => ({
        id: salon.id,
        name: salon.name || '',
        description: salon.description || '',
        rating: salon.rating,
        reviewCount: salon.reviewCount,
        image: await salonCoverImage(salon),
      })),
  );
};

const generateSlotsForStaffAndDate = async (staffId, date, duration = 30, salonOverride, excludeBookingId = '') => {
  const salon = salonOverride || await getSalonByStaffId(staffId).lean();
  const times = generateHalfHourSlots(salon?.openingHours);
  if (isSalonClosedOnDate(salon, date)) {
    return times.map(time => ({
      time,
      startTime: bookingDomain.slotStartTime(date, time),
      isAvailable: false,
      reason: '店铺休息日',
    }));
  }
  if (isSameDayBookingBlocked(salon, date)) {
    return times.map(time => ({
      time,
      startTime: bookingDomain.slotStartTime(date, time),
      isAvailable: false,
      reason: '当天不可预约',
    }));
  }
  const { start: dayStart, end: dayEnd } = bookingDomain.bookingDayRange(date);
  const [bookings, person] = await Promise.all([
    Booking.find({
      staffId,
      ...(excludeBookingId ? { id: { $ne: excludeBookingId } } : {}),
      startTime: { $gte: dayStart, $lt: dayEnd },
      status: { $in: ['pending', 'accepted'] },
    }).select({ startTime: 1, serviceDurationMinutes: 1, _id: 0 }).lean(),
    getStaffById(staffId).select('weeklyClosedDays unavailableSlots').lean(),
  ]);
  if (isSalonClosedOnDate({ weeklyClosedDays: person?.weeklyClosedDays }, date)) {
    return times.map(time => ({
      time,
      startTime: bookingDomain.slotStartTime(date, time),
      isAvailable: false,
      reason: '理发师定休日',
    }));
  }
  const bookedTimes = new Set(bookings.flatMap(booking =>
    bookingDomain.occupiedSlotStarts(booking.startTime, booking.serviceDurationMinutes || 30)
      .map(slot => formatMinutesAsTime(bookingDomain.localTimeMinutes(slot)))));
  const unavailableTimes = new Set(
    normalizeUnavailableSlots(person?.unavailableSlots)
      .filter(slot => slot.startsWith(`${date} `))
      .map(slot => slot.slice(11)),
  );

  return times.map((time) => {
    const startTime = bookingDomain.slotStartTime(date, time);
    const requestedTimes = bookingDomain.occupiedSlotStarts(startTime, duration)
      .map(slot => formatMinutesAsTime(bookingDomain.localTimeMinutes(slot)));
    const hasBooking = requestedTimes.some(slot => bookedTimes.has(slot));
    const unavailable = requestedTimes.some(slot => unavailableTimes.has(slot));
    return {
      time,
      startTime,
      isAvailable: !hasBooking && !unavailable,
      reason: hasBooking ? '已有订单' : unavailable ? '理发师缺勤' : undefined,
    };
  });
};

const generateSlotsForNoPreferenceAndDate = async (salon, date, duration = 30, excludeBookingId = '') => {
  if (isSalonClosedOnDate(salon, date)) {
    return generateHalfHourSlots(salon?.openingHours).map(time => ({
      time,
      startTime: bookingDomain.slotStartTime(date, time),
      isAvailable: false,
      reason: '店铺休息日',
    }));
  }
  if (isSameDayBookingBlocked(salon, date)) {
    return generateHalfHourSlots(salon?.openingHours).map(time => ({
      time,
      startTime: bookingDomain.slotStartTime(date, time),
      isAvailable: false,
      reason: '当天不可预约',
    }));
  }
  const staffIds = salon.staffIds || [];
  const { start: dayStart, end: dayEnd } = bookingDomain.bookingDayRange(date);
  const [bookings, staffProfiles] = await Promise.all([
    Booking.find({
      staffId: { $in: staffIds },
      ...(excludeBookingId ? { id: { $ne: excludeBookingId } } : {}),
      startTime: { $gte: dayStart, $lt: dayEnd },
      status: { $in: ['pending', 'accepted'] },
    }).select({ staffId: 1, startTime: 1, serviceDurationMinutes: 1, _id: 0 }).lean(),
    StaffProfile.find({ id: { $in: staffIds } })
      .select({ id: 1, weeklyClosedDays: 1, unavailableSlots: 1, _id: 0 })
      .lean(),
  ]);
  const bookedSlots = new Set(bookings.flatMap(booking =>
    bookingDomain.occupiedSlotStarts(booking.startTime, booking.serviceDurationMinutes || 30)
      .map(slot => `${booking.staffId}:${formatMinutesAsTime(bookingDomain.localTimeMinutes(slot))}`)));
  const unavailableSlots = new Set(staffProfiles.flatMap(profile =>
    normalizeUnavailableSlots(profile.unavailableSlots)
      .filter(slot => slot.startsWith(`${date} `))
      .map(slot => `${profile.id}:${slot.slice(11)}`)
  ));
  const activeStaffIds = staffProfiles
    .filter(profile => !isSalonClosedOnDate({ weeklyClosedDays: profile.weeklyClosedDays }, date))
    .map(profile => profile.id);

  return generateHalfHourSlots(salon?.openingHours).map(time => {
    const startTime = bookingDomain.slotStartTime(date, time);
    const requestedTimes = bookingDomain.occupiedSlotStarts(startTime, duration)
      .map(slot => formatMinutesAsTime(bookingDomain.localTimeMinutes(slot)));
    const isAvailable = activeStaffIds.some(staffId =>
      requestedTimes.every(slot => !bookedSlots.has(`${staffId}:${slot}`)
        && !unavailableSlots.has(`${staffId}:${slot}`))
    );
    return {
      time,
      startTime,
      isAvailable,
      reason: isAvailable ? undefined : '暂无可用理发师',
    };
  });
};


const routeContext = {
  addReviewHelpfulState,
  recordReviewHelpful,
  acceptedBookingAtTimeQuery,
  AdminUser,
  AdConfig,
  amapWebServiceKey,
  applyDirectSalonContent,
  validateSalonStaffIds,
  applyPendingContent,
  Booking,
  BookingMessage,
  SlotOccupancy,
  broadcastBookingEvent,
  buildAdminMerchantPayload,
  buildAdminMerchantSummary,
  ADMIN_MERCHANT_SUMMARY_SALON_PROJECTION,
  addApprovedSalonRatings,
  buildAdminUserPayload,
  buildAdPayload,
  buildClientUserPayload,
  buildContentDraft,
  buildMerchantSalonPayload,
  buildMerchantBookingScope,
  buildMerchantUserPayload,
  buildSalonDetail,
  buildPublicSalonDetail,
  buildStaffPayload,
  buildPublicStaffSummary,
  calculateDistanceKm,
  clearPublicSalonDetailCache,
  publicResponseCaches,
  clearAdCache,
  clearCouponCampaignCache,
  clearPromotedServicesCache,
  ClientUser,
  CouponCampaign,
  UserCoupon,
  campaignPayload,
  couponDiscountForOrder,
  couponPayload,
  couponStatus,
  createModeratedUploadPolicies,
  createMerchantUploadPolicies,
  crypto,
  decryptWechatPhoneNumber,
  deleteModeratedImages,
  expandedSalonClosedDates,
  FavoriteSalon,
  fetchJson,
  findAcceptedBookingAtTimeExcluding,
  findActiveBookingAtTime,
  findActiveBookingAtTimeExcluding,
  generateSlotsForNoPreferenceAndDate,
  generateSlotsForStaffAndDate,
  getCutPriceFromFenBySalonIds,
  getNearbySalons,
  getSalonReviewsPage,
  getApprovedReviewsByStaffIds,
  getApprovedRatingSummariesByStaffIds,
  refreshStaffRatingSummaries,
  refreshSalonRatingSummaries,
  getCoordinates,
  getSalonByStaffId,
  getServiceById,
  getStaffById,
  getStaffMapByIds,
  getUserPolicy,
  getWechatPhoneNumber,
  getWechatOpenId,
  hashPassword,
  hasReviewableContentChanges,
  ensureSalonForMerchant,
  existingSalonImages,
  incrementNoShowCount,
  reverseNoShowCount,
  isSalonClosedOnDate,
  isSameDayBookingBlocked,
  isStaffUnavailable,
  loginClientByPhone,
  logoutSession,
  MerchantUser,
  mongoose,
  normalizeBooking,
  normalizeMerchantBooking,
  normalizeAdLink,
  normalizeClosedDates,
  normalizeDeposit,
  normalizeLimit,
  normalizePagination,
  normalizeRadiusKm,
  normalizeSalonTags,
  normalizeUserId,
  parseAmapReverseAddress,
  parseMerchantRescheduleTime,
  parseOpeningHours,
  publishModeratedImage,
  readFavoriteSalonIds,
  readFavoriteSalons,
  readFavoriteTargetIds: favoritesDomain.readFavoriteTargetIds,
  setFavoriteTarget: favoritesDomain.setFavoriteTarget,
  favoriteTargetExists: favoritesDomain.favoriteTargetExists,
  readFavoriteStaff: favoritesDomain.readFavoriteStaff,
  readFavoritePosts: favoritesDomain.readFavoritePosts,
  countStaffFavorites: favoritesDomain.countStaffFavorites,
  rateLimits,
  revokeSessionHash,
  rotateSession,
  sessionTokenFromRequest,
  servicePayload: salonDomain.servicePayload,
  Salon,
  SalonPost,
  salonPostPayload: salonPosts.postPayload,
  validateSalonPostInput: salonPosts.validatePostInput,
  salonCoverImage,
  SALON_RATING_STATS_SELECTION,
  setPaginationHeaders,
  privateImageUrl,
  SupportMessage,
  AnalyticsEvent,
  activeSessionQuery,
  publicImageUrl,
  stripSensitiveSalonFields,
  toFiniteNumber,
  USER_CANCEL_WINDOW_MS,
  userIdAliases,
  verifyPassword,
  validateCampaignInput,
  verifyModeratedImageObjects,
  verifyMerchantQualificationObjects,
  INPUT_LIMITS,
  wechatAppId,
  wechatAppSecret,
  wechatBookingStatusTemplateId,
  sendBookingAcceptedNotification,
  requireQualificationForPublishing,
};

require('./src/routes/public')(app, routeContext);
require('./src/routes/auth-entry')(app, routeContext);
require('./src/routes/analytics')(app, routeContext);
app.use([
  '/api/support-messages',
  '/api/uploads',
  '/api/auth',
  '/api/favorites',
  '/api/bookings',
  '/api/booking-messages',
], requireClientAuth);
require('./src/routes/client')(app, routeContext);
require('./src/routes/client-favorites')(app, routeContext);
require('./src/routes/client-bookings')(app, routeContext);
require('./src/routes/review-helpful')(app, routeContext);
require('./src/routes/client-messages')(app, routeContext);
app.use('/api/merchant', requireMerchantAuth);
require('./src/routes/merchant')(app, routeContext);
app.use('/api/admin', requireAdminAuth);
require('./src/routes/admin')(app, routeContext);

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error?.type === 'entity.too.large') {
    console.warn(JSON.stringify({
      level: 'warn',
      event: 'request_body_too_large',
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      contentLength: Number(req.headers['content-length']) || null,
      limit: error.limit,
    }));
    return res.status(413).json({ message: '请求内容过大', requestId: req.requestId });
  }
  if (error?.type === 'entity.parse.failed') {
    return res.status(400).json({ message: '请求格式错误', requestId: req.requestId });
  }
  errorLogger(error, req);
  res.status(500).json({ message: 'Internal server error', requestId: req.requestId });
});


const startServer = async () => {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error('MONGODB_URI is missing. Add it to .env before starting the backend.');
  }

  await mongoose.connect(mongoUri);
  const redisConnected = await connectRedis();
  if (redisConnected) {
    await subscribeSessionRevocations(closeSocketsBySessionHash);
    console.log('Redis connected');
  } else {
    console.warn('REDIS_URL is missing; using process-local rate limits');
  }
  await Promise.all([
    Booking.createIndexes(),
    ReviewHelpful.createIndexes(),
    BookingMessage.createIndexes(),
    SlotOccupancy.createIndexes(),
    UserPolicy.createIndexes(),
    ClientUser.createIndexes(),
    MerchantUser.createIndexes(),
    Salon.createIndexes(),
    SalonPost.createIndexes(),
    CouponCampaign.createIndexes(),
    UserCoupon.createIndexes(),
    AnalyticsEvent.createIndexes(),
    // Its unique staffId index is what stops an older rating refresh from replacing a newer one.
    StaffRatingSummary.createIndexes(),
    // Unique (userId, target) indexes keep favorite writes idempotent and stylist favorite counts exact.
    FavoriteStaff.createIndexes(),
    FavoritePost.createIndexes(),
  ]);
  console.log('MongoDB connected');

  server.listen(PORT, listenHost, () => {
    console.log(`Backend running at http://localhost:${PORT}`);
    // Values only an operator can check on the server; no secrets.
    console.log(JSON.stringify({
      level: 'info',
      event: 'startup_config',
      nodeEnv: process.env.NODE_ENV || '',
      listenHost,
      trustProxyHops,
      rateLimitStore: redisConnected ? 'redis' : 'memory',
    }));
  });

  void runBookingCompletion();
  bookingCompletionTimer = setInterval(runBookingCompletion, 15 * 60 * 1000);
  bookingCompletionTimer.unref();
};

let bookingCompletionRun = null;
let bookingCompletionTimer;
const runBookingCompletion = () => {
  if (bookingCompletionRun || shuttingDown) return bookingCompletionRun;
  const dependencies = {
    mongoose, Booking, BookingMessage, SlotOccupancy, UserCoupon,
    AnalyticsEvent, broadcastBookingEvent,
  };
  bookingCompletionRun = completeDueBookings(dependencies)
    .catch(error => console.error('Automatic booking completion failed:', error))
    .then(() => expirePendingBookings(dependencies, new Date(), {
      timeoutMs: pendingBookingTimeoutHours * 60 * 60 * 1000,
    }))
    .catch(error => console.error('Pending booking expiry failed:', error))
    .finally(() => { bookingCompletionRun = null; });
  return bookingCompletionRun;
};

// Graceful shutdown: stop taking new work, let in-flight requests and the booking-completion job finish,
// then close WebSockets, Redis and MongoDB. Anything still running after the timeout is cut off.
// Process managers must allow longer than this before SIGKILL (PM2: --kill-timeout; its default is 1.6s).
const SHUTDOWN_TIMEOUT_MS = (() => {
  const value = Math.floor(Number(process.env.SHUTDOWN_TIMEOUT_MS));
  return Number.isFinite(value) && value > 0 ? value : 10000;
})();
let shutdownPromise = null;
const gracefulShutdown = (signal, { timeoutMs = SHUTDOWN_TIMEOUT_MS, exit = code => process.exit(code) } = {}) => {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  clearInterval(bookingCompletionTimer);
  console.log(JSON.stringify({ level: 'info', event: 'shutdown_started', signal, timeoutMs }));

  let exited = false;
  const finish = (code) => {
    if (exited) return;
    exited = true;
    exit(code);
  };

  shutdownPromise = new Promise((resolve) => {
    const forceTimer = setTimeout(() => {
      console.warn(JSON.stringify({ level: 'warn', event: 'shutdown_timeout', signal, timeoutMs }));
      server.closeAllConnections();
      wss.clients.forEach(socket => socket.terminate());
      finish(1);
      resolve();
    }, timeoutMs);
    forceTimer.unref();

    (async () => {
      let exitCode = 0;
      try {
        wss.clients.forEach(socket => socket.close(1001, 'Server restarting'));
        const httpClosed = server.listening
          ? new Promise(done => server.close(done))
          : Promise.resolve();
        server.closeIdleConnections();
        await Promise.all([httpClosed, bookingCompletionRun]);
        wss.clients.forEach(socket => socket.terminate());
        await disconnectRedis();
        await mongoose.disconnect();
      } catch (error) {
        exitCode = 1;
        console.error(JSON.stringify({ level: 'error', event: 'shutdown_error', message: error.message }));
      }
      clearTimeout(forceTimer);
      if (exited) return;
      console.log(JSON.stringify({ level: 'info', event: 'shutdown_complete', signal }));
      finish(exitCode);
      resolve();
    })();
  });
  return shutdownPromise;
};

if (require.main === module) {
  for (const signal of ['SIGTERM', 'SIGINT']) {
    // A second signal while draining means "stop now".
    process.on(signal, () => (shutdownPromise ? process.exit(1) : gracefulShutdown(signal)));
  }
  startServer().catch((error) => {
    console.error('Failed to start backend:', error.message);
    process.exit(1);
  });
}

module.exports = {
  publicResponseCaches,
  buildAdminMerchantPayload,
  buildAdminMerchantSummary,
  getUserPolicy,
  gracefulShutdown,
  activeSessionQuery,
  acceptedBookingAtTimeQuery,
  applyDirectSalonContent,
  validateSalonStaffIds,
  applyPendingContent,
  buildContentDraft,
  buildGeoLocation,
  buildMerchantSalonPayload,
  buildPublicSalonDetail,
  buildStaffPayload,
  buildPublicStaffSummary,
  addApprovedSalonRatings,
  clearPublicSalonDetailCache,
  buildMerchantBookingScope,
  campaignPayload,
  calculateDistanceKm,
  couponDiscountForOrder,
  couponPayload,
  couponStatus,
  getApprovedReviewsByStaffIds,
  getApprovedRatingSummariesByStaffIds,
  refreshStaffRatingSummaries,
  refreshSalonRatingSummaries,
  getApprovedReviewTagCountsByStaffIds,
  getNearbySalons,
  getCoordinates,
  generateSlotsForNoPreferenceAndDate,
  generateSlotsForStaffAndDate,
  hashPassword,
  hasReviewableContentChanges,
  INPUT_LIMITS,
  normalizeSalonTags,
  normalizeAfterSalesPolicyIds,
  normalizeServiceTagIds,
  normalizeClosedDates,
  ensureSalonForMerchant,
  normalizeAdLink,
  normalizePagination,
  normalizeRadiusKm,
  createClientUserWithSignupCoupons,
  createSession,
  parseMerchantRescheduleTime,
  readFavoriteSalonIds,
  readFavoriteSalons,
  socketCanReceiveBooking,
  server,
  isSalonClosedOnDate,
  isSameDayBookingBlocked,
  isStaffUnavailable,
  logoutSession,
  normalizeBooking,
  normalizeMerchantBooking,
  stripSensitiveSalonFields,
  verifyPassword,
  validateCampaignInput,
};
