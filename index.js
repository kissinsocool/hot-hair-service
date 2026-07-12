const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { WebSocketServer } = require('ws');
const {
  PORT,
  DEMO_USER_ID,
  uploadDir,
  imageCacheDir,
  dataDir,
  favoritesFile,
  picturesDir,
  amapWebServiceKey,
  publicBaseUrl,
  wechatAppId,
  wechatAppSecret,
  isAllowedOrigin,
} = require('./src/config');
const {
  Booking,
  UserPolicy,
  FavoriteSalon,
  Salon,
  StaffProfile,
  MerchantUser,
  AdminUser,
  ClientUser,
  SmsVerification,
} = require('./src/models');
const {
  compressedImageMiddleware,
  imageExists,
  publicImageUrl,
  saveBase64Image,
  savePrivateBase64Image,
  privateImageUrl,
} = require('./src/images');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(cors({
  origin: (origin, callback) => {
    if (isAllowedOrigin(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
}));
app.use(express.json({ limit: process.env.JSON_LIMIT || '10mb' }));

// 静态资源托管
fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(imageCacheDir, { recursive: true });
app.use('/cached-images', express.static(imageCacheDir));
app.get(/^\/images\/(.+)/, compressedImageMiddleware(picturesDir));
app.use('/images', express.static(picturesDir));
app.get(/^\/uploads\/(.+)/, compressedImageMiddleware(uploadDir));
app.use('/uploads', express.static(uploadDir));
fs.mkdirSync(dataDir, { recursive: true });

const hashPassword = (password, salt = crypto.randomBytes(16).toString('hex')) => ({
  salt,
  hash: crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex'),
});

const timingSafeEqualHex = (left, right) => {
  const leftBuffer = Buffer.from(String(left || ''), 'hex');
  const rightBuffer = Buffer.from(String(right || ''), 'hex');
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const verifyPassword = (password, user) => {
  const currentHash = hashPassword(password, user.passwordSalt).hash;
  const legacyHash = crypto.createHash('sha256').update(`${user.passwordSalt}:${password}`).digest('hex');
  return timingSafeEqualHex(currentHash, user.passwordHash) || timingSafeEqualHex(legacyHash, user.passwordHash);
};

const normalizePhone = (phone) => String(phone || '').replace(/\D/g, '');

const isValidPhone = (phone) => /^1\d{10}$/.test(phone);

const normalizeClientAccount = (account) => {
  const trimmed = String(account || '').trim();
  const phone = normalizePhone(trimmed);
  return isValidPhone(phone) ? phone : trimmed;
};

const normalizeUserId = (id) => String(id || '').trim().replace(/^user-/, '');

const userIdAliases = (id) => {
  const normalized = normalizeUserId(id);
  if (!normalized) return [];
  return normalized === DEMO_USER_ID
    ? [DEMO_USER_ID, 'user-demo', 'demo-user']
    : [normalized, `user-${normalized}`];
};

const newClientUserId = () => crypto.randomUUID();

const maskPhone = (phone) =>
  phone.length === 11 ? `${phone.slice(0, 3)}****${phone.slice(7)}` : phone;

const hashSmsCode = (phone, code) =>
  crypto.createHash('sha256').update(`${phone}:${code}`).digest('hex');

const buildMerchantUserPayload = (user) => ({
  id: user.id,
  username: user.username,
  displayName: user.displayName,
  salonId: user.salonId,
  deposit: user.deposit || 0,
  role: user.role,
});

const stripSensitiveSalonFields = (salon = {}) => {
  const {
    licenseUrl,
    licenseStatus,
    licenseRejectReason,
    licenseSubmittedAt,
    licenseReviewedAt,
    ...publicSalon
  } = salon || {};
  return publicSalon;
};

const buildAdminMerchantPayload = async (user, salonDocument = {}) => {
  const salon = normalizeDocument(salonDocument);
  const staffMap = await getStaffMapByIds(salon.staffIds || []);
  const publicSalon = {
    ...stripSensitiveSalonFields(salon),
    staff: (salon.staffIds || []).map(id => staffMap[id]).filter(Boolean).map(buildStaffPayload),
  };
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
    contentReviewedAt: salon.contentReviewedAt,
    salon: salon.pendingContent ? { ...publicSalon, ...salon.pendingContent } : publicSalon,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt,
  };
};

const buildAdminUserPayload = (user) => ({
  id: user.id,
  username: user.username,
  displayName: user.displayName,
  role: user.role,
});

const buildClientUserPayload = (user) => ({
  id: normalizeUserId(user.id),
  account: user.account,
  displayName: user.displayName,
  gender: user.gender || '保密',
  avatarUrl: user.avatarUrl || '',
  phone: user.phone || user.account,
});

let wechatTokenCache = { token: '', expiresAt: 0 };

const getWechatAccessToken = async () => {
  if (wechatTokenCache.token && wechatTokenCache.expiresAt > Date.now()) return wechatTokenCache.token;

  const url = new URL('https://api.weixin.qq.com/cgi-bin/token');
  url.searchParams.set('grant_type', 'client_credential');
  url.searchParams.set('appid', wechatAppId);
  url.searchParams.set('secret', wechatAppSecret);
  const data = await fetchJson(url);
  if (!data?.access_token) throw new Error(data?.errmsg || '获取微信 access_token 失败');

  wechatTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + Math.max(Number(data.expires_in || 7200) - 300, 60) * 1000,
  };
  return wechatTokenCache.token;
};

const getWechatPhoneNumber = async (code) => {
  const accessToken = await getWechatAccessToken();
  const data = await fetchJson(`https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token=${accessToken}`, {
    method: 'POST',
    body: JSON.stringify({ code }),
    headers: { 'content-type': 'application/json' },
  });
  const phone = normalizePhone(data?.phone_info?.phoneNumber);
  if (!isValidPhone(phone)) throw new Error(data?.errmsg || '微信手机号授权失败');
  return phone;
};

const getWechatSessionKey = async (loginCode) => {
  const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
  url.searchParams.set('appid', wechatAppId);
  url.searchParams.set('secret', wechatAppSecret);
  url.searchParams.set('js_code', loginCode);
  url.searchParams.set('grant_type', 'authorization_code');
  const data = await fetchJson(url);
  if (!data?.session_key) throw new Error(data?.errmsg || '微信登录失败');
  return data.session_key;
};

const decryptWechatPhoneNumber = async ({ encryptedData, iv, loginCode }) => {
  if (!encryptedData || !iv || !loginCode) throw new Error('微信手机号授权失败');
  const sessionKey = await getWechatSessionKey(loginCode);
  const decipher = crypto.createDecipheriv(
    'aes-128-cbc',
    Buffer.from(sessionKey, 'base64'),
    Buffer.from(iv, 'base64'),
  );
  decipher.setAutoPadding(true);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedData, 'base64')),
    decipher.final(),
  ]);
  const data = JSON.parse(decrypted.toString('utf8'));
  if (data?.watermark?.appid && data.watermark.appid !== wechatAppId) {
    throw new Error('微信手机号授权失败');
  }
  const phone = normalizePhone(data.phoneNumber || data.purePhoneNumber);
  if (!isValidPhone(phone)) throw new Error('微信手机号授权失败');
  return phone;
};

