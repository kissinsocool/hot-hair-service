import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const baseUrl = (__ENV.K6_BASE_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const latitude = __ENV.K6_LATITUDE || '31.2304';
const longitude = __ENV.K6_LONGITUDE || '121.4737';
const writeEnabled = String(__ENV.K6_ENABLE_WRITES || '').toLowerCase() === 'true';
const configuredSalonId = String(__ENV.K6_SALON_ID || '').trim();
const rateLimitBypassToken = String(__ENV.K6_RATE_LIMIT_BYPASS_TOKEN || '').trim();
const clientTokens = String(__ENV.K6_CLIENT_TOKENS || '')
  .split(',')
  .map(token => token.trim())
  .filter(Boolean);
const p95Ms = Number(__ENV.K6_P95_MS || 500);
const p99Ms = Number(__ENV.K6_P99_MS || 1000);
const sleepSeconds = Number(__ENV.K6_SLEEP_SECONDS || (writeEnabled ? 15 : 2));
const businessErrors = new Rate('business_errors');
let loggedFailures = 0;

export const options = {
  scenarios: {
    booking_flow: {
      executor: 'constant-vus',
      vus: Number(__ENV.K6_VUS || 1),
      duration: __ENV.K6_DURATION || '2m',
      gracefulStop: '10s',
    },
  },
  thresholds: {
    checks: ['rate>0.99'],
    business_errors: ['rate<0.01'],
    http_req_failed: ['rate<0.01'],
    http_req_duration: [`p(95)<${p95Ms}`, `p(99)<${p99Ms}`],
  },
};

const json = response => {
  try {
    return response.json();
  } catch {
    return null;
  }
};

const requestParams = token => ({
  headers: {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(rateLimitBypassToken ? { 'X-Load-Test-Token': rateLimitBypassToken } : {}),
  },
});

const failFlow = (step, response) => {
  businessErrors.add(true);
  if (loggedFailures >= 5) return;
  const body = String(response?.body || '').slice(0, 300);
  console.error(`${step}: HTTP ${response?.status || 0} ${body}`);
  loggedFailures += 1;
};

const bookingDate = () => {
  if (__ENV.K6_BOOKING_DATE) return __ENV.K6_BOOKING_DATE;
  const date = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
};

export function setup() {
  if (writeEnabled && !clientTokens.length) {
    throw new Error('K6_CLIENT_TOKENS is required when K6_ENABLE_WRITES=true');
  }
  if (writeEnabled && !configuredSalonId) {
    throw new Error('K6_SALON_ID is required when K6_ENABLE_WRITES=true');
  }
  if (rateLimitBypassToken && rateLimitBypassToken.length < 32) {
    throw new Error('K6_RATE_LIMIT_BYPASS_TOKEN must contain at least 32 characters');
  }

  const response = http.get(`${baseUrl}/ready`, { tags: { name: 'GET /ready' } });
  if (response.status !== 200) {
    throw new Error(`Target is not ready: HTTP ${response.status}`);
  }
}

const runFlow = () => {
  const token = clientTokens[(__VU - 1) % Math.max(clientTokens.length, 1)];
  const salonsResponse = http.get(
    `${baseUrl}/api/salons?latitude=${latitude}&longitude=${longitude}&limit=20&minResults=1`,
    { ...requestParams(), tags: { name: 'GET /api/salons' } },
  );
  const salons = json(salonsResponse);
  if (!check(salonsResponse, {
    'salon list returns 200': response => response.status === 200,
    'a target salon is available': () => Boolean(configuredSalonId)
      || (Array.isArray(salons) && salons.length > 0),
  })) {
    failFlow('salon list failed', salonsResponse);
    return;
  }

  const salonId = configuredSalonId || salons[(__VU + __ITER) % salons.length].id;
  const salonResponse = http.get(
    `${baseUrl}/api/salons/${encodeURIComponent(salonId)}`,
    { ...requestParams(), tags: { name: 'GET /api/salons/:id' } },
  );
  const salonDetail = json(salonResponse);
  if (!check(salonResponse, {
    'salon detail returns 200': response => response.status === 200,
    'salon has a service': () => Array.isArray(salonDetail?.services) && salonDetail.services.length > 0,
  })) {
    failFlow('salon detail failed', salonResponse);
    return;
  }

  const date = bookingDate();
  const slotsResponse = http.get(
    `${baseUrl}/api/staff/__no_preference__/slots?date=${date}&salonId=${encodeURIComponent(salonId)}`,
    { ...requestParams(), tags: { name: 'GET /api/staff/:id/slots' } },
  );
  const slots = json(slotsResponse);
  const availableSlots = Array.isArray(slots) ? slots.filter(slot => slot.isAvailable) : [];
  if (!check(slotsResponse, {
    'slots return 200': response => response.status === 200,
    'an available slot exists': () => availableSlots.length > 0,
  })) {
    failFlow('slot lookup failed', slotsResponse);
    return;
  }

  if (!writeEnabled) {
    businessErrors.add(false);
    return;
  }

  const service = salonDetail.services[(__VU + __ITER) % salonDetail.services.length];
  const slot = availableSlots[(__VU + __ITER) % availableSlots.length];
  const bookingResponse = http.post(`${baseUrl}/api/bookings`, JSON.stringify({
    staffId: '__no_preference__',
    salonId,
    serviceId: service.id,
    startTime: slot.startTime,
    note: 'k6 performance test',
  }), {
    ...requestParams(token),
    tags: { name: 'POST /api/bookings' },
  });
  const booking = json(bookingResponse)?.booking;
  if (!check(bookingResponse, {
    'booking is created': response => response.status === 201,
    'booking id is returned': () => Boolean(booking?.id),
  })) {
    failFlow('booking creation failed', bookingResponse);
    return;
  }

  const bookingsResponse = http.get(
    `${baseUrl}/api/bookings?status=pending&limit=100`,
    {
      ...requestParams(token),
      tags: { name: 'GET /api/bookings' },
    },
  );
  const bookings = json(bookingsResponse);
  const bookingVisible = Array.isArray(bookings) && bookings.some(item => item.id === booking.id);
  const bookingWasFound = check(bookingsResponse, {
    'bookings return 200': response => response.status === 200,
    'created booking is visible': () => bookingVisible,
  });

  const cancelResponse = http.patch(
    `${baseUrl}/api/bookings/${encodeURIComponent(booking.id)}/cancel`,
    '{}',
    {
      ...requestParams(token),
      tags: { name: 'PATCH /api/bookings/:id/cancel' },
    },
  );
  const bookingWasCanceled = check(cancelResponse, {
    'booking is canceled': response => response.status === 200 && json(response)?.booking?.status === 'canceled',
  });

  if (!bookingWasFound) failFlow('booking lookup failed', bookingsResponse);
  else if (!bookingWasCanceled) failFlow('booking cancellation failed', cancelResponse);
  else businessErrors.add(false);
};

export default function () {
  try {
    runFlow();
  } finally {
    sleep(sleepSeconds);
  }
}
