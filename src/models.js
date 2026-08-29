const mongoose = require('mongoose');
const { DEMO_USER_ID } = require('./config');

const integer = (minimum = 0) => ({
  type: Number,
  min: minimum,
  validate: Number.isSafeInteger,
});

const locationSchema = new mongoose.Schema({
  latitude: Number,
  longitude: Number,
}, { _id: false });

const addressRegionSchema = new mongoose.Schema({
  province: String,
  city: String,
  district: String,
  street: String,
  adcode: String,
}, { _id: false });

const serviceSchema = new mongoose.Schema({
  id: { type: String, required: true },
  name: { type: String, required: true },
  tags: [String],
  priceFen: { ...integer(), required: true },
  durationMinutes: { ...integer(1), required: true },
  note: { type: String, default: '' },
  imageUrl: { type: String, default: '' },
}, { _id: false });

const merchantReplySchema = new mongoose.Schema({
  content: { type: String, required: true },
  repliedAt: Date,
  reviewedAt: Date,
  reviewStatus: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
}, { _id: false });

const reviewContentSchema = new mongoose.Schema({
  id: String,
  bookingId: String,
  userName: String,
  user: String,
  rating: { type: Number, min: 1, max: 5 },
  comment: String,
  tags: [String],
  date: String,
  createdAt: Date,
  updatedAt: Date,
  serviceName: String,
  imageUrls: [String],
  reviewStatus: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
}, { _id: false });

const reviewSchema = new mongoose.Schema({
  id: String,
  bookingId: String,
  userName: String,
  user: String,
  rating: { type: Number, min: 1, max: 5 },
  comment: String,
  tags: [String],
  date: String,
  createdAt: Date,
  updatedAt: Date,
  serviceName: String,
  imageUrls: [String],
  reviewStatus: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  pendingEdit: { type: reviewContentSchema, default: undefined },
  merchantReply: { type: merchantReplySchema, default: undefined },
  pendingMerchantReply: { type: merchantReplySchema, default: undefined },
}, { _id: false });

const complaintSchema = new mongoose.Schema({
  id: String,
  bookingId: String,
  userId: String,
  userName: String,
  salonId: String,
  salonName: String,
  staffId: String,
  staffName: String,
  serviceName: String,
  description: String,
  imageUrls: [String],
  reviewStatus: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  date: String,
  createdAt: Date,
  status: { type: String, enum: ['submitted'], default: 'submitted' },
}, { _id: false });

const staffDraftSchema = new mongoose.Schema({
  id: String,
  name: String,
  role: String,
  experience: String,
  extraServiceFeeFen: { ...integer(), required: true, default: 0 },
  imageUrl: String,
  bio: String,
  unavailableSlots: [String],
}, { _id: false });

const pendingContentSchema = new mongoose.Schema({
  name: String,
  address: String,
  addressRegion: { type: addressRegionSchema, default: undefined },
  addressDetail: String,
  location: { type: locationSchema, default: undefined },
  description: String,
  fullDescription: String,
  image: String,
  images: [String],
  promoImages: [String],
  openingHours: String,
  acceptsSameDayBooking: Boolean,
  closedDates: [String],
  phone: String,
  services: [serviceSchema],
  staff: [staffDraftSchema],
}, { _id: false });

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
  servicePriceFen: integer(),
  serviceDurationMinutes: integer(1),
  staffExtraServiceFeeFen: integer(),
  timeZone: { type: String, enum: ['Asia/Shanghai'], default: 'Asia/Shanghai' },
  // Migration-only legacy fields; new bookings never write these.
  servicePrice: String,
  serviceDuration: String,
  serviceBasePrice: { type: Number, default: 0 },
  staffExtraServiceFee: { type: Number, default: 0 },
  totalPrice: { type: Number, default: 0 },
  originalAmountFen: integer(),
  couponId: { type: String, default: '' },
  couponCode: { type: String, default: '' },
  couponTitle: { type: String, default: '' },
  couponDiscountFen: integer(),
  payableAmountFen: integer(),
  couponRedeemedAt: Date,
  startTime: { type: Date, required: true, index: true },
  note: { type: String, default: '' },
  status: { type: String, default: 'pending', index: true },
  merchantMessage: String,
  userMessage: String,
  rejectReason: { type: String, default: '' },
  canceledBy: { type: String, default: '' },
  reviewed: { type: Boolean, default: false },
  review: { type: reviewSchema, default: undefined },
  complained: { type: Boolean, default: false },
  complaint: { type: complaintSchema, default: undefined },
  createdAt: Date,
  updatedAt: Date,
}, { id: false });