const loginClientByPhone = async (phone) => {
  let user = await ClientUser.findOne({ $or: [{ account: phone }, { phone }] });
  if (!user) {
    const password = crypto.randomBytes(16).toString('hex');
    const { salt, hash } = hashPassword(password);
    user = await ClientUser.create({
      id: newClientUserId(),
      account: phone,
      displayName: maskPhone(phone),
      gender: '保密',
      phone,
      passwordSalt: salt,
      passwordHash: hash,
    });
  }

  user.sessionToken = crypto.randomBytes(32).toString('hex');
  user.lastLoginAt = new Date();
  await user.save();

  return {
    token: user.sessionToken,
    user: buildClientUserPayload(user),
  };
};

const requireMerchantAuth = async (req, res, next) => {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return res.status(401).json({ message: 'Merchant login required' });

  const user = await MerchantUser.findOne({ sessionToken: token }).lean();
  if (!user) return res.status(401).json({ message: 'Merchant login expired' });

  req.merchantUser = user;
  next();
};

const requireAdminAuth = async (req, res, next) => {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return res.status(401).json({ message: 'Admin login required' });

  const user = await AdminUser.findOne({ sessionToken: token }).lean();
  if (!user) return res.status(401).json({ message: 'Admin login expired' });

  req.adminUser = user;
  next();
};

const getClientUserFromRequest = async (req) => {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  return ClientUser.findOne({ sessionToken: token }).lean();
};

const requireClientAuth = async (req, res, next) => {
  const user = await getClientUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'User login required' });
  req.clientUser = user;
  next();
};

const resolveRequestUser = async (req) => {
  const clientUser = await getClientUserFromRequest(req);
  if (clientUser) {
    return {
      userId: normalizeUserId(clientUser.id),
      userName: clientUser.displayName || clientUser.account,
    };
  }

  return {
    userId: normalizeUserId(req.body?.userId || req.query?.userId || DEMO_USER_ID),
    userName: req.body?.userName || 'Demo 用户',
  };
};

const sendSocketMessage = (socket, payload) => {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify(payload));
};

const broadcastBookingEvent = (event, booking) => {
  const payload = {
    event,
    booking: normalizeBooking(booking),
  };

  wss.clients.forEach((client) => {
    sendSocketMessage(client, payload);
  });
};

