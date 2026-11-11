const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAdminMerchantPayload } = require('../../index');
const registerAdminRoutes = require('./admin');
const { Booking, StaffProfile, StaffRatingSummary } = require('../models');

const query = rows => ({ select() { return this; }, sort() { return this; }, skip() { return this; },
  limit() { return this; }, async lean() { return rows; } });

const withModelStubs = async (stubs, work) => {
  const originals = stubs.map(([Model, method]) => Model[method]);
  stubs.forEach(([Model, method, replacement]) => { Model[method] = replacement; });
  try {
    return await work();
  } finally {
    stubs.forEach(([Model, method], index) => { Model[method] = originals[index]; });
  }
};

const user = { id: 'merchant-1', username: 'shop', displayName: 'Shop', salonId: 'salon-1', role: 'merchant' };
const salon = {
  id: 'salon-1', name: 'Salon', staffIds: ['staff-1'], licenseUrl: '',
  services: [{ id: 'service-1', name: 'Cut', priceFen: 100, durationMinutes: 30 }],
};
const profile = { id: 'staff-1', name: 'Ann', roleId: 'designer', extraServiceFeeFen: 0 };
const ratingRow = { staffId: 'staff-1', reviewCount: 2, ratingTotal: 9, techniqueCount: 2, techniqueTotal: 8 };

test('admin merchant payload keeps its shape without loading review text', async () => {
  let reviewQueries = 0;
  const payload = await withModelStubs([
    [StaffProfile, 'find', () => query([profile])],
    [StaffRatingSummary, 'find', () => query([ratingRow])],
    [Booking, 'find', () => { reviewQueries += 1; return query([]); }],
  ], () => buildAdminMerchantPayload(user, salon));

  assert.equal(reviewQueries, 0);
  assert.equal(payload.id, 'merchant-1');
  assert.equal(payload.salon.name, 'Salon');
  assert.deepEqual(payload.salon.reviews, []);
  assert.equal(payload.salon.staff.length, 1);
  assert.equal(payload.salon.staff[0].name, 'Ann');
  assert.deepEqual(payload.salon.staff[0].reviews, []);
  assert.equal(payload.salon.staff[0].rating, 4);
  assert.equal(payload.salon.staff[0].reviewCount, 2);
  assert.equal(payload.salon.services[0].id, 'service-1');
});

test('admin merchant payload uses preloaded stylists and ratings without querying', async () => {
  const fail = () => { throw new Error('unexpected query'); };
  const payload = await withModelStubs([
    [StaffProfile, 'find', fail], [StaffRatingSummary, 'find', fail], [Booking, 'find', fail],
  ], () => buildAdminMerchantPayload(user, salon, {
    staffMap: { 'staff-1': profile },
    ratingSummaries: { 'staff-1': { techniqueRating: 4.5, reviewCount: 3 } },
  }));

  assert.equal(payload.salon.staff[0].rating, 4.5);
  assert.equal(payload.salon.staff[0].reviewCount, 3);
});

test('merchant list loads stylists and ratings once for the whole page', async () => {
  const routes = new Map();
  const calls = { staff: [], ratings: [], payloads: [] };
  const app = new Proxy({}, { get: (_target, method) => (path, ...handlers) => {
    routes.set(`${String(method)}:${path}`, handlers.at(-1));
  } });
  registerAdminRoutes(app, {
    rateLimits: { upload: [], login: [], merchantBooking: [] },
    MerchantUser: {
      find: () => query([{ id: 'm1', salonId: 's1' }, { id: 'm2', salonId: 's2' }]),
      countDocuments: async () => 2,
    },
    Salon: { find: () => query([
      { id: 's1', staffIds: ['a', 'b'] },
      { id: 's2', staffIds: ['b', 'c'] },
    ]) },
    normalizePagination: () => ({ page: 1, limit: 50, skip: 0 }),
    setPaginationHeaders() {},
    async getStaffMapByIds(ids) { calls.staff.push(ids); return { a: {} }; },
    async getApprovedRatingSummariesByStaffIds(ids) { calls.ratings.push(ids); return { a: {} }; },
    async buildAdminMerchantPayload(merchant, salonValue, preloaded) {
      calls.payloads.push(preloaded);
      return { id: merchant.id, salonId: salonValue.id };
    },
  });

  let body;
  await routes.get('get:/api/admin/merchants')({ query: {} }, { json(value) { body = value; } });

  assert.deepEqual(body, [{ id: 'm1', salonId: 's1' }, { id: 'm2', salonId: 's2' }]);
  assert.deepEqual(calls.staff, [['a', 'b', 'c']]);
  assert.deepEqual(calls.ratings, [['a', 'b', 'c']]);
  assert.equal(calls.payloads.length, 2);
  assert.ok(calls.payloads.every(preloaded => preloaded.staffMap.a && preloaded.ratingSummaries.a));
});

