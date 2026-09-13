const test = require('node:test');
const assert = require('node:assert/strict');
const registerPublicRoutes = require('./routes/public');

test('GET /api/salons returns ten-item pages and a has-more header', async () => {
  const routes = new Map();
  const app = {
    get(path, ...handlers) { routes.set(path, handlers.at(-1)); }
  };
  const calls = [];
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
  assert.equal(headers['X-Has-More'], 'true');
  assert.equal(headers['X-Page'], '2');
  assert.equal(headers['X-Page-Size'], '10');
});
