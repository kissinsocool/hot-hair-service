const assert = require('node:assert/strict');
const test = require('node:test');
const registerMerchantRoutes = require('./merchant');
const registerPublicRoutes = require('./public');
const registerAdminRoutes = require('./admin');
const { validatePostInput } = require('../services/salon-posts');

const response = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return body; },
});

test('salon post input keeps the actual merchant contract bounded', () => {
  assert.equal(validatePostInput({ authorStaffId: '', content: '动态', imageUrls: [] }).error, '请选择投稿人');
  assert.equal(validatePostInput({ authorStaffId: 'staff-1', content: ' ', imageUrls: [] }).error, '请输入动态文字');
  assert.equal(validatePostInput({
    authorStaffId: 'staff-1',
    content: '新发型',
    imageUrls: Array.from({ length: 10 }, (_, index) => `https://example.com/${index}.jpg`),
  }).error, '动态图片不能超过9张');
  assert.deepEqual(validatePostInput({
    authorStaffId: ' staff-1 ',
    content: ' 新发型 ',
    imageUrls: ['https://example.com/1.jpg', 'https://example.com/1.jpg'],
    serviceId: ' service-1 ',
  }).value, {
    authorStaffId: 'staff-1',
    content: '新发型',
    imageUrls: ['https://example.com/1.jpg'],
    serviceId: 'service-1',
  });
  assert.equal(validatePostInput({ authorStaffId: 'staff-1', content: '旧客户端', imageUrls: [] }).value.serviceId, '');
});