bookingSchema.index({ staffId: 1, startTime: 1, status: 1 });
bookingSchema.index({ salonId: 1, createdAt: -1 });
bookingSchema.index({ salonId: 1, status: 1, createdAt: -1 });
bookingSchema.index({ salonId: 1, startTime: 1, status: 1 });
bookingSchema.index({ userId: 1, createdAt: -1 });
bookingSchema.index({ userId: 1, status: 1, createdAt: -1 });
bookingSchema.index({ createdAt: -1 });
bookingSchema.index({ 'review.reviewStatus': 1, updatedAt: -1 });
bookingSchema.index({ staffId: 1, 'review.reviewStatus': 1, updatedAt: -1 });
bookingSchema.index({ 'complaint.reviewStatus': 1, updatedAt: -1 });

const bookingMessageSchema = new mongoose.Schema({
  id: { type: String, default: () => new mongoose.Types.ObjectId().toString(), unique: true, index: true },
  userId: { type: String, required: true },
  bookingId: { type: String, required: true },
  type: { type: String, required: true },
  status: { type: String, required: true },
  userMessage: { type: String, required: true },
  salonId: String,
  salonName: String,
  staffId: String,
  staffName: String,
  serviceId: String,
  serviceName: String,
  startTime: Date,
  couponTitle: String,
  couponDiscountFen: integer(),
  createdAt: { type: Date, default: Date.now },
  readAt: { type: Date, default: null },
}, { id: false });

bookingMessageSchema.index({ userId: 1, createdAt: -1 });
bookingMessageSchema.index({ userId: 1, readAt: 1 });

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
  addressRegion: { type: addressRegionSchema, default: undefined },
  addressDetail: String,
  location: { type: locationSchema, default: undefined },
  geoLocation: {
    type: { type: String, enum: ['Point'] },
    coordinates: [Number],
  },
  image: String,
  images: [String],
  promoImages: [String],
  description: String,
  fullDescription: String,
  tags: { type: [String], default: [] },
  openingHours: String,
  acceptsSameDayBooking: { type: Boolean, default: true },
  closedDates: [String],
  phone: String,
  staffIds: [String],
  services: [serviceSchema],
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
  pendingContent: { type: pendingContentSchema, default: undefined },
}, { timestamps: true });

salonSchema.index({ geoLocation: '2dsphere', publishStatus: 1 });
salonSchema.index({ staffIds: 1 });
salonSchema.index({ 'services.id': 1 });

const staffProfileSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  name: String,
  role: String,
  experience: String,
  extraServiceFeeFen: { ...integer(), required: true, default: 0 },
  imageUrl: String,
  bio: String,
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
  pendingAvatarUrl: { type: String, default: '' },
  avatarReviewStatus: { type: String, enum: ['none', 'pending', 'approved', 'rejected'], default: 'none', index: true },
  avatarRejectReason: { type: String, default: '' },
  avatarSubmittedAt: Date,
  avatarReviewedAt: Date,
  phone: { type: String, default: '' },
  wechatOpenId: { type: String, default: '' },
  authProvider: { type: String, enum: ['wechat'], required: true },
  sessionTokenHash: { type: String, default: '', index: true },
  sessionExpiresAt: Date,
  lastLoginAt: Date,
}, { timestamps: true });

clientUserSchema.index({ createdAt: -1 });

const adConfigSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, default: 'main' },
  imageUrl: { type: String, default: '' },
  link: { type: String, default: '/pages/ad/ad' },
  enabled: { type: Boolean, default: true },
}, { timestamps: true });

const couponTemplateSchema = new mongoose.Schema({
  key: { type: String, required: true },
  minimumSpendFen: { ...integer(), required: true },
  discountFen: { ...integer(), required: true },
  title: { type: String, required: true },
  description: { type: String, default: '' },
}, { _id: false });

const couponCampaignSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, default: 'new-user-registration' },
  enabled: { type: Boolean, default: false },
  promotionImageUrl: { type: String, default: '' },
  registrationStartAt: Date,
  registrationEndAt: Date,
  coupons: { type: [couponTemplateSchema], default: [] },
  updatedBy: { type: String, default: '' },
}, { timestamps: true });

const userCouponSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  campaignKey: { type: String, required: true, index: true },
  couponType: { type: String, required: true },
  userId: { type: String, required: true, index: true },
  minimumSpendFen: { ...integer(), required: true },
  discountFen: { ...integer(), required: true },
  title: { type: String, required: true },
  description: { type: String, default: '' },
  grantedAt: { type: Date, required: true },
  validFrom: { type: Date, required: true },
  validUntil: { type: Date, required: true, index: true },
  claimedAt: Date,
  code: { type: String, unique: true, sparse: true },
  reservedAt: Date,
  reservedBookingId: { type: String, default: '', index: true },
  redeemedAt: Date,
  redeemedBookingId: { type: String, default: '', index: true },
  redeemedSalonId: { type: String, default: '' },
  redeemedMerchantId: { type: String, default: '' },
}, { timestamps: true });

userCouponSchema.index({ userId: 1, campaignKey: 1, couponType: 1 }, { unique: true });

const supportMessageSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  userId: { type: String, default: '', index: true },
  userName: { type: String, default: '' },
  problem: { type: String, required: true },
  contact: { type: String, required: true },
}, { timestamps: true });

supportMessageSchema.index({ createdAt: -1 });

const analyticsEventSchema = new mongoose.Schema({
  eventId: { type: String, required: true, unique: true },
  name: { type: String, required: true, index: true },
  anonymousId: { type: String, default: '' },
  userId: { type: String, default: '', index: true },
  salonId: { type: String, default: '', index: true },
  serviceId: { type: String, default: '' },
  bookingId: { type: String, default: '', index: true },
  sourceBookingId: { type: String, default: '' },
  source: { type: String, enum: ['client', 'server'], required: true },
  createdAt: { type: Date, default: Date.now },
}, { id: false });

analyticsEventSchema.index({ name: 1, createdAt: -1 });

module.exports = {
  Booking: mongoose.model('Booking', bookingSchema),
  BookingMessage: mongoose.model('BookingMessage', bookingMessageSchema),
  SlotOccupancy: mongoose.model('SlotOccupancy', slotOccupancySchema),
  UserPolicy: mongoose.model('UserPolicy', userPolicySchema),
  FavoriteSalon: mongoose.model('FavoriteSalon', favoriteSalonSchema),
  Salon: mongoose.model('Salon', salonSchema),
  StaffProfile: mongoose.model('StaffProfile', staffProfileSchema),
  MerchantUser: mongoose.model('MerchantUser', merchantUserSchema),
  AdminUser: mongoose.model('AdminUser', adminUserSchema),
  ClientUser: mongoose.model('ClientUser', clientUserSchema),
  AdConfig: mongoose.model('AdConfig', adConfigSchema),
  CouponCampaign: mongoose.model('CouponCampaign', couponCampaignSchema),
  UserCoupon: mongoose.model('UserCoupon', userCouponSchema),
  SupportMessage: mongoose.model('SupportMessage', supportMessageSchema),
  AnalyticsEvent: mongoose.model('AnalyticsEvent', analyticsEventSchema),
};
