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

test('home recommendations route resolves the viewer and never allows shared caching', async () => {
  const routes = new Map();
  const calls = [];
  const userQueries = [];
  registerPublicRoutes({ get: (path, ...handlers) => routes.set(path, handlers.at(-1)) }, {
    rateLimits: { publicRead: [] },
    getCoordinates: query => (query.latitude ? { latitude: Number(query.latitude), longitude: Number(query.longitude) } : null),
    normalizeLimit: (value, fallback, max) => Math.min(Number(value) || fallback, max),
    sessionTokenFromRequest: req => req.token || '',
    activeSessionQuery: token => ({ sessionTokenHash: `hash:${token}` }),
    normalizeUserId: id => String(id).replace(/^user-/, ''),
    ClientUser: { findOne(query) {
      userQueries.push(query);
      return { select: () => ({ lean: async () => (query.sessionTokenHash === 'hash:valid' ? { id: 'user-u1' } : null) }) };
    } },
    readRecommendedPosts: async (options) => { calls.push(options); return { categoryId: 'color', items: [{ id: 'post-1', reasons: [] }] }; },
  });
  const recommend = async (req) => {
    const res = response();
    res.set = function set(name, value) { this.cacheControl = value; return this; };
    await routes.get('/api/salons/recommended-posts')(req, res);
    return res;
  };

  assert.equal((await recommend({ query: {} })).statusCode, 400);
  assert.equal(calls.length, 0);

  const legacy = await recommend({ query: { latitude: '39.9', longitude: '116.4', limit: '10' }, token: 'valid' });
  assert.deepEqual(legacy.body, [{ id: 'post-1' }]);
  assert.deepEqual(calls.shift(), {
    userLocation: { latitude: 39.9, longitude: 116.4 }, limit: 10, viewerId: '', viewedSalonIds: [],
  });

  const guest = await recommend({ query: { latitude: '39.9', longitude: '116.4', version: '2', limit: '99', viewedSalonIds: ' s1 ,,s2' } });
  assert.deepEqual(guest.body, { categoryId: 'color', items: [{ id: 'post-1', reasons: [] }] });
  assert.equal(guest.cacheControl, 'private, no-store');
  assert.deepEqual(calls[0], {
    userLocation: { latitude: 39.9, longitude: 116.4 }, limit: 20, viewerId: '', viewedSalonIds: ['s1', 's2'],
  });
  assert.equal(userQueries.length, 0, '未登录不查用户');

  await recommend({ query: { latitude: '39.9', longitude: '116.4', version: '2' }, token: 'valid' });
  assert.deepEqual(userQueries[0], { sessionTokenHash: 'hash:valid', authProvider: 'wechat' });
  assert.equal(calls[1].viewerId, 'u1');
  assert.equal(calls[1].limit, 10);
  // 登录态失效时按未登录处理，不报错。
  await recommend({ query: { latitude: '39.9', longitude: '116.4', version: '2' }, token: 'expired' });
  assert.equal(calls[2].viewerId, '');
});
