const { businessTimeZone, businessUtcOffset } = require('../config');

const bookingDayRange = (value, now = new Date()) => {
  const date = String(value || '').trim() || localDateKey(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const start = new Date(`${date}T00:00:00${businessUtcOffset}`);
  if (Number.isNaN(start.getTime()) || localDateKey(start) !== date) return null;
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
};

const localDateKey = (date = new Date()) => {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: businessTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);
};

const localTimeMinutes = (date) => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: businessTimeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return Number(values.hour) * 60 + Number(values.minute);
};

const parseBookingTime = (value) => {
  const input = String(value || '').trim();
  if (!input) return null;
  const explicit = /(Z|[+-]\d{2}:\d{2})$/i.test(input)
    ? input
    : `${input}${businessUtcOffset}`;
  const parsed = new Date(explicit);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const localBookingDateKey = (value) => {
  const input = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
  const parsed = value instanceof Date ? value : parseBookingTime(value);
  return parsed ? localDateKey(parsed) : '';
};

const slotStartTime = (date, time) => `${date}T${time}:00${businessUtcOffset}`;

const priceFen = (value) => {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  const amount = Number(String(value || '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) : 0;
};

const durationMinutes = (value) => {
  if (Number.isSafeInteger(value) && value > 0) return value;
  const minutes = Number(String(value || '').match(/\d+/)?.[0]);
  return Number.isSafeInteger(minutes) && minutes > 0 ? minutes : 0;
};

const parseTimeToMinutes = (time) => {
  const match = String(time || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59
    ? hours * 60 + minutes
    : null;
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

const generateHalfHourSlots = (openingHours = '10:00 - 20:00') => {
  const { start, end } = parseOpeningHours(openingHours);
  const slots = [];
  for (let minutes = start; minutes <= end; minutes += 30) {
    slots.push(formatMinutesAsTime(minutes));
  }
  return slots;
};

const normalizeUnavailableSlots = (slots, max = 500) => {
  if (!Array.isArray(slots)) return [];
  return [...new Set(slots
    .filter(slot => typeof slot === 'string')
    .map(slot => slot.trim())
    .filter(slot => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(slot))
  )].sort().slice(0, max);
};

const normalizeClosedDates = (dates, max = 500) => {
  if (!Array.isArray(dates)) return [];
  return [...new Set(dates
    .filter(date => typeof date === 'string')
    .map(date => date.trim())
    .filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date))
  )].sort().slice(0, max);
};

const isSalonClosedOnDate = (salon, date) => {
  const dateKey = localBookingDateKey(date);
  return Boolean(dateKey && normalizeClosedDates(salon?.closedDates).includes(dateKey));
};

const isSameDayBookingBlocked = (salon, date, now = new Date()) => {
  if (salon?.acceptsSameDayBooking !== false) return false;
  const dateKey = localBookingDateKey(date);
  return Boolean(dateKey && dateKey === localDateKey(now));
};

const parseMerchantRescheduleTime = (status, startTime, now = Date.now()) => {
  if (!['pending', 'accepted'].includes(status)) {
    return { error: 'Only pending or accepted bookings can be rescheduled', status: 409 };
  }
  const value = parseBookingTime(startTime);
  if (!value) return { error: 'startTime must be a valid date time', status: 400 };
  if (localTimeMinutes(value) % 30 !== 0) {
    return { error: 'startTime must use a 30-minute interval', status: 400 };
  }
  if (value.getTime() <= now) {
    return { error: 'Only future time slots can be booked', status: 409 };
  }
  return { value };
};

const acceptedBookingAtTimeQuery = (staffId, startTime, bookingId) => ({
  staffId,
  startTime: parseBookingTime(startTime),
  id: { $ne: bookingId },
  status: 'accepted',
});

const buildMerchantBookingScope = (salonId, staffIds = []) => ({
  $or: [
    { staffId: { $in: staffIds }, status: { $in: ['pending', 'accepted'] } },
    { salonId, staffId: '' },
    { salonId, status: { $nin: ['pending', 'accepted'] } },
  ],
});

const normalizeBookingPayload = (booking, includePendingMerchantReply = false) => {
  const normalized = typeof booking?.toObject === 'function' ? booking.toObject() : booking;
  const servicePriceFen = Number.isSafeInteger(normalized.servicePriceFen)
    ? normalized.servicePriceFen
    : priceFen(String(normalized.servicePrice || normalized.serviceBasePrice || 0));
  const staffExtraServiceFeeFen = Number.isSafeInteger(normalized.staffExtraServiceFeeFen)
    ? normalized.staffExtraServiceFeeFen
    : priceFen(String(normalized.staffExtraServiceFee || 0));
  const serviceDurationMinutes = Number.isSafeInteger(normalized.serviceDurationMinutes)
    ? normalized.serviceDurationMinutes
    : durationMinutes(normalized.serviceDuration);
  const calculatedOriginalAmountFen = servicePriceFen + staffExtraServiceFeeFen;
  const originalAmountFen = Number.isSafeInteger(normalized.originalAmountFen)
    ? normalized.originalAmountFen
    : calculatedOriginalAmountFen;
  const payableAmountFen = Number.isSafeInteger(normalized.payableAmountFen)
    ? normalized.payableAmountFen
    : Math.max(0, originalAmountFen - (normalized.couponDiscountFen || 0));
  const review = normalized.review && { ...normalized.review };
  if (review && !includePendingMerchantReply) delete review.pendingMerchantReply;
  if (review) delete review.pendingEdit;
  if (review?.merchantReply?.reviewStatus && review.merchantReply.reviewStatus !== 'approved') {
    delete review.merchantReply;
  }
  const serviceAmount = servicePriceFen / 100;
  return {
    ...normalized,
    servicePriceFen,
    serviceDurationMinutes,
    staffExtraServiceFeeFen,
    originalAmountFen,
    payableAmountFen,
    timeZone: normalized.timeZone || businessTimeZone,
    servicePrice: normalized.servicePrice
      || `¥${Number.isInteger(serviceAmount) ? serviceAmount : serviceAmount.toFixed(2)}`,
    serviceDuration: normalized.serviceDuration || `${serviceDurationMinutes}分钟`,
    serviceBasePrice: serviceAmount,
    staffExtraServiceFee: staffExtraServiceFeeFen / 100,
    totalPrice: originalAmountFen / 100,
    ...(review ? { review } : {}),
    statusLabel: {
      pending: '等待商家确认',
      accepted: '预约成功',
      canceled: '预约已取消',
      completed: '已完成',
      no_show: '爽约',
      rejected: '预约被拒绝',
    }[normalized.status] || normalized.status,
  };
};

const generateBookingId = randomInt => String(randomInt(0, 100000000)).padStart(8, '0');
const isDuplicateSlotError = error => error?.code === 11000;
const transactionError = (status, message) => Object.assign(new Error(message), { httpStatus: status });

const reserveBookingSlot = (SlotOccupancy, bookingId, staffId, startTime, session) => {
  const normalizedStartTime = parseBookingTime(startTime);
  return SlotOccupancy.updateOne(
    { bookingId, staffId, startTime: normalizedStartTime },
    { $setOnInsert: { bookingId, staffId, startTime: normalizedStartTime } },
    { upsert: true, session },
  );
};

const runBookingTransaction = async (mongoose, work) => {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(
      async () => { result = await work(session); },
      { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
    );
    return result;
  } finally {
    await session.endSession();
  }
};

module.exports = {
  businessTimeZone,
  businessUtcOffset,
  acceptedBookingAtTimeQuery,
  bookingDayRange,
  buildMerchantBookingScope,
  durationMinutes,
  formatMinutesAsTime,
  generateBookingId,
  generateHalfHourSlots,
  isDuplicateSlotError,
  isSalonClosedOnDate,
  isSameDayBookingBlocked,
  localDateKey,
  localBookingDateKey,
  localTimeMinutes,
  normalizeBookingPayload,
  normalizeClosedDates,
  normalizeUnavailableSlots,
  parseBookingTime,
  parseMerchantRescheduleTime,
  parseOpeningHours,
  parseTimeToMinutes,
  priceFen,
  reserveBookingSlot,
  runBookingTransaction,
  slotStartTime,
  transactionError,
};
