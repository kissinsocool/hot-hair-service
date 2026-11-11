const test = require('node:test');
const assert = require('node:assert/strict');
const registerPublicRoutes = require('./public');
const { AnalyticsEvent } = require('../models');

const collectRoutes = (ctx) => {
  const routes = new Map();
  registerPublicRoutes({ get(path, ...handlers) { routes.set(path, handlers.at(-1)); } }, {
    rateLimits: { publicRead: [] },
    publicImageUrl: value => value,
    ...ctx,
  });
  return routes;
};
const respond = () => ({ set() {}, status() { return this; }, json(value) { this.body = value; } });

test('ad and coupon campaign are read from MongoDB once per cache window', async () => {
  let adReads = 0;
  let campaignReads = 0;
  const routes = collectRoutes({
    AdConfig: { findOne: () => ({ async lean() { adReads += 1; return { imageUrl: `ad-${adReads}.jpg` }; } }) },
    buildAdPayload: config => ({ imageUrl: config.imageUrl }),
    CouponCampaign: { findOne: () => ({
      select() { return this; },
      async lean() { campaignReads += 1; return { promotionImageUrl: 'gift.jpg' }; },
    }) },
  });

  const responses = [respond(), respond(), respond(), respond()];
  await routes.get('/api/ad')({}, responses[0]);
  await routes.get('/api/ad')({}, responses[1]);
  await routes.get('/api/coupon-campaign')({}, responses[2]);
  await routes.get('/api/coupon-campaign')({}, responses[3]);

  assert.equal(adReads, 1);
  assert.deepEqual(responses[1].body, { imageUrl: 'ad-1.jpg' });
  assert.equal(campaignReads, 1);
  assert.deepEqual(responses[3].body, { enabled: true, promotionImageUrl: 'gift.jpg' });
});

test('promoted services cache the shared latest order per category and page, never the distance order', async () => {
  let aggregations = 0;
  const totals = [];
  const routes = collectRoutes({
    Salon: { aggregate: () => ({ async option() {
      aggregations += 1;
      return [{
        items: [{ salonId: `salon-${aggregations}`, serviceId: 'cut', imageIndex: 0, imageUrl: 'a.jpg' }],
        total: [{ count: 7 }],
      }];
    } }) },
    normalizePagination: query => ({ page: Number(query.page) || 1, limit: 30, skip: 0 }),
    getCoordinates: value => (value.latitude ? { latitude: 39, longitude: 116 } : null),
    setPaginationHeaders(_res, _pagination, total) { totals.push(total); },
  });
  const request = async (query) => {
    const response = respond();
    await routes.get('/api/salons/promoted-services')({ query }, response);
    return response.body[0].salonId;
  };

  assert.equal(await request({ category: 'men-cut' }), 'salon-1');
  assert.equal(await request({ category: 'men-cut' }), 'salon-1');
  assert.equal(await request({ category: 'men-cut', page: '2' }), 'salon-2');
  assert.equal(await request({ category: 'color' }), 'salon-3');
  const nearby = { category: 'men-cut', sort: 'distance', latitude: '39', longitude: '116' };
  assert.equal(await request(nearby), 'salon-4');
  assert.equal(await request(nearby), 'salon-5');
  // A cached page still reports its total.
  assert.deepEqual(totals, [7, 7, 7, 7, 7, 7]);
});

test('analytics events keep only the indexes their writes and the admin funnel use', () => {
  assert.deepEqual(AnalyticsEvent.schema.indexes().map(([keys]) => keys), [
    { eventId: 1 },
    { name: 1, createdAt: -1 },
    { createdAt: 1 },
  ]);
});

test('authenticated requests never load credential fields onto the request', async () => {
  const { createAuthService } = require('../services/auth');
  const { AdminUser } = require('../models');
  const originalFindOne = AdminUser.findOne;
  let projection;
  AdminUser.findOne = () => ({
    select(value) { projection = value; return this; },
    async lean() { return { id: 'admin-1' }; },
  });
  try {
    const req = { headers: { authorization: 'Bearer token' } };
    let passed = false;
    await createAuthService().requireAdminAuth(req, {}, () => { passed = true; });
    assert.equal(passed, true);
    assert.equal(req.adminUser.id, 'admin-1');
    assert.deepEqual(projection.split(' ').sort(), ['-passwordHash', '-passwordSalt', '-sessionTokenHash']);
  } finally {
    AdminUser.findOne = originalFindOne;
  }
});

test('booking salon reads exclude the unreviewed draft and qualification documents', () => {
  const { BOOKING_SALON_PROJECTION } = require('../services/salon');
  const excluded = BOOKING_SALON_PROJECTION.split(' ');
  for (const field of ['-pendingContent', '-licenseUrl', '-legalPersonIdFrontUrl', '-legalPersonIdBackUrl', '-addressProofUrl']) {
    assert.ok(excluded.includes(field), field);
  }
  // Fields the slot, staff-detail and booking flows read must stay.
  for (const field of ['id', 'name', 'services', 'staffIds', 'openingHours', 'weeklyClosedDays', 'closedDates',
    'acceptsSameDayBooking', 'publishStatus']) {
    assert.ok(!excluded.includes(`-${field}`), field);
  }
});