wss.on('connection', (socket) => {
  sendSocketMessage(socket, {
    event: 'connected',
    message: 'Booking updates connected.',
  });
});

// --- Initial merchant template data ---
const imageUrl = `${publicBaseUrl}/images/云南/1/IMG_1310.JPG`;
const defaultSalonLocation = { latitude: 31.2304, longitude: 121.4737 };

const salons = [
  {
    id: '1',
    name: 'Modern Cut Studio',
    address: '上海市黄浦区',
    location: defaultSalonLocation,
    rating: 4.8,
    image: imageUrl,
    images: [],
    promoImages: [imageUrl],
    description: '专业极简主义剪发，打造你的个性之美。',
    fullDescription: 'Modern Cut Studio 致力于将现代极简主义与经典剪裁相结合。',
    openingHours: '10:00 - 20:00',
    phone: '03-1234-5678',
    staffIds: ['1', '2'],
    services: [
      { id: 's1', name: '极简修剪', price: '¥5,000', duration: '60min', note: '适合日常维护和快速修整。', imageUrl },
      { id: 's2', name: '质感染发', price: '¥12,000', duration: '120min', note: '染前会进行发质咨询。', imageUrl },
      { id: 's3', name: '头皮深层护理', price: '¥8,000', duration: '90min', note: '敏感头皮请提前告知。', imageUrl },
    ]
  }
];

const legacyMockSalonNames = new Set([
  'Elite Glow Salon',
]);

const staff = {
  '1': {
    id: '1',
    name: 'Sato 先生',
    role: '首席发型师',
    experience: '8年专业经验',
    extraServiceFee: 0,
    imageUrl: 'https://images.unsplash.com/photo-1500648767791-ced8051cb34c?q=80&w=200',
    bio: '你好！我是 Sato。我致力于通过精准的剪裁和自然的色彩，挖掘每个人潜藏的独特气质。',
    rating: 4.8,
    reviews: [
      { id: 'r1', user: '田中', rating: 5, comment: '剪发非常精准，完全是我想要的样子！', date: '2026-05-10' },
      { id: 'r2', user: '佐藤', rating: 4, comment: '技术很好，就是预约稍微有点难。', date: '2026-05-15' },
      { id: 'r10', user: '小林', rating: 5, comment: '非常专业的首席发型师，细节把控极强。', date: '2026-06-01' },
      { id: 'r11', user: '美奈', rating: 5, comment: '帮我设计的新发型太适合我了，谢谢Sato先生！', date: '2026-06-05' }
    ]
  },
  '2': {
    id: '2',
    name: 'Yumi 小姐',
    role: '创意总监',
    experience: '10年经验',
    extraServiceFee: 0,
    imageUrl: 'https://images.unsplash.com/photo-1438761681033-724816758d4b?q=80&w=200',
    bio: '追求自然与流畅的线条感，让发型成为你穿搭的一部分。',
    rating: 4.9,
    reviews: [
      { id: 'r3', user: '小林', rating: 5, comment: '非常有艺术感的剪发，强烈推荐！', date: '2026-05-12' },
      { id: 'r4', user: '加藤', rating: 5, comment: '细节处理得非常完美。', date: '2026-05-20' },
      { id: 'r5', user: '铃木', rating: 4, comment: '服务态度非常好，很舒适。', date: '2026-05-22' },
      { id: 'r12', user: '爱丽', rating: 5, comment: 'Yumi小姐的审美真的绝了，剪完感觉整个人气质提升。', date: '2026-06-02' }
    ]
  },
  '3': {
    id: '3',
    name: 'Ken 先生',
    role: '色彩专家',
    experience: '6年经验',
    extraServiceFee: 0,
    imageUrl: 'https://images.unsplash.com/photo-1472099642232-ed44ee252772?q=80&w=200',
    bio: '色彩是改变心情最快的方式，我将为你寻找最适合你的那个色调。',
    rating: 4.7,
    reviews: [
      { id: 'r6', user: '山本', rating: 5, comment: '染出的颜色非常高级，不掉色。', date: '2026-05-05' },
      { id: 'r7', user: '中村', rating: 4, comment: '色彩方案很专业，沟通顺畅。', date: '2026-05-18' },
      { id: 'r13', user: '宏太', rating: 5, comment: '颜色调得非常自然，非常满意。', date: '2026-06-03' },
      { id: 'r14', user: '由美', rating: 4, comment: '专业度很高，染发过程非常舒适。', date: '2026-06-07' }
    ]
  },
  '4': {
    id: '4',
    name: 'Miki 小姐',
    role: '资深发型师',
    experience: '5年经验',
    extraServiceFee: 0,
    imageUrl: 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?q=80&w=200',
    bio: '健康的发质是美感的基础，我专注于为您提供最温和的修复方案。',
    rating: 4.6,
    reviews: [
      { id: 'r8', user: '高桥', rating: 4, comment: '护理之后头发顺滑了很多。', date: '2026-05-01' },
      { id: 'r9', user: '伊藤', rating: 5, comment: '非常温柔的发型师，体验很棒。', date: '2026-05-11' },
      { id: 'r15', user: '直树', rating: 5, comment: '头皮护理非常舒服，感觉压力都释放了。', date: '2026-06-04' },
      { id: 'r16', user: '结衣', rating: 4, comment: '发质修复效果很明显，头发亮了很多。', date: '2026-06-08' }
    ]
  }
};