const adminRoutes = (ctx) => {
  const routes = new Map();
  const app = new Proxy({}, { get: (_target, method) => (path, ...handlers) => {
    routes.set(`${String(method)}:${path}`, handlers.at(-1));
  } });
  registerAdminRoutes(app, { rateLimits: { upload: [], login: [], merchantBooking: [] }, ...ctx });
  return routes;
};

test('salon contacts return only the name, phone and address of each salon', async () => {
  let projection;
  let total;
  const routes = adminRoutes({
    Salon: {
      find: () => ({ ...query([
        { id: 's1', name: 'One', phone: '123', address: 'Road 1' },
        { id: 's2' },
      ]), select(value) { projection = value; return this; } }),
      countDocuments: async () => 2,
    },
    normalizePagination: () => ({ page: 1, limit: 100, skip: 0 }),
    setPaginationHeaders(_res, _pagination, value) { total = value; },
  });

  let body;
  await routes.get('get:/api/admin/salon-contacts')({ query: {} }, { json(value) { body = value; } });

  assert.equal(projection, 'id name phone address -_id');
  assert.equal(total, 2);
  assert.deepEqual(body, [
    { salonId: 's1', name: 'One', phone: '123', address: 'Road 1' },
    { salonId: 's2', name: '', phone: '', address: '' },
  ]);
});

test('service promotions list live services with a promotion request and their merchant', async () => {
  const service = (id, promotionReviewStatus) => ({
    id, name: `Service ${id}`, priceFen: 8800, durationMinutes: 30, tagIds: ['men'],
    imageUrls: ['https://media.hothaircc.cn/a.jpg'], promotionReviewStatus,
    promotionEnabled: promotionReviewStatus === 'approved',
  });
  let salonFilter;
  const routes = adminRoutes({
    Salon: { find: (filter) => {
      salonFilter = filter;
      return query([
        { id: 's1', name: 'One', services: [service('a', 'pending'), service('b', 'unsubmitted')] },
        { id: 's2', name: 'Two', services: [service('c', 'approved'), service('d', 'rejected')] },
      ]);
    } },
    MerchantUser: { find: () => query([{ id: 'm2', salonId: 's2' }, { id: 'm1', salonId: 's1' }]) },
  });

  let body;
  await routes.get('get:/api/admin/service-promotions')({ query: {} }, { json(value) { body = value; } });

  assert.deepEqual(salonFilter, { 'services.promotionReviewStatus': { $in: ['pending', 'approved', 'rejected'] } });
  assert.deepEqual(body.map(row => [row.merchantId, row.salonId, row.salonName, row.id, row.promotionReviewStatus]), [
    ['m2', 's2', 'Two', 'c', 'approved'],
    ['m2', 's2', 'Two', 'd', 'rejected'],
    ['m1', 's1', 'One', 'a', 'pending'],
  ]);
  // The fields the review table renders.
  assert.equal(body[2].name, 'Service a');
  assert.equal(body[2].priceFen, 8800);
  assert.deepEqual(body[2].tags, ['男士']);
  assert.equal(body[2].imageUrls.length, 1);
});

test('service promotions skip the merchant lookup when nothing is requested', async () => {
  const routes = adminRoutes({
    Salon: { find: () => query([]) },
    MerchantUser: { find() { throw new Error('unexpected query'); } },
  });
  let body;
  await routes.get('get:/api/admin/service-promotions')({ query: {} }, { json(value) { body = value; } });
  assert.deepEqual(body, []);
});

