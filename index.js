const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { WebSocket, WebSocketServer } = require('ws');
const {
  PORT,
  listenHost,
  uploadDir,
  imageCacheDir,
  picturesDir,
  amapWebServiceKey,
  publicBaseUrl,
  wechatAppId,
  wechatAppSecret,
  trustProxyHops,
  wsMaxConnections,
  wsMaxConnectionsPerIp,
  isAllowedOrigin,
} = require('./src/config');
const {
  Booking,
  SlotOccupancy,
  UserPolicy,
  FavoriteSalon,
  Salon,
  StaffProfile,
  MerchantUser,
  AdminUser,
  ClientUser,
  AdConfig,
  CouponCampaign,
  UserCoupon,
  SupportMessage,
} = require('./src/models');
const {
  campaignPayload,
  couponDiscountForOrder,
  couponPayload,
  couponStatus,
  validateCampaignInput,
} = require('./src/coupons');
const {
  compressedImageMiddleware,
  deleteModeratedImages,
  imageExists,
  publishModeratedImage,
  createMerchantUploadPolicies,
  createModeratedUploadPolicies,
  publicImageUrl,
  saveBase64Image,
  privateImageUrl,
  verifyMerchantQualificationObjects,
  verifyModeratedImageObjects,
} = require('./src/images');
const { rateLimits } = require('./src/rate-limit');
const { hashPassword, verifyPassword } = require('./src/passwords');
const {
  connectRedis,
  getRedisClient,
  publishSessionRevocation,
  subscribeSessionRevocations,
} = require('./src/redis');
const { errorLogger, requestLogger } = require('./src/observability');
const authDomain = require('./src/services/auth');
const bookingDomain = require('./src/services/booking');
const salonDomain = require('./src/services/salon');
const {
  activeSessionQuery,
  buildAdminUserPayload,
  buildClientUserPayload,
  buildMerchantUserPayload,
  createClientUserWithSignupCoupons,
  createSession,
  decryptWechatPhoneNumber,
  getWechatPhoneNumber,
  hashSessionToken,
  normalizeUserId,
  sessionTokenFromRequest,
  userIdAliases,
} = authDomain;

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

