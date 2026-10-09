const CLIENT_EVENTS = new Set([
  'home_exposure',
  'salon_detail_click',
  'service_click',
  'booking_started',
  'slot_selected',
  'rebooking_started',
]);

const FUNNEL_STAGES = [
  'home_exposure',
  'salon_detail_click',
  'service_click',
  'booking_started',
  'slot_selected',
  'booking_submitted',
  'merchant_accepted',
  'visit_completed',
  'review_submitted',
  'rebooking_started',
];

const text = (value, max = 100) => String(value || '').trim().slice(0, max);

const clientEvent = (body = {}, userId = '') => ({
  eventId: text(body.eventId),
  name: text(body.name, 40),
  anonymousId: text(body.anonymousId),
  userId: text(userId),
  salonId: text(body.salonId),
  serviceId: text(body.serviceId),
  bookingId: text(body.bookingId),
  sourceBookingId: text(body.sourceBookingId),
  source: 'client',
});

const validateClientEvent = event => {
  if (!event.eventId || !CLIENT_EVENTS.has(event.name)) return 'Invalid analytics event';
  if (!event.anonymousId) return 'anonymousId is required';
  return '';
};

const recordAnalyticsEvent = async (AnalyticsEvent, event) => {
  try {
    return await AnalyticsEvent.updateOne(
      { eventId: event.eventId },
      { $setOnInsert: event },
      { upsert: true },
    );
  } catch (error) {
    if (error?.code === 11000) return null;
    throw error;
  }
};

const bookingEvent = (name, booking) => ({
  eventId: `booking:${booking.id}:${name}`,
  name,
  userId: text(booking.userId),
  salonId: text(booking.salonId),
  serviceId: text(booking.serviceId),
  bookingId: text(booking.id),
  source: 'server',
});

const rate = (numerator, denominator) => denominator
  ? Number((numerator * 100 / denominator).toFixed(1))
  : 0;

const funnelMetrics = (rows = []) => {
  const counts = Object.fromEntries(FUNNEL_STAGES.map(name => [name, 0]));
  rows.forEach(({ _id, count }) => {
    if (Object.hasOwn(counts, _id)) counts[_id] = count;
  });
  return {
    counts,
    salonDetailClickRate: rate(counts.salon_detail_click, counts.home_exposure),
    bookingSubmissionRate: rate(counts.booking_submitted, counts.booking_started),
  };
};

module.exports = {
  CLIENT_EVENTS,
  FUNNEL_STAGES,
  bookingEvent,
  clientEvent,
  funnelMetrics,
  recordAnalyticsEvent,
  validateClientEvent,
};
