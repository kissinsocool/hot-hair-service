const test = require('node:test');
const assert = require('node:assert/strict');
const registerPublicRoutes = require('./routes/public');

test('GET /api/salons returns ten-item pages and a has-more header', async () => {
  const routes = new Map();
  const app = {
    get(path, ...handlers) { routes.set(path, handlers.at(-1)); }
  };
  const calls = [];
  const priceLookups = [];
  registerPublicRoutes(app, {
    rateLimits: { publicRead: [] },
    getCoordinates: () => ({ latitude: 39.9042, longitude: 116.4074 }),
    normalizeRadiusKm: (_value, fallback) => fallback,
    normalizeLimit: (value, fallback = 50, max = 100) => Math.min(Number(value) || fallback, max),
    normalizePagination: (query, fallback) => ({
      page: Number(query.page) || 1,
      limit: Number(query.limit) || fallback,
      skip: ((Number(query.page) || 1) - 1) * (Number(query.limit) || fallback)
    }),
    async getNearbySalons(_location, _radius, limit, _minResults, _maxRadius, skip) {
      calls.push({ limit, skip });
      return Array.from({ length: limit }, (_, index) => ({
        id: `salon-${skip + index}`,
        name: `店铺 ${skip + index}`
      }));
    },
    addApprovedSalonRatings: async (salons) => salons,
    async getCutPriceFromFenBySalonIds(salonIds) {
      priceLookups.push(salonIds);
      return new Map([['salon-10', 6800], ['salon-11', undefined]]);
    },
    stripSensitiveSalonFields: (salon) => salon,
    existingSalonImages: async () => [],
    salonCoverImage: async () => ''
  });

  const headers = {};
  let payload;
  await routes.get('/api/salons')(
    { query: { latitude: '39.9042', longitude: '116.4074', page: '2', limit: '10' } },
    {
      set(name, value) {
        if (typeof name === 'object') Object.assign(headers, name);
        else headers[name] = value;
      },
      json(value) { payload = value; }
    }
  );

  assert.deepEqual(calls, [{ limit: 11, skip: 10 }]);
  assert.equal(payload.length, 10);
  assert.deepEqual(priceLookups, [Array.from({ length: 10 }, (_, index) => `salon-${10 + index}`)]);
  assert.equal(payload[0].cutPriceFromFen, 6800);
  assert.equal('cutPriceFromFen' in payload[1], false);
  assert.equal('cutPriceFromFen' in payload[2], false);
  assert.equal(headers['X-Has-More'], 'true');
  assert.equal(headers['X-Page'], '2');
  assert.equal(headers['X-Page-Size'], '10');
});

test('GET /api/salons forwards optional rating sort without changing default requests', async () => {
  const routes = new Map();
  const sorts = [];
  registerPublicRoutes({ get(path, ...handlers) { routes.set(path, handlers.at(-1)); } }, {
    rateLimits: { publicRead: [] },
    getCoordinates: () => ({ latitude: 1, longitude: 2 }),
    normalizeRadiusKm: (_value, fallback) => fallback,
    normalizeLimit: (_value, fallback) => fallback,
    normalizePagination: () => ({ page: 1, limit: 10, skip: 0 }),
    async getNearbySalons(...args) { sorts.push(args.at(-1)); return []; },
    addApprovedSalonRatings: async salons => salons,
    getCutPriceFromFenBySalonIds: async () => new Map(),
    stripSensitiveSalonFields: salon => salon,
    existingSalonImages: async () => [],
    salonCoverImage: async () => ''
  });
  const response = { set() {}, json() {} };
  await routes.get('/api/salons')({ query: {} }, response);
  await routes.get('/api/salons')({ query: { sort: 'rating' } }, response);
  assert.deepEqual(sorts, ['distance', 'rating']);
});

test('cutPriceFromFen is the lowest price among the services the clients list under 剪发', () => {
  const { cutPriceFromFen } = require('./services/salon');
  assert.equal(cutPriceFromFen([
    { priceFen: 3800, tagIds: ['color'] },
    { priceFen: 9800, tagIds: ['wash_cut_blow', 'women'] },
    { priceFen: 6800, tagIds: ['wash_cut_blow', 'men'] },
    { priceFen: 2000, tagIds: ['scalp_care'] },
    { priceFen: 1500, tagIds: ['care'] },
    { priceFen: 1200, tagIds: ['nutrition'] },
    { priceFen: 1000, tags: ['烫发'] },
    { priceFen: 0, tagIds: ['wash_cut_blow'] },
  ]), 6800);
  assert.equal(cutPriceFromFen([{ priceFen: 5000 }]), 5000, 'an untagged service is a haircut service');
  assert.equal(cutPriceFromFen([{ priceFen: 5000, tags: ['洗剪吹'] }]), 5000);
  assert.equal(cutPriceFromFen([{ priceFen: 3800, tagIds: ['perm'] }]), undefined);
  assert.equal(cutPriceFromFen([]), undefined);
  assert.equal(cutPriceFromFen(undefined), undefined);
});
