const assert = require('node:assert/strict');
const test = require('node:test');
const registerAdminRoutes = require('./admin');
const { bookingDayRange } = require('../services/booking');

test('admin overview separates total clients from clients created yesterday', async () => {
  const routes = new Map();
  const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map(method => [
    method,
    (path, ...handlers) => routes.set(`${method}:${path}`, handlers.at(-1)),
  ]));
  let yesterdayQuery;
  let funnelPipeline;
  const counts = { countDocuments: async () => 0 };
  registerAdminRoutes(app, {
    rateLimits: { upload: [] },
    MerchantUser: counts,
    ClientUser: {
      async countDocuments(query) {
        if (!query) return 20;
        yesterdayQuery = query;
        return 3;
      },
    },
    Salon: counts,
    Booking: counts,
    AnalyticsEvent: {
      async aggregate(pipeline) {
        funnelPipeline = pipeline;
        return [];
      },
    },
  });

  let payload;
  await routes.get('get:/api/admin/overview')({}, { json(value) { payload = value; } });

  const today = bookingDayRange();
  const yesterday = {
    start: new Date(today.start.getTime() - 24 * 60 * 60 * 1000),
    end: today.start,
  };
  assert.deepEqual(yesterdayQuery, {
    createdAt: { $gte: yesterday.start, $lt: yesterday.end },
  });
  assert.deepEqual(funnelPipeline[0], {
    $match: { createdAt: { $gte: yesterday.start, $lt: yesterday.end } },
  });
  assert.equal(payload.clientCount, 20);
  assert.equal(payload.yesterdayNewClientCount, 3);
});
