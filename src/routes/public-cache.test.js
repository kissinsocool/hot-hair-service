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

test('admin and merchant writes clear the shared public caches so changes show at once', async () => {
  const { createPublicResponseCaches } = require('../ttl-cache');
  const registerAdminRoutes = require('./admin');
  const { Salon } = require('../models');
  const publicResponseCaches = createPublicResponseCaches();
  let ad = { imageUrl: 'https://media.hothaircc.cn/uploads/old.jpg' };
  let adReads = 0;
  let galleryReads = 0;
  const salon = new Salon({
    id: 'cache-salon', name: '门店', publishStatus: 'online',
    services: [{ id: 'service-1', name: '剪发', priceFen: 100, durationMinutes: 30, promotionReviewStatus: 'pending' }],
  });
  salon.save = async () => {};

  const routes = new Map();
  const app = new Proxy({}, { get: (_target, method) => (path, ...handlers) => {
    routes.set(`${String(method)}:${path}`, handlers.at(-1));
  } });
  const shared = {
    rateLimits: { publicRead: [], upload: [], login: [], merchantBooking: [] },
    publicResponseCaches,
    clearAdCache: () => publicResponseCaches.ad.clear(),
    clearCouponCampaignCache: () => publicResponseCaches.couponCampaign.clear(),
    clearPromotedServicesCache: () => publicResponseCaches.promotedServices.clear(),
    publicImageUrl: value => value,
    buildAdPayload: config => ({ imageUrl: config.imageUrl }),
    normalizeAdLink: value => value,
    AdConfig: {
      findOne: () => ({ async lean() { adReads += 1; return ad; } }),
      findOneAndUpdate: (_filter, update) => ({ async lean() { ad = { imageUrl: update.imageUrl }; return ad; } }),
    },
    Salon: {
      aggregate: () => ({ async option() {
        galleryReads += 1;
        return [{ items: [{ salonId: 'cache-salon', serviceId: `read-${galleryReads}`, imageIndex: 0, imageUrl: 'a.jpg' }], total: [{ count: 1 }] }];
      } }),
      findOne: async () => salon,
    },
    MerchantUser: { findOne: () => ({ async lean() { return { id: 'merchant-1', salonId: salon.id }; } }) },
    normalizePagination: () => ({ page: 1, limit: 30, skip: 0 }),
    setPaginationHeaders() {},
    buildAdminMerchantPayload: async () => ({}),
  };
  registerPublicRoutes(app, shared);
  registerAdminRoutes(app, shared);
  const call = async (route, req = {}) => {
    const res = respond();
    await routes.get(route)({ query: {}, params: {}, body: {}, adminUser: { id: 'admin' }, ...req }, res);
    return res.body;
  };
  const gallery = async () => (await call('get:/api/salons/promoted-services', { query: { category: 'men-cut' } }))[0].serviceId;

  assert.equal((await call('get:/api/ad')).imageUrl, 'https://media.hothaircc.cn/uploads/old.jpg');
  await call('get:/api/ad');
  assert.equal(adReads, 1);
  await call('patch:/api/admin/ad', { body: { imageUrl: 'https://media.hothaircc.cn/uploads/new.jpg', link: '/pages/home/home', enabled: true } });
  assert.equal((await call('get:/api/ad')).imageUrl, 'https://media.hothaircc.cn/uploads/new.jpg');
  assert.equal(adReads, 2);

  assert.equal(await gallery(), 'read-1');
  assert.equal(await gallery(), 'read-1');
  await call('patch:/api/admin/merchants/:id/services/:serviceId/promotion', {
    params: { id: 'merchant-1', serviceId: 'service-1' }, body: { action: 'approve' },
  });
  assert.equal(await gallery(), 'read-2');
});

test('every route that saves a salon clears the promoted gallery cache', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const file of ['admin.js', 'merchant.js']) {
    const lines = fs.readFileSync(path.join(__dirname, file), 'utf8').split('\n');
    const saves = lines.flatMap((line, index) => (/salon\.save\(/.test(line) ? [index] : []));
    assert.ok(saves.length > 0, file);
    for (const index of saves) {
      assert.match(lines[index + 1], /clearPromotedServicesCache\?\.\(\);/, `${file}:${index + 1}`);
    }
  }
});

test('public response lifetimes: long where a write clears them, short where the clock decides', async () => {
  const { createPublicResponseCaches } = require('../ttl-cache');
  let time = 0;
  const caches = createPublicResponseCaches(() => time);
  const loads = { ad: 0, couponCampaign: 0, promotedServices: 0 };
  const read = () => Promise.all(Object.keys(loads).map(name => caches[name].get('key', async () => { loads[name] += 1; })));

  await read();
  time = 14_999;
  await read();
  assert.deepEqual(loads, { ad: 1, couponCampaign: 1, promotedServices: 1 });
  // A campaign starts and ends by the clock, so it is re-read after 15 seconds; the others wait for a write.
  time = 15_000;
  await read();
  assert.deepEqual(loads, { ad: 1, couponCampaign: 2, promotedServices: 1 });
  time = 299_999;
  await read();
  assert.equal(loads.ad, 1);
  assert.equal(loads.promotedServices, 1);
  time = 300_000;
  await read();
  assert.equal(loads.ad, 2);
  assert.equal(loads.promotedServices, 2);
});