const normalizeDocument = (document) =>
  typeof document?.toObject === 'function' ? document.toObject() : document;

const getAllSalons = async (limit) => {
  if (limit) {
    return Salon.find({ publishStatus: 'online' }).sort({ id: 1 }).limit(limit).lean();
  }
  const salonList = await Salon.find({ publishStatus: 'online' }).lean();
  return salonList.sort((a, b) => Number(a.id) - Number(b.id));
};

const toFiniteNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const getCoordinates = (location) => {
  if (!location) return null;
  if (typeof location === 'string') {
    const [longitude, latitude] = location.split(',').map(toFiniteNumber);
    return latitude !== null && longitude !== null ? { latitude, longitude } : null;
  }
  if (Array.isArray(location?.coordinates)) {
    const [longitude, latitude] = location.coordinates.map(toFiniteNumber);
    return latitude !== null && longitude !== null ? { latitude, longitude } : null;
  }
  const latitude = toFiniteNumber(location.latitude ?? location.lat);
  const longitude = toFiniteNumber(location.longitude ?? location.lng ?? location.lon);
  return latitude !== null && longitude !== null ? { latitude, longitude } : null;
};

const buildGeoLocation = (location) => {
  const coordinates = getCoordinates(location);
  return coordinates
    ? { type: 'Point', coordinates: [coordinates.longitude, coordinates.latitude] }
    : null;
};