app.use(requestLogger);
app.use(cors({
  origin: (origin, callback) => {
    if (isAllowedOrigin(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  exposedHeaders: ['X-Total-Count', 'X-Page', 'X-Page-Size'],
}));
app.use(express.json({ limit: process.env.JSON_LIMIT || '10mb' }));

app.get('/health', (_req, res) => {
  res.set('Cache-Control', 'no-store').json({ status: 'ok', uptimeSeconds: Math.floor(process.uptime()) });
});
app.get('/ready', (_req, res) => {
  const mongoReady = mongoose.connection.readyState === 1;
  const redisRequired = Boolean(String(process.env.REDIS_URL || '').trim());
  const redisReady = !redisRequired || Boolean(getRedisClient());
  res.status(mongoReady && redisReady ? 200 : 503).set('Cache-Control', 'no-store').json({
    status: mongoReady && redisReady ? 'ready' : 'not_ready',
    mongodb: mongoReady ? 'up' : 'down',
    redis: redisReady ? 'up' : 'down',
  });
});
// 静态资源托管
fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(imageCacheDir, { recursive: true });
app.use('/cached-images', express.static(imageCacheDir));
app.get(/^\/images\/(.+)/, compressedImageMiddleware(picturesDir));
app.use('/images', express.static(picturesDir));
app.get(/^\/uploads\/(.+)/, compressedImageMiddleware(uploadDir));
app.use('/uploads', express.static(uploadDir));

const normalizeAdLink = (value) => {
  const link = String(value || '').trim();
  return /^\/pages\/[A-Za-z0-9_/-]+(?:\?[^#\s]*)?$/.test(link) && !link.includes('..') ? link : '';
};

const buildAdPayload = (config) => ({
  imageUrl: publicImageUrl(config?.imageUrl || ''),
  link: normalizeAdLink(config?.link) || '/pages/ad/ad',
  enabled: config?.enabled !== false,
});

const stripSensitiveSalonFields = salonDomain.stripSensitiveSalonFields;

const buildAdminMerchantPayload = async (user, salonDocument = {}) => {
  const salon = normalizeDocument(salonDocument);
  const staffMap = await getStaffMapByIds(salon.staffIds || []);
  const reviews = await getApprovedReviewsByStaffIds(salon.staffIds || [], PUBLIC_SALON_REVIEWS_LIMIT);
  const reviewsByStaff = groupReviewsByStaff(reviews);
  const publicSalon = {
    ...stripSensitiveSalonFields(salon),
    staff: (salon.staffIds || []).map(id => staffMap[id]).filter(Boolean)
      .map(person => buildStaffPayload(person, reviewsByStaff[person.id] || [])),
  };
  const salonPayload = salon.pendingContent ? { ...publicSalon, ...salon.pendingContent } : publicSalon;
  salonPayload.staff = (salonPayload.staff || [])
    .map(person => buildStaffPayload(person, reviewsByStaff[person.id] || []));
  salonPayload.reviews = reviews;
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
    contentReviewedAt: salon.contentReviewedAt,
    salon: salonPayload,
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
    return user ? { role, salonId: user.salonId, sessionExpiresAt: user.sessionExpiresAt, sessionHash: hashSessionToken(token) } : null;
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

const findNearbySalons = async (userLocation, radiusKm, limit) => {
  const maxDistance = Math.max(radiusKm, 0.1) * 1000;
  const query = {
    publishStatus: 'online',
    geoLocation: {
      $nearSphere: {
        $geometry: {
          type: 'Point',
          coordinates: [userLocation.longitude, userLocation.latitude],
        },
        $maxDistance: maxDistance,
      },
    },
  };
  const salonList = await Salon.find(query)
    .select('-licenseUrl -legalPersonIdFrontUrl -legalPersonIdBackUrl -addressProofUrl -licenseStatus -licenseRejectReason -licenseSubmittedAt -licenseReviewedAt -pendingContent -contentReviewStatus -contentRejectReason -contentReviewedAt')
    .limit(limit).lean();
  return salonList
    .map((salon) => {
      const salonLocation = getCoordinates(salon.location || salon.geoLocation);
      return salonLocation
        ? { ...salon, distanceKm: Number(calculateDistanceKm(userLocation, salonLocation).toFixed(2)) }
        : salon;
    });
};

const getNearbySalons = async (userLocation, radiusKm, limit, minResults = 10, maxRadiusKm = 50) => {
  const targetCount = Math.min(limit, minResults);
  const salonList = await findNearbySalons(userLocation, maxRadiusKm, limit);
  const initialRadiusResults = salonList.filter(salon => salon.distanceKm <= radiusKm);
  return initialRadiusResults.length >= targetCount ? initialRadiusResults : salonList;
};

const getServiceById = async (serviceId) => {
  const salon = await Salon.findOne({ 'services.id': serviceId }).select('services').lean();
  return salon?.services?.find(item => item.id === serviceId) || null;
};

const getSalonByStaffId = (staffId) => Salon.findOne({ staffIds: staffId });

const getStaffById = (staffId) => StaffProfile.findOne({ id: staffId });

const getStaffMapByIds = async (staffIds = []) => {
  const profiles = await StaffProfile.find({ id: { $in: staffIds } }).lean();
  return Object.fromEntries(profiles.map(profile => [profile.id, profile]));
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
const isSalonClosedOnDate = bookingDomain.isSalonClosedOnDate;

const isSameDayBookingBlocked = bookingDomain.isSameDayBookingBlocked;

const isStaffUnavailable = async (staffId, startTime) => {
  const person = await getStaffById(staffId).lean();
  if (!person) return false;
  const parsed = startTime instanceof Date ? startTime : bookingDomain.parseBookingTime(startTime);
  if (!parsed) return false;
  const dateKey = bookingDomain.localDateKey(parsed);
  const timeKey = bookingDomain.formatMinutesAsTime(bookingDomain.localTimeMinutes(parsed));
  return normalizeUnavailableSlots(person.unavailableSlots).includes(`${dateKey} ${timeKey}`);
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

const getUserPolicy = async (userId, session) =>
  UserPolicy.findOneAndUpdate(
    { userId },
    { $setOnInsert: { userId, noShowCount: 0, isBlacklisted: false } },
    { upsert: true, new: true, setDefaultsOnInsert: true, session },
  );

const incrementNoShowCount = (userId, session) => {
  const nextCount = { $add: [{ $ifNull: ['$noShowCount', 0] }, 1] };
  return UserPolicy.findOneAndUpdate(
    { userId },
    [{
      $set: {
        userId,
        noShowCount: nextCount,
        isBlacklisted: { $gte: [nextCount, BLACKLIST_NO_SHOW_LIMIT] },
        updatedAt: new Date(),
      },
    }],
    { upsert: true, new: true, session },
  );
};

const PUBLIC_SALON_REVIEWS_LIMIT = 150;
const buildStaffPayload = salonDomain.buildStaffPayload;
const publicReviewFromBooking = salonDomain.publicReviewFromBooking;

const getApprovedReviewsByStaffIds = async (staffIds = [], limit = PUBLIC_SALON_REVIEWS_LIMIT) => {
  const ids = [...new Set(staffIds.map(String).filter(Boolean))];
  if (!ids.length) return [];
  const bookings = await Booking.find({
    staffId: { $in: ids },
    'review.reviewStatus': 'approved',
  })
    .select('id staffId staffName review updatedAt')
    .sort({ updatedAt: -1 })
    .limit(limit)
    .lean();
  return bookings.map(publicReviewFromBooking);
};

const groupReviewsByStaff = salonDomain.groupReviewsByStaff;
const buildSalonImageList = salonDomain.buildSalonImageList;

const existingSalonImages = async (salon) => {
  const images = buildSalonImageList(salon);
  const exists = await Promise.all(images.map(imageExists));
  return images.filter((_, index) => exists[index]).map(publicImageUrl);
};

const salonCoverImage = async (salon) => {
  const images = [salon?.image, ...buildSalonImageList(salon)]
    .filter(image => typeof image === 'string' && image.trim());
  const exists = await Promise.all(images.map(imageExists));
  return publicImageUrl(images.find((_, index) => exists[index]) || '');
};

const buildSalonDetail = async (salonDocument) => {
  const salon = normalizeDocument(salonDocument);
  const staffMap = await getStaffMapByIds(salon.staffIds);
  const staffList = salon.staffIds.map(id => staffMap[id]).filter(Boolean);
  const reviews = await getApprovedReviewsByStaffIds(salon.staffIds, PUBLIC_SALON_REVIEWS_LIMIT);
  const reviewsByStaff = groupReviewsByStaff(reviews);
  const images = await existingSalonImages(salon);
  const staff = staffList.map(person => buildStaffPayload(person, reviewsByStaff[person.id] || []));
  const publicSalon = stripSensitiveSalonFields(salon);
  return {
    ...publicSalon,
    services: (publicSalon.services || []).map(salonDomain.servicePayload),
    image: await salonCoverImage(salon),
    images,
    promoImages: images,
    staff,
    reviews,
  };
};

const buildPublicSalonDetail = (salonDocument, builder = buildSalonDetail, now = Date.now()) =>
  salonDomain.buildPublicSalonDetail(salonDocument, builder, now);
const clearPublicSalonDetailCache = salonDomain.clearPublicSalonDetailCache;

const contentFields = [
  'name',
  'address',
  'addressRegion',
  'addressDetail',
  'location',
  'description',
  'fullDescription',
  'image',
  'images',
  'promoImages',
  'openingHours',
  'acceptsSameDayBooking',
  'closedDates',
  'phone',
  'services',
  'staff',
];

const normalizeServiceTags = salonDomain.normalizeServiceTags;

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
    if (JSON.stringify(images(incoming)) !== JSON.stringify(images(current.promoImages ?? current.images))) return true;
  }

  const currentServices = new Map((current.services || []).map(item => [String(item.id || ''), item]));
  if ((payload.services || []).some(service => {
    const previous = currentServices.get(String(service?.id || '')) || {};
    return ['name', 'note', 'imageUrl'].some(field =>
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
  set('closedDates', Array.isArray(payload.closedDates) ? normalizeClosedDates(payload.closedDates) : undefined);
  set('phone', typeof payload.phone === 'string' ? payload.phone : undefined);
  if (Array.isArray(payload.services)) {
    const currentServices = new Map((salon.services || []).map(item => [String(item.id || ''), item]));
    salon.services = payload.services.flatMap((service, index) => {
      const id = String(service?.id || `s1-${Date.now()}-${index}`).trim();
      const previous = currentServices.get(id);
      if (!previous) return [];
      return [salonDomain.serviceForStorage({
        ...normalizeDocument(previous),
        ...service,
        id,
      })];
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
        role: profile.role || '',
        experience: profile.experience || '',
        extraServiceFeeFen: salonDomain.staffExtraServiceFeeFen(profile),
        unavailableSlots: normalizeUnavailableSlots(profile.unavailableSlots),
      } },
    )));
  }
};

const buildContentDraft = async (salon, payload) => {
  const draft = normalizeDocument(salon.pendingContent) || await buildSalonDetail(salon);
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
  set('image', typeof payload.image === 'string' ? payload.image : undefined);
  set('openingHours', typeof payload.openingHours === 'string' ? payload.openingHours : undefined);
  set('acceptsSameDayBooking', typeof payload.acceptsSameDayBooking === 'boolean' ? payload.acceptsSameDayBooking : undefined);
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
      .map((service, index) => salonDomain.serviceForStorage(
        service,
        `s1-${Date.now()}-${index}`,
      ));
  }

  if (Array.isArray(payload.staff)) {
    draft.staff = payload.staff
      .filter(profile => profile && profile.name)
      .map((profile, index) => {
        const id = profile.id || `merchant-staff-${Date.now()}-${index}`;
        return {
          id,
          name: profile.name,
          role: profile.role || '',
          experience: profile.experience || '',
          extraServiceFeeFen: salonDomain.staffExtraServiceFeeFen(profile),
          imageUrl: profile.imageUrl || '',
          bio: profile.bio || '',
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
  contentFields
    .filter(key => key !== 'staff')
    .forEach(key => {
      if (draft[key] !== undefined) salon[key] = draft[key];
    });
  if (draft.location !== undefined) salon.geoLocation = buildGeoLocation(draft.location);

  if (Array.isArray(draft.staff)) {
    salon.staffIds = draft.staff.map(profile => profile.id).filter(Boolean);
    await Promise.all(draft.staff.map(profile =>
      StaffProfile.findOneAndUpdate(
        { id: profile.id },
        profile,
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
    ));
  }

  salon.pendingContent = undefined;
};

const buildMerchantSalonPayload = async (salonId = '1') => {
  const salon = await Salon.findOne({ id: salonId });
  const payload = await buildSalonDetail(salon);
  const merged = {
    ...payload,
    ...(normalizeDocument(salon.pendingContent) || {}),
    contentReviewStatus: salon.contentReviewStatus || 'pending',
    contentRejectReason: salon.contentRejectReason || '',
    contentReviewedAt: salon.contentReviewedAt,
  };
  merged.services = (merged.services || []).map(salonDomain.servicePayload);
  const reviewsByStaff = groupReviewsByStaff(payload.reviews);
  merged.staff = (merged.staff || [])
    .map(person => buildStaffPayload(person, reviewsByStaff[person.id] || []));
  merged.reviews = payload.reviews;
  return merged;
};

const ensureSalonForMerchant = async ({ salonId, displayName }) => {
  const normalizedSalonId = String(salonId || '').trim() || `salon-${Date.now()}`;
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
    rating: 4.8,
    image: '',
    images: [],
    promoImages: [],
    description: '',
    fullDescription: '',
    openingHours: '10:00 - 20:00',
    acceptsSameDayBooking: true,
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

const readFavoriteSalons = async (userId) => {
  const favorites = await FavoriteSalon
    .find({ userId: { $in: userIdAliases(userId) } })
    .select('salonId')
    .sort({ createdAt: -1 })
    .lean();
  const salons = await Salon.find({
    id: { $in: favorites.map(favorite => favorite.salonId) },
    publishStatus: 'online',
  });
  const salonsById = new Map(salons.map(salon => [salon.id, salon]));
  return Promise.all(
    favorites
      .map(favorite => salonsById.get(favorite.salonId))
      .filter(Boolean)
      .map(salon => buildPublicSalonDetail(salon)),
  );
};

const generateSlotsForStaffAndDate = async (staffId, date) => {
  const salon = await getSalonByStaffId(staffId).lean();
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
      startTime: { $gte: dayStart, $lt: dayEnd },
      status: { $in: ['pending', 'accepted'] },
    }).select({ startTime: 1, _id: 0 }).lean(),
    getStaffById(staffId).select('unavailableSlots').lean(),
  ]);
  const bookedTimes = new Set(bookings.map(booking => {
    const startTime = new Date(booking.startTime);
    return formatMinutesAsTime(bookingDomain.localTimeMinutes(startTime));
  }));
  const unavailableTimes = new Set(
    normalizeUnavailableSlots(person?.unavailableSlots)
      .filter(slot => slot.startsWith(`${date} `))
      .map(slot => slot.slice(11)),
  );

  return times.map((time) => {
    const startTime = bookingDomain.slotStartTime(date, time);
    const hasBooking = bookedTimes.has(time);
    const unavailable = unavailableTimes.has(time);
    return {
      time,
      startTime,
      isAvailable: !hasBooking && !unavailable,
      reason: hasBooking ? '已有订单' : unavailable ? '理发师缺勤' : undefined,
    };
  });
};

const generateSlotsForNoPreferenceAndDate = async (salon, date) => {
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
      startTime: { $gte: dayStart, $lt: dayEnd },
      status: { $in: ['pending', 'accepted'] },
    }).select({ staffId: 1, startTime: 1, _id: 0 }).lean(),
    StaffProfile.find({ id: { $in: staffIds } })
      .select({ id: 1, unavailableSlots: 1, _id: 0 })
      .lean(),
  ]);
  const bookedSlots = new Set(bookings.map(booking => {
    const startTime = new Date(booking.startTime);
    const time = formatMinutesAsTime(bookingDomain.localTimeMinutes(startTime));
    return `${booking.staffId}:${time}`;
  }));
  const unavailableSlots = new Set(staffProfiles.flatMap(profile =>
    normalizeUnavailableSlots(profile.unavailableSlots)
      .filter(slot => slot.startsWith(`${date} `))
      .map(slot => `${profile.id}:${slot.slice(11)}`)
  ));
  const activeStaffIds = staffProfiles.map(profile => profile.id);

  return generateHalfHourSlots(salon?.openingHours).map(time => {
    const startTime = bookingDomain.slotStartTime(date, time);
    const isAvailable = activeStaffIds.some(staffId =>
      !bookedSlots.has(`${staffId}:${time}`) &&
      !unavailableSlots.has(`${staffId}:${time}`)
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
  acceptedBookingAtTimeQuery,
  AdminUser,
  AdConfig,
  amapWebServiceKey,
  applyDirectSalonContent,
  applyPendingContent,
  Booking,
  SlotOccupancy,
  broadcastBookingEvent,
  buildAdminMerchantPayload,
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
  calculateDistanceKm,
  clearPublicSalonDetailCache,
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
  FavoriteSalon,
  fetchJson,
  findAcceptedBookingAtTimeExcluding,
  findActiveBookingAtTime,
  findActiveBookingAtTimeExcluding,
  generateSlotsForNoPreferenceAndDate,
  generateSlotsForStaffAndDate,
  getNearbySalons,
  getApprovedReviewsByStaffIds,
  getCoordinates,
  getSalonByStaffId,
  getServiceById,
  getStaffById,
  getStaffMapByIds,
  getUserPolicy,
  getWechatPhoneNumber,
  hashPassword,
  hasReviewableContentChanges,
  ensureSalonForMerchant,
  existingSalonImages,
  incrementNoShowCount,
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
  normalizeUserId,
  parseAmapReverseAddress,
  parseMerchantRescheduleTime,
  parseOpeningHours,
  publishModeratedImage,
  readFavoriteSalons,
  rateLimits,
  revokeSessionHash,
  rotateSession,
  sessionTokenFromRequest,
  servicePayload: salonDomain.servicePayload,
  Salon,
  salonCoverImage,
  saveBase64Image,
  setPaginationHeaders,
  privateImageUrl,
  SupportMessage,
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
};

require('./src/routes/public')(app, routeContext);
require('./src/routes/auth-entry')(app, routeContext);
app.use([
  '/api/support-messages',
  '/api/uploads',
  '/api/auth',
  '/api/favorites',
  '/api/bookings',
], requireClientAuth);
require('./src/routes/client')(app, routeContext);
require('./src/routes/client-bookings')(app, routeContext);
app.use('/api/merchant', requireMerchantAuth);
require('./src/routes/merchant')(app, routeContext);
app.use('/api/admin', requireAdminAuth);
require('./src/routes/admin')(app, routeContext);

app.use((error, req, res, next) => {
  errorLogger(error, req);
  if (res.headersSent) return next(error);
  res.status(500).json({ message: 'Internal server error', requestId: req.requestId });
});


const startServer = async () => {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error('MONGODB_URI is missing. Add it to .env before starting the backend.');
  }

  await mongoose.connect(mongoUri);
  // No live users yet: invalidate and remove legacy plaintext sessions instead of maintaining a dual-read migration.
  await Promise.all([ClientUser, MerchantUser, AdminUser].map(Model =>
    Model.collection.updateMany(
      { sessionToken: { $exists: true } },
      { $unset: { sessionToken: '' }, $set: { sessionTokenHash: '', sessionExpiresAt: null } },
    )));
  const redisConnected = await connectRedis();
  if (redisConnected) {
    await subscribeSessionRevocations(closeSocketsBySessionHash);
    console.log('Redis connected');
  } else {
    console.warn('REDIS_URL is missing; using process-local rate limits');
  }
  await Promise.all([
    Booking.createIndexes(),
    SlotOccupancy.createIndexes(),
    ClientUser.createIndexes(),
    MerchantUser.createIndexes(),
    Salon.createIndexes(),
    CouponCampaign.createIndexes(),
    UserCoupon.createIndexes(),
  ]);
  console.log('MongoDB connected');

  server.listen(PORT, listenHost, () => {
    console.log(`Backend running at http://localhost:${PORT}`);
  });
};

if (require.main === module) {
  startServer().catch((error) => {
    console.error('Failed to start backend:', error.message);
    process.exit(1);
  });
}

module.exports = {
  activeSessionQuery,
  acceptedBookingAtTimeQuery,
  buildGeoLocation,
  buildMerchantSalonPayload,
  buildPublicSalonDetail,
  buildStaffPayload,
  clearPublicSalonDetailCache,
  buildMerchantBookingScope,
  campaignPayload,
  calculateDistanceKm,
  couponDiscountForOrder,
  couponPayload,
  couponStatus,
  getApprovedReviewsByStaffIds,
  getNearbySalons,
  getCoordinates,
  generateSlotsForStaffAndDate,
  hashPassword,
  hasReviewableContentChanges,
  INPUT_LIMITS,
  normalizeServiceTags,
  normalizeClosedDates,
  ensureSalonForMerchant,
  normalizeAdLink,
  normalizePagination,
  normalizeRadiusKm,
  createClientUserWithSignupCoupons,
  createSession,
  parseMerchantRescheduleTime,
  readFavoriteSalons,
  socketCanReceiveBooking,
  server,
  isSalonClosedOnDate,
  isSameDayBookingBlocked,
  logoutSession,
  normalizeBooking,
  normalizeMerchantBooking,
  stripSensitiveSalonFields,
  verifyPassword,
  validateCampaignInput,
};