test('merchant summary carries the list card fields and nothing heavy', () => {
  const { buildAdminMerchantSummary } = require('../../index');
  const submittedAt = new Date('2026-11-01T00:00:00Z');
  const summary = buildAdminMerchantSummary(
    { ...user, deposit: 500, createdAt: submittedAt },
    {
      id: 'salon-1', name: 'Live name', address: 'Live road', phone: '111', tags: ['热门'],
      businessDistrict: '', isFeatured: true, publishStatus: 'online', licenseStatus: 'approved',
      contentReviewStatus: 'pending', updatedAt: submittedAt,
      pendingContent: { name: 'Draft name', phone: '222' },
      services: [{ id: 'service-1' }], staffIds: ['staff-1'],
    },
  );

  assert.equal(summary.id, 'merchant-1');
  assert.equal(summary.salonId, 'salon-1');
  assert.equal(summary.deposit, 500);
  assert.equal(summary.salonName, 'Live name');
  assert.equal(summary.publishStatus, 'online');
  assert.equal(summary.licenseStatus, 'approved');
  assert.equal(summary.contentReviewStatus, 'pending');
  // No explicit submission time: a pending draft falls back to the salon's last update, as in the full payload.
  assert.equal(summary.contentSubmittedAt, submittedAt);
  assert.deepEqual(summary.salon, {
    id: 'salon-1', name: 'Draft name', address: 'Live road', phone: '222', tags: ['热门'],
    businessDistrict: '', isFeatured: true,
  });
  assert.equal(JSON.stringify(summary).includes('service-1'), false);
  assert.equal(JSON.stringify(summary).includes('staff-1'), false);
});

test('merchant summary tolerates a merchant whose salon is missing', () => {
  const { buildAdminMerchantSummary } = require('../../index');
  const summary = buildAdminMerchantSummary(user, undefined);
  assert.equal(summary.publishStatus, 'offline');
  assert.equal(summary.licenseStatus, 'unsubmitted');
  assert.deepEqual(summary.salon.tags, []);
});

test('view=summary returns summaries without loading stylists, ratings or full salons', async () => {
  let projection;
  const fail = () => { throw new Error('unexpected call'); };
  const routes = adminRoutes({
    MerchantUser: { find: () => query([{ id: 'm1', salonId: 's1' }]), countDocuments: async () => 1 },
    Salon: { find: () => ({ ...query([{ id: 's1', name: 'One' }]), select(value) { projection = value; return this; } }) },
    normalizePagination: () => ({ page: 1, limit: 100, skip: 0 }),
    setPaginationHeaders() {},
    ADMIN_MERCHANT_SUMMARY_SALON_PROJECTION: 'summary-projection',
    buildAdminMerchantSummary: (merchant, salonValue) => ({ id: merchant.id, salonName: salonValue.name }),
    buildAdminMerchantPayload: fail,
    getStaffMapByIds: fail,
    getApprovedRatingSummariesByStaffIds: fail,
  });

  let body;
  await routes.get('get:/api/admin/merchants')({ query: { view: 'summary' } }, { json(value) { body = value; } });

  assert.equal(projection, 'summary-projection');
  assert.deepEqual(body, [{ id: 'm1', salonName: 'One' }]);
});

test('single merchant endpoint returns the full payload or 404', async () => {
  const routes = adminRoutes({
    MerchantUser: { findOne: ({ id }) => query(id === 'm1' ? { id: 'm1', salonId: 's1' } : null) },
    Salon: { findOne: () => query({ id: 's1' }) },
    buildAdminMerchantPayload: async (merchant, salonValue) => ({ id: merchant.id, salon: salonValue }),
  });
  const respond = () => ({ status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; } });

  const found = respond();
  await routes.get('get:/api/admin/merchants/:id')({ params: { id: 'm1' } }, found);
  assert.deepEqual(found.body, { merchant: { id: 'm1', salon: { id: 's1' } } });

  const missing = respond();
  await routes.get('get:/api/admin/merchants/:id')({ params: { id: 'nope' } }, missing);
  assert.equal(missing.statusCode, 404);
});