const calculateDistanceKm = (from, to) => {
  const toRadians = (degrees) => degrees * Math.PI / 180;
  const deltaLatitude = toRadians(to.latitude - from.latitude);
  const deltaLongitude = toRadians(to.longitude - from.longitude);
  const startLatitude = toRadians(from.latitude);
  const endLatitude = toRadians(to.latitude);
  const a = Math.sin(deltaLatitude / 2) ** 2
    + Math.cos(startLatitude) * Math.cos(endLatitude) * Math.sin(deltaLongitude / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const filterNearbySalons = (salonList, userLocation, radiusKm = 10) =>
  salonList
    .map((salon) => {
      const salonLocation = getCoordinates(salon.location || salon.geoLocation);
      if (!salonLocation) return null;
      return { ...salon, distanceKm: Number(calculateDistanceKm(userLocation, salonLocation).toFixed(2)) };
    })
    .filter(Boolean)
    .filter((salon) => salon.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm);

const normalizeLimit = (value, fallback = 50, max = 100) => {
  const limit = Math.floor(Number(value));
  return Number.isFinite(limit) && limit > 0 ? Math.min(limit, max) : fallback;
};

const buildSearchRadii = (radiusKm, maxRadiusKm) => {
  const radii = [];
  let currentRadiusKm = Math.max(radiusKm, 0.1);
  const stopRadiusKm = Math.max(currentRadiusKm, maxRadiusKm);
  while (currentRadiusKm <= stopRadiusKm) {
    radii.push(currentRadiusKm);
    currentRadiusKm *= 2;
  }
  return radii;
};

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
  const salonList = await Salon.find(query).limit(limit).lean();
  return salonList
    .map((salon) => {
      const salonLocation = getCoordinates(salon.location || salon.geoLocation);
      return salonLocation
        ? { ...salon, distanceKm: Number(calculateDistanceKm(userLocation, salonLocation).toFixed(2)) }
        : salon;
    })
    .sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
};

const getNearbySalons = async (userLocation, radiusKm, limit, minResults = 10, maxRadiusKm = 5000) => {
  const targetCount = Math.min(limit, minResults);
  let salonList = [];

  for (const searchRadiusKm of buildSearchRadii(radiusKm, maxRadiusKm)) {
    salonList = await findNearbySalons(userLocation, searchRadiusKm, limit);
    if (salonList.length >= targetCount) return salonList;
  }

  // ponytail: legacy coordinate fallback, remove after every salon has geoLocation.
  return filterNearbySalons(await getAllSalons(), userLocation, maxRadiusKm).slice(0, limit);
};

const getServiceById = async (serviceId) => {
  const salon = await Salon.findOne({ 'services.id': serviceId }).lean();
  return salon?.services?.find(item => item.id === serviceId) || null;
};

const getSalonByStaffId = (staffId) => Salon.findOne({ staffIds: staffId });

const getStaffById = (staffId) => StaffProfile.findOne({ id: staffId });

const getStaffMapByIds = async (staffIds = []) => {
  const profiles = await StaffProfile.find({ id: { $in: staffIds } }).lean();
  return Object.fromEntries(profiles.map(profile => [profile.id, profile]));
};

const parseTimeToMinutes = (time) => {
  const match = String(time || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
};

const formatMinutesAsTime = (value) => {
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
};

const parseOpeningHours = (openingHours) => {
  const match = String(openingHours || '').match(/(\d{1,2}:\d{2})\s*[-~—–]\s*(\d{1,2}:\d{2})/);
  const start = parseTimeToMinutes(match?.[1]) ?? 10 * 60;
  const end = parseTimeToMinutes(match?.[2]) ?? 20 * 60;
  return end >= start ? { start, end } : { start: 10 * 60, end: 20 * 60 };
};

const parsePriceValue = (price) => {
  const value = Number(String(price || '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(value) ? value : 0;
};

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

const generateHalfHourSlots = (openingHours = '10:00 - 20:00') => {
  const { start, end } = parseOpeningHours(openingHours);
  const slots = [];
  for (let minutes = start; minutes <= end; minutes += 30) {
    slots.push(formatMinutesAsTime(minutes));
  }
  return slots;
};

const normalizeUnavailableSlots = (slots) => {
  if (!Array.isArray(slots)) return [];
  return [...new Set(
    slots
      .filter(slot => typeof slot === 'string')
      .map(slot => slot.trim())
      .filter(slot => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(slot))
  )].sort();
};

const isStaffUnavailable = async (staffId, startTime) => {
  const person = await getStaffById(staffId).lean();
  if (!person) return false;
  if (typeof startTime !== 'string') return false;
  const match = startTime.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  if (!match) return false;
  const [, dateKey, timeKey] = match;
  return normalizeUnavailableSlots(person.unavailableSlots).includes(`${dateKey} ${timeKey}`);
};

const findActiveBookingAtTime = (staffId, startTime) =>
  Booking.findOne({
    staffId,
    startTime: new Date(startTime),
    status: { $in: ['pending', 'accepted'] },
  });

const findActiveBookingAtTimeExcluding = (staffId, startTime, bookingId) =>
  Booking.findOne({
    staffId,
    startTime: new Date(startTime),
    id: { $ne: bookingId },
    status: { $in: ['pending', 'accepted'] },
  });

const acceptedBookingAtTimeQuery = (staffId, startTime, bookingId) => ({
  staffId,
  startTime: new Date(startTime),
  id: { $ne: bookingId },
  status: 'accepted',
});

const findAcceptedBookingAtTimeExcluding = (staffId, startTime, bookingId) =>
  Booking.findOne(acceptedBookingAtTimeQuery(staffId, startTime, bookingId));

const normalizeBooking = (booking) => ({
  ...(typeof booking.toObject === 'function' ? booking.toObject() : booking),
  statusLabel: {
    pending: '等待商家确认',
    accepted: '预约成功',
    canceled: '预约已取消',
    completed: '已完成',
    no_show: '爽约',
    rejected: '预约被拒绝',
  }[booking.status] || booking.status,
});

const USER_CANCEL_WINDOW_MS = 3 * 60 * 60 * 1000;
const BLACKLIST_NO_SHOW_LIMIT = 3;

const getUserPolicy = async (userId) =>
  UserPolicy.findOneAndUpdate(
    { userId },
    { $setOnInsert: { userId, noShowCount: 0, isBlacklisted: false } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

const incrementNoShowCount = async (userId) => {
  const policy = await getUserPolicy(userId);
  policy.noShowCount = Number(policy.noShowCount || 0) + 1;
  policy.isBlacklisted = policy.noShowCount >= BLACKLIST_NO_SHOW_LIMIT;
  policy.updatedAt = new Date();
  await policy.save();
  return policy;
};

const calculateStaffRating = (person) => {
  const reviews = publicReviews(person);
  if (!reviews.length) {
    return 5;
  }

  const total = reviews.reduce((sum, review) => sum + Number(review.rating || 0), 0);
  return Number((total / reviews.length).toFixed(1));
};

const buildStaffPayload = (person) => ({
  ...person,
  reviews: publicReviews(person),
  rating: calculateStaffRating(person),
});

const publicReviews = (person) =>
  ((person && Array.isArray(person.reviews)) ? person.reviews : [])
    .filter(review => !review.reviewStatus || review.reviewStatus === 'approved')
    .map(({ pendingImageUrls, ...review }) => review);

const buildSalonImageList = (salon) => {
  const images = [
    ...(Array.isArray(salon?.promoImages) ? salon.promoImages : []),
    ...(Array.isArray(salon?.images) ? salon.images : []),
  ];

  return [...new Set(images.filter(image => typeof image === 'string' && image.trim()))]
    .slice(0, 20);
};

const salonCoverImage = (salon) =>
  publicImageUrl([salon?.image, ...buildSalonImageList(salon)].find(image => typeof image === 'string' && image.trim() && imageExists(image)) || '');

const buildSalonDetail = async (salonDocument) => {
  const salon = normalizeDocument(salonDocument);
  const staffMap = await getStaffMapByIds(salon.staffIds);
  const staffList = salon.staffIds.map(id => staffMap[id]).filter(Boolean);
  return {
    ...stripSensitiveSalonFields(salon),
    image: salonCoverImage(salon),
    images: buildSalonImageList(salon).filter(imageExists).map(publicImageUrl),
    promoImages: buildSalonImageList(salon).filter(imageExists).map(publicImageUrl),
    staff: staffList.map(buildStaffPayload),
    reviews: staffList.flatMap(staff => (staff.reviews || []).map(review => ({
      ...review,
      staffName: staff.name,
    }))),
  };
};

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
  'phone',
  'services',
  'staff',
];

const buildContentDraft = async (salon, payload) => {
  const draft = salon.pendingContent || await buildSalonDetail(salon);
  const set = (key, value) => {
    if (value !== undefined) draft[key] = value;
  };

  set('name', typeof payload.name === 'string' ? payload.name.trim() : undefined);
  set('address', typeof payload.address === 'string' ? payload.address : undefined);
  set('addressRegion', payload.addressRegion && typeof payload.addressRegion === 'object' ? payload.addressRegion : undefined);
  set('addressDetail', typeof payload.addressDetail === 'string' ? payload.addressDetail : undefined);
  set('location', payload.location && typeof payload.location === 'object' ? payload.location : undefined);
  set('description', typeof payload.description === 'string' ? payload.description : undefined);
  set('fullDescription', typeof payload.fullDescription === 'string' ? payload.fullDescription : undefined);
  set('image', typeof payload.image === 'string' ? payload.image : undefined);
  set('openingHours', typeof payload.openingHours === 'string' ? payload.openingHours : undefined);
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
      .map((service, index) => ({
        id: service.id || `s1-${Date.now()}-${index}`,
        name: service.name,
        price: service.price || '',
        duration: service.duration || '',
        note: service.note || '',
        imageUrl: service.imageUrl || '',
      }));
  }

  if (Array.isArray(payload.staff)) {
    const incomingStaffIds = payload.staff
      .map((profile, index) => profile?.id || `merchant-staff-${Date.now()}-${index}`)
      .filter(Boolean);
    const existingStaffMap = await getStaffMapByIds(incomingStaffIds);
    draft.staff = payload.staff
      .filter(profile => profile && profile.name)
      .map((profile, index) => {
        const id = profile.id || `merchant-staff-${Date.now()}-${index}`;
        const previousStaff = existingStaffMap[id] || {};
        return {
          id,
          name: profile.name,
          role: profile.role || '',
          experience: profile.experience || '',
          extraServiceFee: Number(profile.extraServiceFee || 0),
          imageUrl: profile.imageUrl || '',
          bio: profile.bio || '',
          unavailableSlots: normalizeUnavailableSlots(profile.unavailableSlots),
          rating: Number(profile.rating || previousStaff.rating || 4.8),
          reviews: Array.isArray(profile.reviews) ? profile.reviews : previousStaff.reviews || [],
        };
      });
  }

  return Object.fromEntries(contentFields.map(key => [key, draft[key]]));
};

const applyPendingContent = async (salon) => {
  const draft = salon.pendingContent || {};
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

const refreshFavoriteSalonSnapshots = async (salon) => {
  await FavoriteSalon.updateMany(
    { salonId: salon.id },
    { $set: { salon: await buildSalonDetail(salon) } },
  );
};

const buildMerchantSalonPayload = async (salonId = '1') => {
  const salon = await Salon.findOne({ id: salonId });
  const payload = await buildSalonDetail(salon);
  return salon.pendingContent ? { ...payload, ...salon.pendingContent } : payload;
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
    phone: '',
    staffIds: [],
    services: [],
    publishStatus: 'offline',
    licenseUrl: '',
    licenseStatus: 'unsubmitted',
    licenseRejectReason: '',
  });
};

const readFavoriteSalonsFromFile = () => {
  if (!fs.existsSync(favoritesFile)) return [];

  try {
    const parsed = JSON.parse(fs.readFileSync(favoritesFile, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
};

const readFavoriteSalons = async (userId = DEMO_USER_ID) => {
  const favorites = await FavoriteSalon
    .find({ userId: { $in: userIdAliases(userId) } })
    .sort({ createdAt: -1 })
    .lean();
  return favorites.map(favorite => stripSensitiveSalonFields(favorite.salon));
};

const migrateFavoriteSalonsFromFile = async () => {
  const existingCount = await FavoriteSalon.countDocuments({ userId: { $in: userIdAliases(DEMO_USER_ID) } });
  if (existingCount > 0) return;

  const favorites = readFavoriteSalonsFromFile();
  if (favorites.length === 0) return;

  await FavoriteSalon.insertMany(
    favorites
      .filter(salon => salon?.id)
      .map(salon => ({
        userId: DEMO_USER_ID,
        salonId: salon.id.toString(),
        salon,
      })),
    { ordered: false },
  ).catch(() => {});
};

const syncSalonGeoLocations = async () => {
  const salonList = await Salon.find({ location: { $ne: null } }, { id: 1, location: 1, geoLocation: 1 }).lean();
  const updates = salonList
    .map((salon) => ({ salon, geoLocation: buildGeoLocation(salon.location) }))
    .filter(({ geoLocation }) => geoLocation)
    .filter(({ salon, geoLocation }) => {
      const existing = getCoordinates(salon.geoLocation);
      return !existing
        || existing.latitude !== geoLocation.coordinates[1]
        || existing.longitude !== geoLocation.coordinates[0];
    })
    .map(({ salon, geoLocation }) => ({
      updateOne: {
        filter: { _id: salon._id },
        update: { $set: { geoLocation } },
      },
    }));

  if (updates.length > 0) await Salon.bulkWrite(updates, { ordered: false });
};

const migrateSeedDataToMongo = async () => {
  const [salonCount, staffCount, merchantCount, adminCount, clientCount] = await Promise.all([
    Salon.countDocuments(),
    StaffProfile.countDocuments(),
    MerchantUser.countDocuments(),
    AdminUser.countDocuments(),
    ClientUser.countDocuments(),
  ]);

  if (staffCount === 0) {
    await StaffProfile.insertMany(
      Object.values(staff).map(profile => ({
        ...profile,
        unavailableSlots: normalizeUnavailableSlots(profile.unavailableSlots),
      })),
      { ordered: false },
    ).catch(() => {});
  }

  if (merchantCount === 0) {
    const { salt, hash } = hashPassword('123456');
    await MerchantUser.create({
      id: 'merchant-1',
      username: 'merchant',
      displayName: 'Modern Cut Studio 商家',
      salonId: '1',
      role: 'merchant',
      passwordSalt: salt,
      passwordHash: hash,
    });
  }

  if (salonCount === 0) {
    await Salon.create({
      ...salons[0],
      publishStatus: 'online',
      licenseStatus: 'unsubmitted',
      licenseUrl: '',
      licenseRejectReason: '',
    }).catch(() => {});
  }

  await Salon.updateOne(
    { id: '1', $or: [{ location: null }, { location: { $exists: false } }] },
    {
      $set: {
        location: defaultSalonLocation,
        geoLocation: buildGeoLocation(defaultSalonLocation),
        publishStatus: 'online',
      },
    },
  );

  const merchantUsers = await MerchantUser.find({}).lean();
  await Promise.all(merchantUsers.map(user =>
    ensureSalonForMerchant({ salonId: user.salonId, displayName: user.displayName })
  ));
  await Promise.all(merchantUsers.map(async (user) => {
    if (user.username === 'merchant') return;
    const salon = await Salon.findOne({ id: user.salonId });
    if (!salon || !legacyMockSalonNames.has(salon.name)) return;

    salon.name = '';
    salon.address = '';
    salon.addressRegion = {};
    salon.addressDetail = '';
    salon.location = null;
    salon.image = '';
    salon.images = [];
    salon.promoImages = [];
    salon.description = '';
    salon.fullDescription = '';
    salon.openingHours = '10:00 - 20:00';
    salon.phone = '';
    salon.staffIds = [];
    salon.services = [];
    salon.publishStatus = 'offline';
    salon.licenseUrl = '';
    salon.licenseStatus = 'unsubmitted';
    salon.licenseRejectReason = '';
    await salon.save();
  }));

  const merchantSalonIds = [
    ...new Set(
      merchantUsers
        .map(user => String(user.salonId || '').trim())
        .filter(Boolean)
    ),
  ];
  if (merchantSalonIds.length > 0) {
    await Salon.deleteMany({ id: { $nin: merchantSalonIds } });
    await FavoriteSalon.deleteMany({ salonId: { $nin: merchantSalonIds } });
  }
  await Salon.updateMany(
    { publishStatus: { $exists: false } },
    { $set: { publishStatus: 'online', licenseStatus: 'unsubmitted', licenseUrl: '' } },
  );

  if (adminCount === 0) {
    const { salt, hash } = hashPassword('admin123456');
    await AdminUser.create({
      id: 'admin-1',
      username: 'admin',
      displayName: '平台管理员',
      role: 'admin',
      passwordSalt: salt,
      passwordHash: hash,
    });
  }

  if (clientCount === 0) {
    const { salt, hash } = hashPassword('123456');
    await ClientUser.create({
      id: DEMO_USER_ID,
      account: 'demo',
      displayName: 'Demo 用户',
      passwordSalt: salt,
      passwordHash: hash,
    });
  }
};

const generateSlotsForStaffAndDate = async (staffId, date) => {
  const salon = await getSalonByStaffId(staffId).lean();
  const slots = await Promise.all(generateHalfHourSlots(salon?.openingHours).map(async (time) => {
    const startTime = `${date}T${time}:00`;
    const hasBooking = await findActiveBookingAtTime(staffId, startTime);
    const unavailable = await isStaffUnavailable(staffId, startTime);
    return {
      time,
      startTime,
      isAvailable: !hasBooking && !unavailable,
      reason: hasBooking ? '已有订单' : unavailable ? '理发师缺勤' : undefined,
    };
  }));
  return slots;
};

const generateSlotsForNoPreferenceAndDate = async (candidateStaffIds, date) => {
  const salon = await getSalonByStaffId(candidateStaffIds[0]).lean();
  const slots = await Promise.all(generateHalfHourSlots(salon?.openingHours).map(async (time) => {
    const startTime = `${date}T${time}:00`;
    const availability = await Promise.all(candidateStaffIds.map(async (staffId) => {
      const hasBooking = await findActiveBookingAtTime(staffId, startTime);
      const unavailable = await isStaffUnavailable(staffId, startTime);
      return !hasBooking && !unavailable;
    }));
    return {
      time,
      startTime,
      isAvailable: availability.some(Boolean),
      reason: availability.some(Boolean) ? undefined : '已有订单',
    };
  }));
  return slots;
};


const routeContext = {
  acceptedBookingAtTimeQuery,
  AdminUser,
  amapWebServiceKey,
  applyPendingContent,
  Booking,
  broadcastBookingEvent,
  buildAdminMerchantPayload,
  buildAdminUserPayload,
  buildClientUserPayload,
  buildContentDraft,
  buildMerchantSalonPayload,
  buildMerchantUserPayload,
  buildSalonDetail,
  buildStaffPayload,
  buildSalonImageList,
  calculateDistanceKm,
  calculateStaffRating,
  ClientUser,
  crypto,
  DEMO_USER_ID,
  decryptWechatPhoneNumber,
  FavoriteSalon,
  fetchJson,
  filterNearbySalons,
  findAcceptedBookingAtTimeExcluding,
  findActiveBookingAtTime,
  generateSlotsForNoPreferenceAndDate,
  generateSlotsForStaffAndDate,
  getNearbySalons,
  getCoordinates,
  getSalonByStaffId,
  getServiceById,
  getStaffById,
  getStaffMapByIds,
  getUserPolicy,
  getWechatPhoneNumber,
  hashPassword,
  hashSmsCode,
  incrementNoShowCount,
  isStaffUnavailable,
  isValidPhone,
  imageExists,
  loginClientByPhone,
  maskPhone,
  MerchantUser,
  newClientUserId,
  normalizeBooking,
  normalizeClientAccount,
  normalizeDeposit,
  normalizeLimit,
  normalizePhone,
  normalizeUserId,
  parseAmapReverseAddress,
  parseOpeningHours,
  parsePriceValue,
  readFavoriteSalons,
  refreshFavoriteSalonSnapshots,
  requireAdminAuth,
  requireClientAuth,
  requireMerchantAuth,
  resolveRequestUser,
  Salon,
  salonCoverImage,
  saveBase64Image,
  savePrivateBase64Image,
  privateImageUrl,
  SmsVerification,
  publicImageUrl,
  stripSensitiveSalonFields,
  toFiniteNumber,
  USER_CANCEL_WINDOW_MS,
  userIdAliases,
  verifyPassword,
  wechatAppId,
  wechatAppSecret,
};

require('./src/routes/public')(app, routeContext);
require('./src/routes/client')(app, routeContext);
require('./src/routes/merchant')(app, routeContext);
require('./src/routes/admin')(app, routeContext);


const startServer = async () => {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error('MONGODB_URI is missing. Add it to .env before starting the backend.');
  }

  await mongoose.connect(mongoUri);
  await Salon.createIndexes();
  await migrateSeedDataToMongo();
  await syncSalonGeoLocations();
  await migrateFavoriteSalonsFromFile();
  console.log('MongoDB connected');

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Mock Backend running at http://localhost:${PORT}`);
  });
};

if (require.main === module) {
  startServer().catch((error) => {
    console.error('Failed to start backend:', error.message);
    process.exit(1);
  });
}

module.exports = {
  acceptedBookingAtTimeQuery,
  buildGeoLocation,
  buildSearchRadii,
  calculateDistanceKm,
  filterNearbySalons,
  getCoordinates,
  stripSensitiveSalonFields,
};