test('merchant can publish only as a staff member from the same salon', async () => {
  const routes = new Map();
  const app = Object.fromEntries(['get', 'post', 'patch', 'delete'].map(method => [
    method,
    (path, ...handlers) => routes.set(`${method}:${path}`, handlers.at(-1)),
  ]));
  const created = [];
  registerMerchantRoutes(app, {
    rateLimits: new Proxy({}, { get: () => [] }),
    normalizePagination: () => ({ page: 1, limit: 20, skip: 0 }),
    Salon: {
      findOne: () => ({ select: () => ({ lean: async () => ({
        id: 'salon-1', staffIds: ['staff-1'], services: [{ id: 'service-1', name: '剪发套餐' }],
      }) }) }),
    },
    getStaffById: id => ({ lean: async () => ({
      id,
      name: '小林',
      roleId: 'senior_barber',
      imageUrl: 'https://example.com/staff.jpg',
    }) }),
    SalonPost: {
      create: async post => {
        created.push(post);
        return { toObject: () => ({ ...post, createdAt: new Date('2026-09-24T10:00:00Z') }) };
      },
    },
    validateSalonPostInput: validatePostInput,
    salonPostPayload: post => post,
    publicImageUrl: value => value,
    crypto: { randomUUID: () => 'post-1' },
    clearPublicSalonDetailCache: () => {},
  });

  const res = response();
  await routes.get('post:/api/merchant/salon-posts')({
    merchantUser: { salonId: 'salon-1' },
    body: { authorStaffId: 'staff-1', content: '今日作品', imageUrls: [], serviceId: 'service-1' },
  }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(created[0].authorName, '小林');
  assert.equal(created[0].salonId, 'salon-1');
  assert.equal(created[0].reviewStatus, 'pending');
  assert.equal(created[0].serviceName, '剪发套餐');
  assert.equal(res.body.id, 'post-1');
  const invalid = response();
  await routes.get('post:/api/merchant/salon-posts')({
    merchantUser: { salonId: 'salon-1' },
    body: { authorStaffId: 'staff-1', content: '今日作品', imageUrls: [], serviceId: 'other-salon-service' },
  }, invalid);
  assert.equal(invalid.statusCode, 400);
  assert.equal(created.length, 1);
  const legacy = response();
  await routes.get('post:/api/merchant/salon-posts')({
    merchantUser: { salonId: 'salon-1' },
    body: { authorStaffId: 'staff-1', content: '旧客户端动态', imageUrls: [] },
  }, legacy);
  assert.equal(legacy.statusCode, 201);
  assert.equal(created[1].serviceId, '');
});

test('public salon posts are scoped to an online salon and paginated newest first', async () => {
  const routes = new Map();
  const app = { get: (path, ...handlers) => routes.set(path, handlers.at(-1)) };
  const query = {
    sort(value) { assert.deepEqual(value, { createdAt: -1, _id: -1 }); return this; },
    skip(value) { assert.equal(value, 10); return this; },
    limit(value) { assert.equal(value, 10); return this; },
    async lean() { return [{ id: 'post-11', salonId: 'salon-1', imageUrls: [] }]; },
  };
  let expectedFilter = { salonId: 'salon-1', reviewStatus: 'approved' };
  registerPublicRoutes(app, {
    rateLimits: { publicRead: [] },
    Salon: {
      findOne(filter) {
        assert.deepEqual(filter, { id: 'salon-1', publishStatus: 'online' });
        return { select: () => ({ lean: async () => ({ id: 'salon-1' }) }) };
      },
    },
    SalonPost: {
      find: filter => {
        assert.deepEqual(filter, expectedFilter);
        return query;
      },
      countDocuments: async filter => {
        assert.deepEqual(filter, expectedFilter);
        return 11;
      },
    },
    normalizePagination: () => ({ page: 2, limit: 10, skip: 10 }),
    setPaginationHeaders(res, pagination, total) {
      res.headers = { page: pagination.page, total };
    },
    salonPostPayload: post => post,
    publicImageUrl: value => value,
  });
  const res = response();
  res.set = function set() { return this; };
  const list = routes.get('/api/salons/:id/posts');
  await list({ params: { id: 'salon-1' }, query: { page: '2', limit: '10' } }, res);
  assert.deepEqual(res.headers, { page: 2, total: 11 });
  assert.equal(res.body[0].id, 'post-11');
  expectedFilter = { ...expectedFilter, authorStaffId: 'staff-1' };
  await list({ params: { id: 'salon-1' }, query: { page: '2', limit: '10', authorStaffId: 'staff-1' } }, res);
});

test('salon detail returns up to ten latest posts and flags more only beyond ten', async () => {
  const routes = new Map();
  const app = { get: (path, ...handlers) => routes.set(path, handlers.at(-1)) };
  let stored = [];
  let requestedLimit;
  registerPublicRoutes(app, {
    rateLimits: { publicRead: [] },
    Salon: { findOne: () => ({ select: () => ({ lean: async () => ({ id: 'salon-1' }) }) }) },
    buildPublicSalonDetail: async () => ({ id: 'salon-1', reviews: [] }),
    addReviewHelpfulState: async reviews => reviews,
    sessionTokenFromRequest: () => '',
    SalonPost: {
      find(filter) {
        assert.deepEqual(filter, { salonId: 'salon-1', reviewStatus: 'approved' });
        return {
          sort(value) { assert.deepEqual(value, { createdAt: -1, _id: -1 }); return this; },
          limit(value) { requestedLimit = value; return this; },
          async lean() { return stored.slice(0, requestedLimit); },
        };
      },
    },
    salonPostPayload: post => post,
    publicImageUrl: value => value,
  });
  const detail = async (count) => {
    stored = Array.from({ length: count }, (_, index) => ({ id: `post-${index + 1}` }));
    const res = response();
    res.set = function set() { return this; };
    await routes.get('/api/salons/:id')({ params: { id: 'salon-1' }, query: {} }, res);
    return res.body;
  };
  const few = await detail(3);
  assert.equal(requestedLimit, 11);
  assert.equal(few.latestPosts.length, 3);
  assert.equal(few.hasMorePosts, false);
  const exactlyTen = await detail(10);
  assert.equal(exactlyTen.latestPosts.length, 10);
  assert.equal(exactlyTen.hasMorePosts, false);
  const many = await detail(25);
  assert.deepEqual(many.latestPosts.map(post => post.id), Array.from({ length: 10 }, (_, index) => `post-${index + 1}`));
  assert.equal(many.hasMorePosts, true);
});

test('a single public salon post is served only when approved and owned by the online salon', async () => {
  const routes = new Map();
  const app = { get: (path, ...handlers) => routes.set(path, handlers.at(-1)) };
  const postFilters = [];
  registerPublicRoutes(app, {
    rateLimits: { publicRead: [] },
    Salon: {
      findOne(filter) {
        assert.equal(filter.publishStatus, 'online');
        return { select: () => ({ lean: async () => (filter.id === 'salon-1' ? { id: 'salon-1' } : null) }) };
      },
    },
    SalonPost: {
      findOne(filter) {
        postFilters.push(filter);
        return { lean: async () => (filter.id === 'post-1' ? { id: 'post-1', salonId: 'salon-1', imageUrls: [] } : null) };
      },
    },
    salonPostPayload: post => ({ ...post, payload: true }),
    publicImageUrl: value => value,
  });
  const detail = routes.get('/api/salons/:id/posts/:postId');
  const open = async (params) => {
    const res = response();
    res.set = function set(name, value) { this.cacheControl = value; return this; };
    await detail({ params, query: {} }, res);
    return res;
  };
  const found = await open({ id: 'salon-1', postId: 'post-1' });
  assert.equal(found.statusCode, 200);
  assert.deepEqual(found.body, { id: 'post-1', salonId: 'salon-1', imageUrls: [], payload: true });
  assert.equal(found.cacheControl, 'public, max-age=15, stale-while-revalidate=30');
  assert.deepEqual(postFilters[0], { id: 'post-1', salonId: 'salon-1', reviewStatus: 'approved' });
  // 未通过审核、已删除或属于其他店铺的动态都查不到。
  assert.equal((await open({ id: 'salon-1', postId: 'pending-or-other' })).statusCode, 404);
  // 店铺已下线时不再查询动态。
  assert.equal((await open({ id: 'offline', postId: 'post-1' })).statusCode, 404);
  assert.equal(postFilters.length, 2);
});

test('admin approval changes a pending salon post to approved', async () => {
  const routes = new Map();
  const app = Object.fromEntries(['get', 'post', 'patch', 'delete'].map(method => [
    method,
    (path, ...handlers) => routes.set(`${method}:${path}`, handlers.at(-1)),
  ]));
  let update;
  registerAdminRoutes(app, {
    rateLimits: new Proxy({}, { get: () => [] }),
    SalonPost: {
      findOneAndUpdate(filter, nextUpdate) {
        assert.deepEqual(filter, { id: 'post-1' });
        update = nextUpdate;
        return { lean: async () => ({ id: 'post-1', ...nextUpdate.$set, imageUrls: [] }) };
      },
    },
    salonPostPayload: post => post,
    publicImageUrl: value => value,
    clearPublicSalonDetailCache: () => {},
  });
  const res = response();
  await routes.get('patch:/api/admin/salon-posts/:id')({
    params: { id: 'post-1' },
    body: { action: 'approve' },
  }, res);
  assert.equal(update.$set.reviewStatus, 'approved');
  assert.ok(update.$set.reviewedAt instanceof Date);
  assert.equal(res.body.post.reviewStatus, 'approved');
});

test('home recommendations return the nearest salons latest approved post whose service is still on sale', async () => {
  const salonService = require('../services/salon');
  const { postWithSalonPayload } = require('../services/salon-posts');
  const routes = new Map();
  const salonQueries = [];
  const pipelines = [];
  const service = (id, priceFen) => ({ id, name: `套餐${id}`, priceFen, durationMinutes: 30, tagIds: [] });
  const salons = [
    { id: 'near', name: '近店', description: '地铁口', tags: ['近地铁'], image: 'https://example.com/near.jpg',
      services: [service('svc-near', 8800)], geoLocation: { type: 'Point', coordinates: [116.4, 39.9] } },
    // 没有可推荐动态的店铺不出现，也不占名额。
    { id: 'no-post', name: '无动态', services: [service('svc-none', 5000)],
      geoLocation: { type: 'Point', coordinates: [116.41, 39.9] } },
    { id: 'far', name: '远店', services: [service('svc-far', 12000)],
      geoLocation: { type: 'Point', coordinates: [116.5, 39.9] } },
  ];
  registerPublicRoutes({ get: (path, ...handlers) => routes.set(path, handlers.at(-1)) }, {
    rateLimits: { publicRead: [] },
    getCoordinates: salonService.getCoordinates,
    calculateDistanceKm: salonService.calculateDistanceKm,
    normalizeLimit: (value, fallback, max) => Math.min(Number(value) || fallback, max),
    Salon: {
      find(query) {
        salonQueries.push(query);
        return { select() { return this; }, limit() { return this; }, lean: async () => salons };
      },
    },
    SalonPost: {
      aggregate(pipeline) {
        pipelines.push(pipeline);
        return { option: async () => [
          { _id: 'far', post: { id: 'post-far', salonId: 'far', serviceId: 'svc-far', serviceName: '套餐svc-far', content: '远店动态', imageUrls: [] } },
          { _id: 'near', post: { id: 'post-near', salonId: 'near', serviceId: 'svc-near', serviceName: '套餐svc-near', content: '近店动态', imageUrls: [] } },
        ] };
      },
    },
    salonPostWithSalonPayload: postWithSalonPayload,
    publicImageUrl: value => value,
  });
  const recommend = async (query) => {
    const res = response();
    res.set = function set(name, value) { this.cacheControl = value; return this; };
    await routes.get('/api/salons/recommended-posts')({ query }, res);
    return res;
  };

  assert.equal((await recommend({})).statusCode, 400);
  assert.equal(salonQueries.length, 0);

  const found = await recommend({ latitude: '39.9', longitude: '116.4' });
  assert.equal(found.cacheControl, 'public, max-age=15, stale-while-revalidate=30');
  // 只查在线且有套餐的店铺，由近到远。
  assert.equal(salonQueries[0].publishStatus, 'online');
  assert.deepEqual(salonQueries[0].geoLocation.$nearSphere.$geometry.coordinates, [116.4, 39.9]);
  // 每家店只匹配已审核、且关联本店现有套餐的动态，取最新一条。
  assert.deepEqual(pipelines[0][0], { $match: { reviewStatus: 'approved', $or: [
    { salonId: 'near', serviceId: { $in: ['svc-near'] } },
    { salonId: 'no-post', serviceId: { $in: ['svc-none'] } },
    { salonId: 'far', serviceId: { $in: ['svc-far'] } },
  ] } });
  assert.deepEqual(pipelines[0][1], { $sort: { createdAt: -1, _id: -1 } });
  assert.deepEqual(pipelines[0][2], { $group: { _id: '$salonId', post: { $first: '$$ROOT' } } });
  // 结果按店铺距离排序，与收藏接口的套餐条目同结构，另带距离。
  assert.deepEqual(found.body.map(item => item.id), ['post-near', 'post-far']);
  assert.equal(found.body[0].salonName, '近店');
  assert.equal(found.body[0].salonDescription, '地铁口');
  assert.equal(found.body[0].salonImageUrl, 'https://example.com/near.jpg');
  assert.deepEqual(found.body[0].salonTags, ['近地铁']);
  assert.equal(found.body[0].relatedService.id, 'svc-near');
  assert.equal(found.body[0].relatedService.priceFen, 8800);
  assert.equal(found.body[0].distanceKm, 0);
  assert.ok(found.body[1].distanceKm > 8 && found.body[1].distanceKm < 9);

  assert.deepEqual((await recommend({ latitude: '39.9', longitude: '116.4', limit: '1' })).body.map(item => item.id), ['post-near']);

  // 附近店铺都没有套餐时不查询动态。
  salons.forEach((salon) => { salon.services = []; });
  assert.deepEqual((await recommend({ latitude: '39.9', longitude: '116.4' })).body, []);
  assert.equal(pipelines.length, 2);
});
