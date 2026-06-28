require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { WebSocketServer } = require('ws');

const app = express();
const PORT = 3000;
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));

// 静态资源托管
app.use('/images', express.static('/Users/alice/Pictures'));
const uploadDir = path.join(__dirname, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
app.use('/uploads', express.static(uploadDir));
const dataDir = path.join(__dirname, 'data');
const favoritesFile = path.join(dataDir, 'favorites.json');
fs.mkdirSync(dataDir, { recursive: true });

const bookingSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  userId: { type: String, default: 'demo-user', index: true },
  userName: { type: String, default: 'Demo 用户' },
  salonId: String,
  salonName: String,
  staffId: { type: String, required: true, index: true },
  staffName: String,
  serviceId: { type: String, required: true },
  serviceName: String,
  servicePrice: String,
  serviceDuration: String,
  serviceBasePrice: { type: Number, default: 0 },
  staffExtraServiceFee: { type: Number, default: 0 },
  totalPrice: { type: Number, default: 0 },
  startTime: { type: Date, required: true, index: true },
  note: { type: String, default: '' },
  status: { type: String, default: 'pending', index: true },
  merchantMessage: String,
  userMessage: String,
  rejectReason: { type: String, default: '' },
  reviewed: { type: Boolean, default: false },
  review: mongoose.Schema.Types.Mixed,
  complained: { type: Boolean, default: false },
  complaint: mongoose.Schema.Types.Mixed,
  createdAt: Date,
  updatedAt: Date,
}, { id: false });

const userPolicySchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true, index: true },
  noShowCount: { type: Number, default: 0 },
  isBlacklisted: { type: Boolean, default: false },
  updatedAt: Date,
}, { timestamps: true });

const favoriteSalonSchema = new mongoose.Schema({
  userId: { type: String, default: 'demo-user', index: true },
  salonId: { type: String, required: true, index: true },
  salon: { type: mongoose.Schema.Types.Mixed, required: true },
}, { timestamps: true });

favoriteSalonSchema.index({ userId: 1, salonId: 1 }, { unique: true });

const salonSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  name: String,
  address: String,
  addressRegion: mongoose.Schema.Types.Mixed,
  addressDetail: String,
  rating: Number,
  image: String,
  images: [String],
  promoImages: [String],
  description: String,
  fullDescription: String,
  openingHours: String,
  phone: String,
  staffIds: [String],
  services: [mongoose.Schema.Types.Mixed],
  publishStatus: { type: String, default: 'online', index: true },
  licenseUrl: { type: String, default: '' },
  licenseStatus: { type: String, default: 'unsubmitted', index: true },
  licenseRejectReason: { type: String, default: '' },
  licenseSubmittedAt: Date,
  licenseReviewedAt: Date,
}, { timestamps: true });

const staffProfileSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  name: String,
  role: String,
  experience: String,
  extraServiceFee: { type: Number, default: 0 },
  imageUrl: String,
  bio: String,
  rating: Number,
  reviews: [mongoose.Schema.Types.Mixed],
  unavailableSlots: [String],
}, { timestamps: true });

const merchantUserSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  username: { type: String, required: true, unique: true, index: true },
  displayName: String,
  salonId: { type: String, default: '1', index: true },
  role: { type: String, default: 'merchant' },
  passwordHash: { type: String, required: true },
  passwordSalt: { type: String, required: true },
  sessionToken: { type: String, default: '' },
  lastLoginAt: Date,
}, { timestamps: true });

const adminUserSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  username: { type: String, required: true, unique: true, index: true },
  displayName: String,
  role: { type: String, default: 'admin' },
  passwordHash: { type: String, required: true },
  passwordSalt: { type: String, required: true },
  sessionToken: { type: String, default: '', index: true },
  lastLoginAt: Date,
}, { timestamps: true });

const clientUserSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  account: { type: String, required: true, unique: true, index: true },
  displayName: String,
  gender: { type: String, default: '保密' },
  avatarUrl: { type: String, default: '' },
  phone: { type: String, default: '' },
  passwordHash: { type: String, required: true },
  passwordSalt: { type: String, required: true },
  sessionToken: { type: String, default: '', index: true },
  lastLoginAt: Date,
}, { timestamps: true });

const smsVerificationSchema = new mongoose.Schema({
  phone: { type: String, required: true, index: true },
  codeHash: { type: String, required: true },
  expiresAt: { type: Date, required: true, index: true },
  consumedAt: Date,
}, { timestamps: true });

const Booking = mongoose.model('Booking', bookingSchema);
const UserPolicy = mongoose.model('UserPolicy', userPolicySchema);
const FavoriteSalon = mongoose.model('FavoriteSalon', favoriteSalonSchema);
const Salon = mongoose.model('Salon', salonSchema);
const StaffProfile = mongoose.model('StaffProfile', staffProfileSchema);
const MerchantUser = mongoose.model('MerchantUser', merchantUserSchema);
const AdminUser = mongoose.model('AdminUser', adminUserSchema);
const ClientUser = mongoose.model('ClientUser', clientUserSchema);
const SmsVerification = mongoose.model('SmsVerification', smsVerificationSchema);

const hashPassword = (password, salt = crypto.randomBytes(16).toString('hex')) => ({
  salt,
  hash: crypto.createHash('sha256').update(`${salt}:${password}`).digest('hex'),
});

const normalizePhone = (phone) => String(phone || '').replace(/\D/g, '');

const isValidPhone = (phone) => /^1\d{10}$/.test(phone);

const maskPhone = (phone) =>
  phone.length === 11 ? `${phone.slice(0, 3)}****${phone.slice(7)}` : phone;

const hashSmsCode = (phone, code) =>
  crypto.createHash('sha256').update(`${phone}:${code}`).digest('hex');

const buildMerchantUserPayload = (user) => ({
  id: user.id,
  username: user.username,
  displayName: user.displayName,
  salonId: user.salonId,
  role: user.role,
});

