const mongoose = require('mongoose');
const { DEMO_USER_ID } = require('./config');

const bookingSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  userId: { type: String, default: DEMO_USER_ID },
  userName: { type: String, default: 'Demo 用户' },
  salonId: String,
  salonName: String,
  // No-preference bookings stay unassigned until the merchant accepts them.
  staffId: { type: String, default: '' },
  staffName: String,
  isNoPreference: { type: Boolean, default: false },
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
  canceledBy: { type: String, default: '' },
  reviewed: { type: Boolean, default: false },
  review: mongoose.Schema.Types.Mixed,
  complained: { type: Boolean, default: false },
  complaint: mongoose.Schema.Types.Mixed,
  createdAt: Date,
  updatedAt: Date,
}, { id: false });

bookingSchema.index({ staffId: 1, startTime: 1, status: 1 });
bookingSchema.index({ salonId: 1, createdAt: -1 });
bookingSchema.index({ salonId: 1, status: 1, createdAt: -1 });
bookingSchema.index({ userId: 1, createdAt: -1 });
bookingSchema.index({ userId: 1, status: 1, createdAt: -1 });
bookingSchema.index({ createdAt: -1 });
bookingSchema.index({ 'review.reviewStatus': 1, updatedAt: -1 });
bookingSchema.index({ 'complaint.reviewStatus': 1, updatedAt: -1 });

const slotOccupancySchema = new mongoose.Schema({
  staffId: { type: String, required: true },
  startTime: { type: Date, required: true },
  bookingId: { type: String, required: true, unique: true },
}, { timestamps: true });

slotOccupancySchema.index({ staffId: 1, startTime: 1 }, { unique: true });

const userPolicySchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true, index: true },
  noShowCount: { type: Number, default: 0 },
  isBlacklisted: { type: Boolean, default: false },
  updatedAt: Date,
}, { timestamps: true });

const favoriteSalonSchema = new mongoose.Schema({
  userId: { type: String, default: DEMO_USER_ID, index: true },
  salonId: { type: String, required: true, index: true },
}, { timestamps: true });

favoriteSalonSchema.index({ userId: 1, salonId: 1 }, { unique: true });

const salonSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  name: String,
  address: String,
  addressRegion: mongoose.Schema.Types.Mixed,
  addressDetail: String,
  location: mongoose.Schema.Types.Mixed,
  geoLocation: {
    type: { type: String, enum: ['Point'] },
    coordinates: [Number],
  },
  rating: Number,
  image: String,
  images: [String],
  promoImages: [String],
  description: String,
  fullDescription: String,
  openingHours: String,
  acceptsSameDayBooking: { type: Boolean, default: true },
  closedDates: [String],
  phone: String,
  staffIds: [String],
  services: [mongoose.Schema.Types.Mixed],
  publishStatus: { type: String, default: 'online', index: true },
  licenseUrl: { type: String, default: '' },
  legalPersonIdFrontUrl: { type: String, default: '' },
  legalPersonIdBackUrl: { type: String, default: '' },
  addressProofUrl: { type: String, default: '' },
  licenseStatus: { type: String, default: 'unsubmitted', index: true },
  licenseRejectReason: { type: String, default: '' },
  licenseSubmittedAt: Date,
  licenseReviewedAt: Date,
  contentReviewStatus: { type: String, default: 'pending', index: true },
  contentRejectReason: { type: String, default: '' },
  contentReviewedAt: Date,
  pendingContent: mongoose.Schema.Types.Mixed,
}, { timestamps: true });

salonSchema.index({ geoLocation: '2dsphere', publishStatus: 1 });
salonSchema.index({ staffIds: 1 });
salonSchema.index({ 'services.id': 1 });

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
  deposit: { type: Number, default: 0 },
  role: { type: String, default: 'merchant' },
  passwordHash: { type: String, required: true },
  passwordSalt: { type: String, required: true },
  sessionTokenHash: { type: String, default: '', index: true },
  sessionExpiresAt: Date,
  lastLoginAt: Date,
}, { timestamps: true });

merchantUserSchema.index({ createdAt: -1 });

const adminUserSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  username: { type: String, required: true, unique: true, index: true },
  displayName: String,
  role: { type: String, default: 'admin' },
  passwordHash: { type: String, required: true },
  passwordSalt: { type: String, required: true },
  sessionTokenHash: { type: String, default: '', index: true },
  sessionExpiresAt: Date,
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
  sessionTokenHash: { type: String, default: '', index: true },
  sessionExpiresAt: Date,
  lastLoginAt: Date,
}, { timestamps: true });

clientUserSchema.index({ createdAt: -1 });

const smsVerificationSchema = new mongoose.Schema({
  phone: { type: String, required: true, index: true },
  codeHash: { type: String, required: true },
  expiresAt: { type: Date, required: true, index: true },
  consumedAt: Date,
}, { timestamps: true });

smsVerificationSchema.index({ phone: 1, codeHash: 1, expiresAt: -1 });

const adConfigSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, default: 'main' },
  imageUrl: { type: String, default: '' },
  link: { type: String, default: '/pages/ad/ad' },
  enabled: { type: Boolean, default: true },
}, { timestamps: true });

module.exports = {
  Booking: mongoose.model('Booking', bookingSchema),
  SlotOccupancy: mongoose.model('SlotOccupancy', slotOccupancySchema),
  UserPolicy: mongoose.model('UserPolicy', userPolicySchema),
  FavoriteSalon: mongoose.model('FavoriteSalon', favoriteSalonSchema),
  Salon: mongoose.model('Salon', salonSchema),
  StaffProfile: mongoose.model('StaffProfile', staffProfileSchema),
  MerchantUser: mongoose.model('MerchantUser', merchantUserSchema),
  AdminUser: mongoose.model('AdminUser', adminUserSchema),
  ClientUser: mongoose.model('ClientUser', clientUserSchema),
  SmsVerification: mongoose.model('SmsVerification', smsVerificationSchema),
  AdConfig: mongoose.model('AdConfig', adConfigSchema),
};