const buildAdminUserPayload = (user) => ({
  id: user.id,
  username: user.username,
  displayName: user.displayName,
  role: user.role,
});

const buildClientUserPayload = (user) => ({
  id: user.id,
  account: user.account,
  displayName: user.displayName,
  gender: user.gender || '保密',
  avatarUrl: user.avatarUrl || '',
  phone: user.phone || user.account,
});

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
      userId: clientUser.id,
      userName: clientUser.displayName || clientUser.account,
    };
  }

  return {
    userId: req.body?.userId || req.query?.userId || 'demo-user',
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
const imageUrl = 'http://localhost:3000/images/云南/1/IMG_1310.JPG';

const salons = [
  {
    id: '1',
    name: 'Modern Cut Studio',
    address: 'Tokyo, Shibuya',
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

const getAllSalons = async () => {
  const salonList = await Salon.find({ publishStatus: 'online' }).lean();
  return salonList.sort((a, b) => Number(a.id) - Number(b.id));
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
  if (!person || !Array.isArray(person.reviews) || person.reviews.length === 0) {
    return 5;
  }

  const total = person.reviews.reduce((sum, review) => sum + Number(review.rating || 0), 0);
  return Number((total / person.reviews.length).toFixed(1));
};

const buildStaffPayload = (person) => ({
  ...person,
  rating: calculateStaffRating(person),
});

const buildSalonImageList = (salon) => {
  const images = [
    ...(Array.isArray(salon?.promoImages) ? salon.promoImages : []),
    ...(Array.isArray(salon?.images) ? salon.images : []),
  ];

  return [...new Set(images.filter(image => typeof image === 'string' && image.trim()))]
    .slice(0, 20);
};

const buildSalonDetail = async (salonDocument) => {
  const salon = normalizeDocument(salonDocument);
  const staffMap = await getStaffMapByIds(salon.staffIds);
  return {
    ...salon,
    staff: salon.staffIds.map(id => staffMap[id]).filter(Boolean).map(buildStaffPayload),
  };
};

const buildMerchantSalonPayload = async (salonId = '1') => {
  const salon = await Salon.findOne({ id: salonId });
  return buildSalonDetail(salon);
};

const ensureSalonForMerchant = async ({ salonId, displayName }) => {
  const normalizedSalonId = String(salonId || '').trim() || `salon-${Date.now()}`;
  const existingSalon = await Salon.findOne({ id: normalizedSalonId });
  if (existingSalon) return existingSalon;

  return Salon.create({
    id: normalizedSalonId,
    name: displayName || `商家店铺 ${normalizedSalonId}`,
    address: '',
    addressRegion: {},
    addressDetail: '',
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

const readFavoriteSalons = async (userId = 'demo-user') => {
  const favorites = await FavoriteSalon
    .find({ userId })
    .sort({ createdAt: -1 })
    .lean();
  return favorites.map(favorite => favorite.salon);
};

const migrateFavoriteSalonsFromFile = async () => {
  const existingCount = await FavoriteSalon.countDocuments({ userId: 'demo-user' });
  if (existingCount > 0) return;

  const favorites = readFavoriteSalonsFromFile();
  if (favorites.length === 0) return;

  await FavoriteSalon.insertMany(
    favorites
      .filter(salon => salon?.id)
      .map(salon => ({
        userId: 'demo-user',
        salonId: salon.id.toString(),
        salon,
      })),
    { ordered: false },
  ).catch(() => {});
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

  const merchantUsers = await MerchantUser.find({}).lean();
  await Promise.all(merchantUsers.map(user =>
    ensureSalonForMerchant({ salonId: user.salonId, displayName: user.displayName })
  ));
  await Promise.all(merchantUsers.map(async (user) => {
    if (user.username === 'merchant') return;
    const salon = await Salon.findOne({ id: user.salonId });
    if (!salon || !legacyMockSalonNames.has(salon.name)) return;

    salon.name = user.displayName || `${user.username} 店铺`;
    salon.address = '';
    salon.addressRegion = {};
    salon.addressDetail = '';
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
      id: 'user-demo',
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

app.get('/api/salons', async (req, res) => {
  const salonList = await getAllSalons();
  res.json(salonList.map(s => {
    const { fullDescription, openingHours, phone, staffIds, services, staff, reviews, _id, __v, createdAt, updatedAt, ...basic } = s;
    return {
      ...basic,
      images: buildSalonImageList(s),
    };
  }));
});

app.get('/api/salons/:id', async (req, res) => {
  const salon = await Salon.findOne({ id: req.params.id, publishStatus: 'online' });
  if (!salon) return res.status(404).json({ message: 'Salon not found' });

  res.json(await buildSalonDetail(salon));
});

app.get('/api/favorites', async (req, res) => {
  const { userId } = await resolveRequestUser(req);
  res.json(await readFavoriteSalons(userId));
});

app.post('/api/favorites/toggle', async (req, res) => {
  const { userId } = await resolveRequestUser(req);
  const salonId = req.body?.id?.toString();
  if (!salonId) return res.status(400).json({ message: 'Salon id is required' });

  const existingFavorite = await FavoriteSalon.findOne({ userId, salonId });

  if (existingFavorite) {
    await existingFavorite.deleteOne();
  } else {
    await FavoriteSalon.create({
      userId,
      salonId,
      salon: req.body,
    });
  }

  res.json(await readFavoriteSalons(userId));
});

app.post('/api/auth/sms/request', async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  if (!isValidPhone(phone)) {
    return res.status(400).json({ message: '请输入有效的手机号' });
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  await SmsVerification.create({
    phone,
    codeHash: hashSmsCode(phone, code),
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
  });

  res.json({
    message: '验证码已发送',
    expiresInSeconds: 300,
    debugCode: code,
  });
});

app.post('/api/auth/sms/verify', async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const code = String(req.body.code || '').trim();
  if (!isValidPhone(phone) || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ message: '手机号或验证码格式不正确' });
  }

  const verification = await SmsVerification.findOne({
    phone,
    codeHash: hashSmsCode(phone, code),
    consumedAt: { $exists: false },
    expiresAt: { $gt: new Date() },
  }).sort({ createdAt: -1 });

  if (!verification) {
    return res.status(401).json({ message: '验证码错误或已过期' });
  }

  verification.consumedAt = new Date();
  await verification.save();

  let user = await ClientUser.findOne({ account: phone });
  if (!user) {
    const password = crypto.randomBytes(16).toString('hex');
    const { salt, hash } = hashPassword(password);
    user = await ClientUser.create({
      id: `user-${Date.now()}`,
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

  res.json({
    token: user.sessionToken,
    user: buildClientUserPayload(user),
  });
});

app.post('/api/auth/register', async (req, res) => {
  const account = String(req.body.account || '').trim();
  const password = String(req.body.password || '');
  const displayName = String(req.body.displayName || '').trim();

  if (!account || !password || !displayName) {
    return res.status(400).json({ message: 'account, password and displayName are required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ message: '密码至少 6 位' });
  }

  const existingUser = await ClientUser.findOne({ account });
  if (existingUser) return res.status(409).json({ message: '该账号已注册' });

  const { salt, hash } = hashPassword(password);
  const user = await ClientUser.create({
    id: `user-${Date.now()}`,
    account,
    displayName,
    passwordSalt: salt,
    passwordHash: hash,
    sessionToken: crypto.randomBytes(32).toString('hex'),
    lastLoginAt: new Date(),
  });

  res.status(201).json({
    token: user.sessionToken,
    user: buildClientUserPayload(user),
  });
});

app.post('/api/auth/login', async (req, res) => {
  const account = String(req.body.account || '').trim();
  const password = String(req.body.password || '');

  if (!account || !password) {
    return res.status(400).json({ message: 'account and password are required' });
  }

  const user = await ClientUser.findOne({ account });
  if (!user) return res.status(401).json({ message: '账号或密码错误' });

  const { hash } = hashPassword(password, user.passwordSalt);
  if (hash !== user.passwordHash) {
    return res.status(401).json({ message: '账号或密码错误' });
  }

  user.sessionToken = crypto.randomBytes(32).toString('hex');
  user.lastLoginAt = new Date();
  await user.save();

  res.json({
    token: user.sessionToken,
    user: buildClientUserPayload(user),
  });
});

app.get('/api/auth/me', requireClientAuth, async (req, res) => {
  res.json({ user: buildClientUserPayload(req.clientUser) });
});

app.patch('/api/auth/profile', requireClientAuth, async (req, res) => {
  const displayName = String(req.body.displayName || '').trim();
  const gender = String(req.body.gender || '保密').trim();
  const phone = normalizePhone(req.body.phone || req.clientUser.phone || req.clientUser.account);
  const avatarUrl = String(req.body.avatarUrl || '').trim();
  const allowedGenders = new Set(['男', '女', '其他', '保密']);

  if (!displayName) {
    return res.status(400).json({ message: '请输入昵称' });
  }
  if (!isValidPhone(phone)) {
    return res.status(400).json({ message: '请输入有效的手机号' });
  }

  const existingUser = await ClientUser.findOne({
    account: phone,
    id: { $ne: req.clientUser.id },
  });
  if (existingUser) {
    return res.status(409).json({ message: '该手机号已被使用' });
  }

  const user = await ClientUser.findOne({ id: req.clientUser.id });
  if (!user) {
    return res.status(404).json({ message: '用户不存在' });
  }

  user.displayName = displayName;
  user.gender = allowedGenders.has(gender) ? gender : '保密';
  user.phone = phone;
  user.account = phone;
  user.avatarUrl = avatarUrl;
  await user.save();

  res.json({
    token: user.sessionToken,
    user: buildClientUserPayload(user),
  });
});

app.post('/api/merchant/auth/login', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');

  if (!username || !password) {
    return res.status(400).json({ message: 'username and password are required' });
  }

  const user = await MerchantUser.findOne({ username });
  if (!user) return res.status(401).json({ message: '账号或密码错误' });

  const { hash } = hashPassword(password, user.passwordSalt);
  if (hash !== user.passwordHash) {
    return res.status(401).json({ message: '账号或密码错误' });
  }

  user.sessionToken = crypto.randomBytes(32).toString('hex');
  user.lastLoginAt = new Date();
  await user.save();

  res.json({
    token: user.sessionToken,
    user: buildMerchantUserPayload(user),
  });
});

app.get('/api/merchant/auth/me', requireMerchantAuth, async (req, res) => {
  res.json({ user: buildMerchantUserPayload(req.merchantUser) });
});

app.post('/api/admin/auth/login', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');

  if (!username || !password) {
    return res.status(400).json({ message: 'username and password are required' });
  }

  const user = await AdminUser.findOne({ username });
  if (!user) return res.status(401).json({ message: '账号或密码错误' });

  const { hash } = hashPassword(password, user.passwordSalt);
  if (hash !== user.passwordHash) {
    return res.status(401).json({ message: '账号或密码错误' });
  }

  user.sessionToken = crypto.randomBytes(32).toString('hex');
  user.lastLoginAt = new Date();
  await user.save();

  res.json({
    token: user.sessionToken,
    user: buildAdminUserPayload(user),
  });
});

app.get('/api/admin/auth/me', requireAdminAuth, async (req, res) => {
  res.json({ user: buildAdminUserPayload(req.adminUser) });
});

app.get('/api/admin/overview', requireAdminAuth, async (req, res) => {
  const [merchantCount, clientCount, salonCount, bookingCount, pendingCount, acceptedCount] = await Promise.all([
    MerchantUser.countDocuments(),
    ClientUser.countDocuments(),
    Salon.countDocuments(),
    Booking.countDocuments(),
    Booking.countDocuments({ status: 'pending' }),
    Booking.countDocuments({ status: 'accepted' }),
  ]);

  res.json({
    merchantCount,
    clientCount,
    salonCount,
    bookingCount,
    pendingCount,
    acceptedCount,
  });
});

app.get('/api/admin/merchants', requireAdminAuth, async (req, res) => {
  const merchants = await MerchantUser
    .find({})
    .sort({ createdAt: -1 })
    .lean();
  const salonsById = Object.fromEntries(
    (await Salon.find({ id: { $in: merchants.map(user => user.salonId) } }).lean())
      .map(salon => [salon.id, salon]),
  );

  res.json(merchants.map(user => ({
    ...buildMerchantUserPayload(user),
    salonName: salonsById[user.salonId]?.name || '',
    publishStatus: salonsById[user.salonId]?.publishStatus || 'offline',
    licenseUrl: salonsById[user.salonId]?.licenseUrl || '',
    licenseStatus: salonsById[user.salonId]?.licenseStatus || 'unsubmitted',
    licenseRejectReason: salonsById[user.salonId]?.licenseRejectReason || '',
    licenseSubmittedAt: salonsById[user.salonId]?.licenseSubmittedAt,
    licenseReviewedAt: salonsById[user.salonId]?.licenseReviewedAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt,
  })));
});

app.post('/api/admin/merchants', requireAdminAuth, async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const displayName = String(req.body.displayName || '').trim();
  const salonId = String(req.body.salonId || '1').trim();

  if (!username || !password || !displayName) {
    return res.status(400).json({ message: 'username, password and displayName are required' });
  }
  if (password.length < 6) return res.status(400).json({ message: '密码至少 6 位' });
  if (await MerchantUser.findOne({ username })) {
    return res.status(409).json({ message: '该商家账号已存在' });
  }

  const salon = await ensureSalonForMerchant({ salonId, displayName });
  const { salt, hash } = hashPassword(password);
  const user = await MerchantUser.create({
    id: `merchant-${Date.now()}`,
    username,
    displayName,
    salonId: salon.id,
    role: 'merchant',
    passwordSalt: salt,
    passwordHash: hash,
  });

  res.status(201).json({ user: buildMerchantUserPayload(user) });
});

app.patch('/api/admin/merchants/:id', requireAdminAuth, async (req, res) => {
  const user = await MerchantUser.findOne({ id: req.params.id });
  if (!user) return res.status(404).json({ message: 'Merchant user not found' });

  const username = String(req.body.username || '').trim();
  const displayName = String(req.body.displayName || '').trim();
  const salonId = String(req.body.salonId || '').trim();
  const password = String(req.body.password || '');

  if (username && username !== user.username) {
    if (await MerchantUser.findOne({ username })) {
      return res.status(409).json({ message: '该商家账号已存在' });
    }
    user.username = username;
  }
  if (displayName) user.displayName = displayName;
  if (salonId) {
    const salon = await ensureSalonForMerchant({
      salonId,
      displayName: displayName || user.displayName,
    });
    user.salonId = salon.id;
  }
  if (password) {
    if (password.length < 6) return res.status(400).json({ message: '密码至少 6 位' });
    const { salt, hash } = hashPassword(password);
    user.passwordSalt = salt;
    user.passwordHash = hash;
    user.sessionToken = '';
  }

  await user.save();
  res.json({ user: buildMerchantUserPayload(user) });
});

app.patch('/api/admin/merchants/:id/license', requireAdminAuth, async (req, res) => {
  const action = String(req.body.action || '').trim();
  const reason = String(req.body.reason || '').trim();
  if (!['approve', 'reject'].includes(action)) {
    return res.status(400).json({ message: 'action must be approve or reject' });
  }

  const user = await MerchantUser.findOne({ id: req.params.id }).lean();
  if (!user) return res.status(404).json({ message: 'Merchant user not found' });
  const salon = await Salon.findOne({ id: user.salonId });
  if (!salon) return res.status(404).json({ message: 'Merchant salon not found' });
  if (!salon.licenseUrl) return res.status(409).json({ message: '营业执照尚未提交' });

  salon.licenseStatus = action === 'approve' ? 'approved' : 'rejected';
  salon.licenseRejectReason = action === 'reject' ? reason : '';
  salon.licenseReviewedAt = new Date();
  await salon.save();

  res.json({
    merchant: {
      ...buildMerchantUserPayload(user),
      salonName: salon.name,
      publishStatus: salon.publishStatus || 'offline',
      licenseUrl: salon.licenseUrl || '',
      licenseStatus: salon.licenseStatus,
      licenseRejectReason: salon.licenseRejectReason || '',
      licenseSubmittedAt: salon.licenseSubmittedAt,
      licenseReviewedAt: salon.licenseReviewedAt,
    },
  });
});

app.patch('/api/admin/merchants/:id/publish', requireAdminAuth, async (req, res) => {
  const action = String(req.body.action || '').trim();
  if (!['online', 'offline'].includes(action)) {
    return res.status(400).json({ message: 'action must be online or offline' });
  }

  const user = await MerchantUser.findOne({ id: req.params.id }).lean();
  if (!user) return res.status(404).json({ message: 'Merchant user not found' });
  const salon = await Salon.findOne({ id: user.salonId });
  if (!salon) return res.status(404).json({ message: 'Merchant salon not found' });
  if (action === 'online' && salon.licenseStatus !== 'approved') {
    return res.status(409).json({ message: '营业执照审核通过后才能上架' });
  }

  salon.publishStatus = action;
  await salon.save();

  res.json({
    merchant: {
      ...buildMerchantUserPayload(user),
      salonName: salon.name,
      publishStatus: salon.publishStatus,
      licenseUrl: salon.licenseUrl || '',
      licenseStatus: salon.licenseStatus || 'unsubmitted',
      licenseRejectReason: salon.licenseRejectReason || '',
      licenseSubmittedAt: salon.licenseSubmittedAt,
      licenseReviewedAt: salon.licenseReviewedAt,
    },
  });
});

app.get('/api/admin/users', requireAdminAuth, async (req, res) => {
  const users = await ClientUser
    .find({})
    .sort({ createdAt: -1 })
    .lean();

  res.json(users.map(user => ({
    ...buildClientUserPayload(user),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt,
  })));
});

app.get('/api/admin/bookings', requireAdminAuth, async (req, res) => {
  const bookings = await Booking.find({}).sort({ createdAt: -1 }).limit(100);
  res.json(bookings.map(normalizeBooking));
});

app.use('/api/merchant', requireMerchantAuth);

app.get('/api/merchant/account', async (req, res) => {
  res.json({ user: buildMerchantUserPayload(req.merchantUser) });
});

app.patch('/api/merchant/account', async (req, res) => {
  const user = await MerchantUser.findOne({ id: req.merchantUser.id });
  if (!user) return res.status(404).json({ message: 'Merchant user not found' });

  const displayName = String(req.body.displayName || '').trim();
  const currentPassword = String(req.body.currentPassword || '');
  const newPassword = String(req.body.newPassword || '');

  if (displayName) user.displayName = displayName;

  if (newPassword) {
    if (newPassword.length < 6) return res.status(400).json({ message: '新密码至少 6 位' });
    const { hash } = hashPassword(currentPassword, user.passwordSalt);
    if (hash !== user.passwordHash) {
      return res.status(401).json({ message: '当前密码错误' });
    }
    const nextPassword = hashPassword(newPassword);
    user.passwordSalt = nextPassword.salt;
    user.passwordHash = nextPassword.hash;
    user.sessionToken = crypto.randomBytes(32).toString('hex');
  }

  await user.save();
  res.json({
    token: user.sessionToken,
    user: buildMerchantUserPayload(user),
  });
});

app.get('/api/merchant/qualification', async (req, res) => {
  const salon = await Salon.findOne({ id: req.merchantUser.salonId || '1' }).lean();
  if (!salon) return res.status(404).json({ message: 'Merchant salon not found' });

  res.json({
    salonId: salon.id,
    salonName: salon.name,
    publishStatus: salon.publishStatus || 'offline',
    licenseUrl: salon.licenseUrl || '',
    licenseStatus: salon.licenseStatus || 'unsubmitted',
    licenseRejectReason: salon.licenseRejectReason || '',
    licenseSubmittedAt: salon.licenseSubmittedAt,
    licenseReviewedAt: salon.licenseReviewedAt,
  });
});

app.patch('/api/merchant/qualification', async (req, res) => {
  const licenseUrl = String(req.body.licenseUrl || '').trim();
  if (!licenseUrl) return res.status(400).json({ message: 'licenseUrl is required' });

  const salon = await Salon.findOne({ id: req.merchantUser.salonId || '1' });
  if (!salon) return res.status(404).json({ message: 'Merchant salon not found' });

  salon.licenseUrl = licenseUrl;
  salon.licenseStatus = 'pending';
  salon.licenseRejectReason = '';
  salon.licenseSubmittedAt = new Date();
  await salon.save();

  res.json({
    salonId: salon.id,
    salonName: salon.name,
    publishStatus: salon.publishStatus || 'offline',
    licenseUrl: salon.licenseUrl || '',
    licenseStatus: salon.licenseStatus || 'pending',
    licenseRejectReason: salon.licenseRejectReason || '',
    licenseSubmittedAt: salon.licenseSubmittedAt,
    licenseReviewedAt: salon.licenseReviewedAt,
  });
});

app.get('/api/merchant/salon', async (req, res) => {
  res.json(await buildMerchantSalonPayload(req.merchantUser.salonId || '1'));
});

app.patch('/api/merchant/salon', async (req, res) => {
  const salon = await Salon.findOne({ id: req.merchantUser.salonId || '1' });
  if (!salon) return res.status(404).json({ message: 'Merchant salon not found' });
  const {
    address,
    addressRegion,
    addressDetail,
    description,
    fullDescription,
    image,
    images,
    promoImages,
    name,
    openingHours,
    phone,
    services,
    staff: staffProfiles,
  } = req.body;

  if (typeof name === 'string') salon.name = name;
  if (typeof address === 'string') salon.address = address;
  if (addressRegion && typeof addressRegion === 'object') {
    salon.addressRegion = addressRegion;
  }
  if (typeof addressDetail === 'string') salon.addressDetail = addressDetail;
  if (typeof description === 'string') salon.description = description;
  if (typeof fullDescription === 'string') salon.fullDescription = fullDescription;
  if (typeof image === 'string') salon.image = image;
  if (Array.isArray(promoImages) || Array.isArray(images)) {
    const incomingImages = Array.isArray(promoImages) ? promoImages : images;
    salon.promoImages = [
      ...new Set(
        incomingImages
          .map(item => item?.toString().trim())
          .filter(Boolean)
      ),
    ].slice(0, 20);
    salon.images = salon.promoImages;
  }
  if (typeof openingHours === 'string') salon.openingHours = openingHours;
  if (typeof phone === 'string') salon.phone = phone;

  if (Array.isArray(services)) {
    salon.services = services
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

  if (Array.isArray(staffProfiles)) {
    const nextStaffIds = [];
    const incomingStaffIds = staffProfiles
      .map((profile, index) => profile?.id || `merchant-staff-${Date.now()}-${index}`)
      .filter(Boolean);
    const existingStaffMap = await getStaffMapByIds(incomingStaffIds);
    const staffUpdates = [];

    staffProfiles
      .filter(profile => profile && profile.name)
      .forEach((profile, index) => {
        const id = profile.id || `merchant-staff-${Date.now()}-${index}`;
        nextStaffIds.push(id);
        const previousStaff = existingStaffMap[id] || {};
        staffUpdates.push({
          id,
          name: profile.name,
          role: profile.role || '',
          experience: profile.experience || '',
          extraServiceFee: Number(profile.extraServiceFee || 0),
          imageUrl: profile.imageUrl || '',
          bio: profile.bio || '',
          unavailableSlots: normalizeUnavailableSlots(profile.unavailableSlots),
          rating: Number(profile.rating || previousStaff.rating || 4.8),
          reviews: Array.isArray(profile.reviews)
            ? profile.reviews
            : previousStaff.reviews || [],
        });
      });
    salon.staffIds = nextStaffIds;
    await Promise.all(staffUpdates.map(profile =>
      StaffProfile.findOneAndUpdate(
        { id: profile.id },
        profile,
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
    ));
  }

  await salon.save();
  res.json(await buildMerchantSalonPayload(req.merchantUser.salonId || '1'));
});

app.post('/api/merchant/uploads', (req, res) => {
  const { data, fileName = 'avatar.png' } = req.body;
  if (typeof data !== 'string' || data.length === 0) {
    return res.status(400).json({ message: 'Image data is required' });
  }

  const extension = path.extname(fileName).toLowerCase() || '.png';
  const safeExtension = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(extension)
    ? extension
    : '.png';
  const uploadName = `staff-${Date.now()}-${Math.random().toString(36).slice(2)}${safeExtension}`;
  const base64 = data.includes(',') ? data.split(',').pop() : data;
  const buffer = Buffer.from(base64, 'base64');

  fs.writeFileSync(path.join(uploadDir, uploadName), buffer);
  res.status(201).json({ url: `http://localhost:${PORT}/uploads/${uploadName}` });
});

app.get('/api/staff/:id', async (req, res) => {
  const person = await getStaffById(req.params.id).lean();
  if (!person) return res.status(404).json({ message: 'Staff not found' });
  const salon = await getSalonByStaffId(req.params.id).lean();
  const staffMap = salon ? await getStaffMapByIds(salon.staffIds) : {};
  res.json({
    ...buildStaffPayload(person),
    salonServices: salon?.services || [],
    salonStaff: salon ? salon.staffIds.map(id => staffMap[id]).filter(Boolean).map(buildStaffPayload) : [],
  });
});

app.get('/api/staff/:id/slots', async (req, res) => {
  const staffId = req.params.id;
  const date = req.query.date || '2026-06-01';
  const candidateStaffIds = String(req.query.candidateStaffIds || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);
  const slots = staffId === '__no_preference__' && candidateStaffIds.length > 0
    ? await generateSlotsForNoPreferenceAndDate(candidateStaffIds, date)
    : await generateSlotsForStaffAndDate(staffId, date);
  res.json(slots);
});

app.get('/api/bookings', async (req, res) => {
  const { userId, staffId, status } = req.query;
  const requestUser = await resolveRequestUser(req);
  const query = {};
  if (userId) {
    query.userId = userId;
  } else if (requestUser.userId !== 'demo-user') {
    query.userId = requestUser.userId;
  }
  if (staffId) query.staffId = staffId;
  if (status) query.status = status;
  const result = await Booking.find(query).sort({ createdAt: -1 });
  res.json(result.map(normalizeBooking));
});

app.patch('/api/bookings/:id/cancel', async (req, res) => {
  const { userId } = await resolveRequestUser(req);
  const booking = await Booking.findOne({ id: req.params.id, userId });
  if (!booking) return res.status(404).json({ message: 'Booking not found' });
  if (!['pending', 'accepted'].includes(booking.status)) {
    return res.status(409).json({ message: 'Only pending or accepted bookings can be canceled by user' });
  }
  if (
    booking.status === 'accepted' &&
    new Date(booking.startTime).getTime() - Date.now() < USER_CANCEL_WINDOW_MS
  ) {
    return res.status(409).json({
      message: '预约开始前3小时内不能直接取消，请电话联系商家协商取消。直接爽约3次账号将被拉黑。',
    });
  }

  booking.status = 'canceled';
  booking.updatedAt = new Date().toISOString();
  booking.merchantMessage = '用户已取消该预约。';
  booking.userMessage = '您已取消本次预约。';
  booking.rejectReason = '';
  await booking.save();
  broadcastBookingEvent('booking.updated', booking);

  res.json({
    message: 'Booking canceled.',
    booking: normalizeBooking(booking),
  });
});

app.post('/api/bookings/:id/review', async (req, res) => {
  const booking = await Booking.findOne({ id: req.params.id });
  if (!booking) return res.status(404).json({ message: 'Booking not found' });
  if (booking.status !== 'completed') {
    return res.status(409).json({ message: 'Only completed bookings can be reviewed' });
  }
  if (booking.reviewed) {
    return res.status(409).json({ message: 'Booking already reviewed' });
  }

  const rating = Number(req.body.rating);
  const comment = String(req.body.comment || '').trim();
  const images = Array.isArray(req.body.images) ? req.body.images.slice(0, 5) : [];

  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ message: 'rating must be an integer from 1 to 5' });
  }
  if (!comment) {
    return res.status(400).json({ message: 'comment is required' });
  }

  const imageUrls = images
    .map((image, index) => {
      if (!image || typeof image.data !== 'string') return null;
      const extension = path.extname(image.fileName || '').toLowerCase() || '.png';
      const safeExtension = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(extension)
        ? extension
        : '.png';
      const imageName = `review-${Date.now()}-${index}-${Math.random().toString(36).slice(2)}${safeExtension}`;
      const base64 = image.data.includes(',') ? image.data.split(',').pop() : image.data;
      fs.writeFileSync(path.join(uploadDir, imageName), Buffer.from(base64, 'base64'));
      return `http://localhost:${PORT}/uploads/${imageName}`;
    })
    .filter(Boolean);

  const review = {
    id: 'RV' + Date.now(),
    bookingId: booking.id,
    userName: booking.userName,
    user: booking.userName,
    rating,
    comment,
    date: new Date().toISOString().slice(0, 10),
    serviceName: booking.serviceName,
    imageUrls,
  };

  const staffMember = await getStaffById(booking.staffId);
  if (!staffMember) return res.status(404).json({ message: 'Staff not found' });

  staffMember.reviews = [review, ...(staffMember.reviews || [])];
  staffMember.rating = calculateStaffRating(staffMember);
  await staffMember.save();
  booking.reviewed = true;
  booking.review = review;
  booking.updatedAt = new Date().toISOString();
  await booking.save();

  broadcastBookingEvent('booking.updated', booking);
  res.status(201).json({ review, booking: normalizeBooking(booking) });
});

app.post('/api/bookings/:id/complaint', async (req, res) => {
  const booking = await Booking.findOne({ id: req.params.id });
  if (!booking) return res.status(404).json({ message: 'Booking not found' });
  if (booking.status !== 'completed') {
    return res.status(409).json({ message: 'Only completed bookings can be complained' });
  }
  if (booking.complained) {
    return res.status(409).json({ message: 'Booking already complained' });
  }

  const description = String(req.body.description || '').trim();
  const images = Array.isArray(req.body.images) ? req.body.images.slice(0, 5) : [];

  if (!description) {
    return res.status(400).json({ message: 'description is required' });
  }

  const imageUrls = images
    .map((image, index) => {
      if (!image || typeof image.data !== 'string') return null;
      const extension = path.extname(image.fileName || '').toLowerCase() || '.png';
      const safeExtension = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(extension)
        ? extension
        : '.png';
      const imageName = `complaint-${Date.now()}-${index}-${Math.random().toString(36).slice(2)}${safeExtension}`;
      const base64 = image.data.includes(',') ? image.data.split(',').pop() : image.data;
      fs.writeFileSync(path.join(uploadDir, imageName), Buffer.from(base64, 'base64'));
      return `http://localhost:${PORT}/uploads/${imageName}`;
    })
    .filter(Boolean);

  const complaint = {
    id: 'CP' + Date.now(),
    bookingId: booking.id,
    userId: booking.userId,
    userName: booking.userName,
    salonId: booking.salonId,
    salonName: booking.salonName,
    staffId: booking.staffId,
    staffName: booking.staffName,
    serviceName: booking.serviceName,
    description,
    imageUrls,
    date: new Date().toISOString().slice(0, 10),
    createdAt: new Date().toISOString(),
    status: 'submitted',
  };

  booking.complained = true;
  booking.complaint = complaint;
  booking.updatedAt = new Date().toISOString();
  await booking.save();

  broadcastBookingEvent('booking.updated', booking);
  res.status(201).json({ complaint, booking: normalizeBooking(booking) });
});

app.post('/api/bookings', async (req, res) => {
  const {
    staffId,
    serviceId,
    startTime,
    candidateStaffIds = [],
    note = '',
  } = req.body;
  const { userId, userName } = await resolveRequestUser(req);

  if (!staffId || !serviceId || !startTime) {
    return res.status(400).json({ message: 'staffId, serviceId and startTime are required' });
  }

  const requestedStartTime = new Date(startTime);
  if (Number.isNaN(requestedStartTime.getTime())) {
    return res.status(400).json({ message: 'startTime must be a valid date time' });
  }
  if (requestedStartTime.getTime() <= Date.now()) {
    return res.status(409).json({ message: 'Only future time slots can be booked' });
  }

  const userPolicy = await getUserPolicy(userId);
  if (userPolicy.isBlacklisted) {
    return res.status(403).json({ message: '该账号已因爽约次数过多被拉黑，无法继续预约。' });
  }

  const isNoPreference = staffId === '__no_preference__';
  const requestedCandidateStaffIds = Array.isArray(candidateStaffIds)
    ? candidateStaffIds.map(id => String(id || '').trim()).filter(Boolean)
    : [];
  const bookingStaffId = isNoPreference ? requestedCandidateStaffIds[0] : staffId;
  if (!bookingStaffId) {
    return res.status(400).json({ message: 'candidateStaffIds are required when staff is not specified' });
  }

  let staffMember = await getStaffById(bookingStaffId).lean();
  const service = await getServiceById(serviceId);
  const salon = await getSalonByStaffId(bookingStaffId).lean();

  if (!staffMember || !service || !salon) {
    return res.status(404).json({ message: 'Staff, service or salon not found' });
  }

  const { start: openingStart, end: openingEnd } = parseOpeningHours(salon.openingHours);
  const requestedMinutes = requestedStartTime.getHours() * 60 + requestedStartTime.getMinutes();
  if (requestedMinutes < openingStart || requestedMinutes > openingEnd) {
    return res.status(409).json({ message: 'This time is outside salon opening hours' });
  }

  let assignedStaffId = bookingStaffId;
  if (isNoPreference) {
    assignedStaffId = null;
    for (const candidateStaffId of requestedCandidateStaffIds) {
      const hasCandidateConflict = await findActiveBookingAtTime(candidateStaffId, startTime);
      const isCandidateUnavailable = await isStaffUnavailable(candidateStaffId, startTime);
      if (!hasCandidateConflict && !isCandidateUnavailable) {
        assignedStaffId = candidateStaffId;
        staffMember = await getStaffById(candidateStaffId).lean();
        break;
      }
    }
    if (!assignedStaffId || !staffMember) {
      return res.status(409).json({ message: 'No staff member is available at the selected time' });
    }
  }

  const hasConflict = await findActiveBookingAtTime(assignedStaffId, startTime);

  if (hasConflict) {
    return res.status(409).json({ message: 'This slot already has a pending or accepted booking' });
  }

  if (await isStaffUnavailable(assignedStaffId, startTime)) {
    return res.status(409).json({ message: 'This staff member is unavailable at the selected time' });
  }

  const now = new Date().toISOString();
  const serviceBasePrice = parsePriceValue(service.price);
  const staffExtraServiceFee = isNoPreference ? 0 : Number(staffMember.extraServiceFee || 0);
  const totalPrice = serviceBasePrice + staffExtraServiceFee;
  const booking = await Booking.create({
    id: 'BK' + Date.now(),
    userId,
    userName,
    salonId: salon.id,
    salonName: salon.name,
    staffId: assignedStaffId,
    staffName: isNoPreference ? '无需指定' : staffMember.name,
    serviceId,
    serviceName: service.name,
    servicePrice: service.price,
    serviceDuration: service.duration,
    serviceBasePrice,
    staffExtraServiceFee,
    totalPrice,
    startTime,
    note,
    status: 'pending',
    merchantMessage: '您有一条新的预约申请，请及时处理。',
    userMessage: '预约申请已提交，正在等待商家确认。',
    createdAt: now,
    updatedAt: now,
  });

  broadcastBookingEvent('booking.created', booking);
  res.status(201).json({
    message: 'Booking request submitted and waiting for merchant confirmation.',
    booking: normalizeBooking(booking),
  });
});

app.patch('/api/merchant/bookings/:id', async (req, res) => {
  const { action, reason = '', assignedStaffId = '' } = req.body;
  const booking = await Booking.findOne({ id: req.params.id });
  if (!booking) return res.status(404).json({ message: 'Booking not found' });
  if (!['accept', 'cancel', 'complete', 'no_show', 'reject'].includes(action)) {
    return res.status(400).json({ message: 'action must be accept, cancel, complete, no_show or reject' });
  }
  if (['accept', 'reject'].includes(action) && booking.status !== 'pending') {
    return res.status(409).json({ message: 'Only pending bookings can be accepted or rejected' });
  }
  if (['cancel', 'complete', 'no_show'].includes(action) && booking.status !== 'accepted') {
    return res.status(409).json({ message: 'Only accepted bookings can be canceled, completed or marked no-show' });
  }

  if (action === 'accept' && booking.staffName === '无需指定') {
    const selectedStaffId = String(assignedStaffId || '').trim();
    if (!selectedStaffId) {
      return res.status(400).json({ message: '无需指定理发师的订单接单前必须指定一位理发师' });
    }

    const selectedStaff = await getStaffById(selectedStaffId).lean();
    const selectedSalon = selectedStaff ? await getSalonByStaffId(selectedStaffId).lean() : null;
    if (!selectedStaff || !selectedSalon || selectedSalon.id !== booking.salonId) {
      return res.status(404).json({ message: '指定的理发师不属于该店铺' });
    }

    const hasConflict = await findActiveBookingAtTimeExcluding(
      selectedStaffId,
      booking.startTime,
      booking.id,
    );
    if (hasConflict) {
      return res.status(409).json({ message: '指定理发师在该时间段已有预约' });
    }
    if (await isStaffUnavailable(selectedStaffId, booking.startTime.toISOString())) {
      return res.status(409).json({ message: '指定理发师在该时间段不可预约' });
    }

    booking.staffId = selectedStaffId;
    booking.staffName = selectedStaff.name;
  }

  booking.status = {
    accept: 'accepted',
    cancel: 'canceled',
    complete: 'completed',
    no_show: 'no_show',
    reject: 'rejected',
  }[action];
  booking.updatedAt = new Date().toISOString();
  booking.merchantMessage = {
    accept: '您已接单。',
    cancel: '您已取消该预约。',
    complete: '订单已完成。',
    no_show: '您已将该预约标记为爽约。',
    reject: '您已拒单。',
  }[action];
  booking.userMessage = {
    accept: '商家已确认，预约成功！',
    cancel: `商家已取消本次预约${reason ? `：${reason}` : '。'}`,
    complete: '本次预约已完成，感谢到店。',
    no_show: '商家已将本次预约标记为爽约。直接爽约3次账号将被拉黑。',
    reject: `商家已拒绝本次预约${reason ? `：${reason}` : '。'}`,
  }[action];
  booking.rejectReason = ['cancel', 'no_show', 'reject'].includes(action) ? reason : '';
  const userPolicy = action === 'no_show' ? await incrementNoShowCount(booking.userId) : null;
  await booking.save();
  broadcastBookingEvent('booking.updated', booking);

  res.json({
    message: `Booking ${booking.status}.`,
    booking: normalizeBooking(booking),
    userPolicy,
  });
});

app.patch('/api/merchant/bookings/:id/review-reply', async (req, res) => {
  const reply = String(req.body.reply || '').trim();
  if (!reply) return res.status(400).json({ message: 'reply is required' });

  const booking = await Booking.findOne({ id: req.params.id });
  if (!booking) return res.status(404).json({ message: 'Booking not found' });
  if (!booking.reviewed || !booking.review) {
    return res.status(409).json({ message: 'Booking has no review' });
  }

  const replyPayload = {
    content: reply,
    repliedAt: new Date().toISOString(),
  };
  booking.review = {
    ...(booking.review || {}),
    merchantReply: replyPayload,
  };
  booking.markModified('review');
  booking.updatedAt = new Date().toISOString();

  const staffMember = await getStaffById(booking.staffId);
  if (staffMember && Array.isArray(staffMember.reviews)) {
    staffMember.reviews = staffMember.reviews.map(review => {
      if (review?.bookingId !== booking.id && review?.id !== booking.review?.id) return review;
      return {
        ...review,
        merchantReply: replyPayload,
      };
    });
    staffMember.markModified('reviews');
    await staffMember.save();
  }

  await booking.save();
  broadcastBookingEvent('booking.updated', booking);
  res.json({ booking: normalizeBooking(booking) });
});

app.get('/api/merchant/bookings', async (req, res) => {
  const { status } = req.query;
  const query = status ? { status } : {};
  const result = await Booking.find(query).sort({ createdAt: -1 });
  res.json(result.map(normalizeBooking));
});

const startServer = async () => {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error('MONGODB_URI is missing. Add it to .env before starting the backend.');
  }

  await mongoose.connect(mongoUri);
  await migrateSeedDataToMongo();
  await migrateFavoriteSalonsFromFile();
  console.log('MongoDB connected');

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Mock Backend running at http://localhost:${PORT}`);
  });
};

startServer().catch((error) => {
  console.error('Failed to start backend:', error.message);
  process.exit(1);
});
