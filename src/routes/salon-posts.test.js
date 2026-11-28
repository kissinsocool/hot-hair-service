const assert = require('node:assert/strict');
const test = require('node:test');
const registerMerchantRoutes = require('./merchant');
const registerPublicRoutes = require('./public');
const registerAdminRoutes = require('./admin');
const { postPayload, promotionCategoryForPost, salonAuthorFields, validatePostInput } = require('../services/salon-posts');
const { SalonPost: SalonPostModel } = require('../models');

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
    authorType: 'staff',
    authorStaffId: 'staff-1',
    content: '新发型',
    imageUrls: ['https://example.com/1.jpg'],
    serviceId: 'service-1',
    promotionCategoryId: null,
  });
  assert.equal(validatePostInput({ authorStaffId: 'staff-1', content: '旧客户端', imageUrls: [] }).value.serviceId, '');
});

test('salon post input accepts only known promotion categories and keeps legacy requests without one', () => {
  const base = { authorStaffId: 'staff-1', content: '新发型', imageUrls: [] };
  assert.equal(validatePostInput({ ...base, promotionCategoryId: 'curly' }).value.promotionCategoryId, 'curly');
  // 旧版商家端不传：返回 null，发布时按关联套餐推算。
  assert.equal(validatePostInput(base).value.promotionCategoryId, null);
  assert.equal(validatePostInput({ ...base, promotionCategoryId: null }).value.promotionCategoryId, null);
  for (const invalid of ['', 'perm', '__proto__', 'constructor', ['color'], 1]) {
    assert.equal(validatePostInput({ ...base, promotionCategoryId: invalid }).error, '请选择推广分类');
  }
});

test('post promotion category is the merchant choice, or derived from the related service for legacy clients', () => {
  assert.equal(promotionCategoryForPost('care', { tagIds: ['color'] }), 'care');
  assert.equal(promotionCategoryForPost('men-cut', null), 'men-cut');
  // 旧版商家端：按关联套餐标签推算，与字段上线前的分类规则一致。
  assert.equal(promotionCategoryForPost(null, { tagIds: ['wash_cut_blow', 'women'] }), 'women-cut');
  assert.equal(promotionCategoryForPost(null, { tagIds: ['men', 'color'] }), 'color');
  assert.equal(promotionCategoryForPost(null, { tagIds: ['wash_blow'] }), '');
  assert.equal(promotionCategoryForPost(null, null), '');
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
        id: 'salon-1', staffIds: ['staff-1'], services: [{ id: 'service-1', name: '剪发套餐', tagIds: ['curly'] }],
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
    body: { authorStaffId: 'staff-1', content: '今日作品', imageUrls: [], serviceId: 'service-1', promotionCategoryId: 'color' },
  }, res);
  assert.equal(res.statusCode, 201);
  // 商家选的推广分类优先，不看关联套餐的标签（curly）。
  assert.equal(created[0].promotionCategoryId, 'color');
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
  assert.equal(created[1].promotionCategoryId, '');
  // 旧版商家端不带 authorType：仍按理发师投稿处理。
  assert.equal(created[1].authorType, 'staff');
  assert.equal(created[1].authorStaffId, 'staff-1');
  // 旧版商家端关联了套餐但不带推广分类：按套餐标签推算。
  const legacyWithService = response();
  await routes.get('post:/api/merchant/salon-posts')({
    merchantUser: { salonId: 'salon-1' },
    body: { authorStaffId: 'staff-1', content: '旧客户端卷发', imageUrls: [], serviceId: 'service-1' },
  }, legacyWithService);
  assert.equal(legacyWithService.statusCode, 201);
  assert.equal(created[2].promotionCategoryId, 'curly');
  const badCategory = response();
  await routes.get('post:/api/merchant/salon-posts')({
    merchantUser: { salonId: 'salon-1' },
    body: { authorStaffId: 'staff-1', content: '今日作品', imageUrls: [], promotionCategoryId: 'perm' },
  }, badCategory);
  assert.equal(badCategory.statusCode, 400);
  assert.equal(created.length, 3);
});

test('salon post input accepts the salon itself as author and ignores any staff id', () => {
  assert.deepEqual(validatePostInput({
    authorType: 'salon', authorStaffId: 'staff-1', content: '店铺活动', imageUrls: [],
  }).value, { authorType: 'salon', authorStaffId: '', content: '店铺活动', imageUrls: [], serviceId: '', promotionCategoryId: null });
  assert.equal(validatePostInput({ authorType: 'salon', content: '店铺活动', imageUrls: [] }).error, undefined);
  assert.equal(validatePostInput({ authorType: 'staff', content: '动态', imageUrls: [] }).error, '请选择投稿人');
  assert.equal(validatePostInput({ authorType: 'admin', authorStaffId: 'staff-1', content: '动态', imageUrls: [] }).error, '投稿人类型无效');
  assert.equal(validatePostInput({ authorType: ['salon'], content: '动态', imageUrls: [] }).error, '投稿人类型无效');
});

test('merchant can publish as the salon itself, even with no staff', async () => {
  const routes = new Map();
  const app = Object.fromEntries(['get', 'post', 'patch', 'delete'].map(method => [
    method,
    (path, ...handlers) => routes.set(`${method}:${path}`, handlers.at(-1)),
  ]));
  const created = [];
  let salon = {
    id: 'salon-1', name: '热辣发廊', staffIds: [], image: '', promoImages: ['https://example.com/promo.jpg'],
    images: ['https://example.com/shop.jpg'], services: [{ id: 'service-1', name: '剪发套餐' }],
  };
  registerMerchantRoutes(app, {
    rateLimits: new Proxy({}, { get: () => [] }),
    normalizePagination: () => ({ page: 1, limit: 20, skip: 0 }),
    Salon: { findOne: () => ({ select: () => ({ lean: async () => salon }) }) },
    getStaffById: () => { throw new Error('staff must not be looked up for a salon post'); },
    SalonPost: {
      create: async post => {
        // 用真实 Schema 校验：店铺投稿没有 authorStaffId / authorRoleId 也必须能保存。
        await new SalonPostModel(post).validate();
        created.push(post);
        return { toObject: () => ({ ...post, createdAt: new Date('2026-11-17T10:00:00Z') }) };
      },
    },
    validateSalonPostInput: validatePostInput,
    salonPostSalonAuthor: salonAuthorFields,
    salonPostPayload: postPayload,
    publicImageUrl: value => value,
    crypto: { randomUUID: () => 'post-salon' },
    clearPublicSalonDetailCache: () => {},
  });

  const res = response();
  await routes.get('post:/api/merchant/salon-posts')({
    merchantUser: { salonId: 'salon-1' },
    body: {
      authorType: 'salon', authorStaffId: 'someone-else', content: '周年店庆', imageUrls: [], serviceId: 'service-1',
      promotionCategoryId: 'women-cut',
    },
  }, res);
  assert.equal(res.statusCode, 201);
  // 推广分类经真实 Schema 校验后保存，并在响应里返回给商家端。
  assert.equal(created[0].promotionCategoryId, 'women-cut');
  assert.equal(res.body.promotionCategoryId, 'women-cut');
  assert.equal(created[0].authorType, 'salon');
  assert.equal(created[0].authorStaffId, '');
  assert.equal(created[0].authorName, '热辣发廊');
  assert.equal(created[0].authorImageUrl, 'https://example.com/promo.jpg');
  assert.equal('authorRoleId' in created[0], false);
  assert.equal(created[0].serviceName, '剪发套餐');
  assert.deepEqual(
    [res.body.authorType, res.body.authorStaffId, res.body.authorName, res.body.authorRoleId],
    ['salon', '', '热辣发廊', ''],
  );

  salon = { ...salon, name: ' ' };
  const unnamed = response();
  await routes.get('post:/api/merchant/salon-posts')({
    merchantUser: { salonId: 'salon-1' },
    body: { authorType: 'salon', content: '周年店庆', imageUrls: [] },
  }, unnamed);
  assert.equal(unnamed.statusCode, 400);
  assert.equal(created.length, 1);
});

test('salon post schema still requires a staff author unless the salon is the author', async () => {
  const base = { id: 'post-x', salonId: 'salon-1', authorName: '小林', content: '动态' };
  await assert.rejects(new SalonPostModel(base).validate(), /authorStaffId/);
  await assert.rejects(new SalonPostModel({ ...base, authorStaffId: 'staff-1' }).validate(), /authorRoleId/);
  const legacyShape = new SalonPostModel({ ...base, authorStaffId: 'staff-1', authorRoleId: 'senior_barber' });
  await legacyShape.validate();
  assert.equal(legacyShape.authorType, 'staff');
});

test('posts stored before authorType existed are returned as staff posts', () => {
  const payload = postPayload({
    id: 'post-old', salonId: 'salon-1', authorStaffId: 'staff-1', authorName: '小林',
    authorRoleId: 'senior_barber', content: '旧动态', imageUrls: [],
  });
  assert.equal(payload.authorType, 'staff');
  assert.equal(payload.authorStaffId, 'staff-1');
  assert.equal(payload.authorRoleId, 'senior_barber');
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
    countPostFavorites: async (id) => { assert.equal(id, 'post-1'); return 3; },
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
  assert.deepEqual(found.body, { id: 'post-1', salonId: 'salon-1', imageUrls: [], payload: true, favoriteCount: 3 });
  assert.equal(found.cacheControl, 'no-store');
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
    HomeRecommendationConfig: { findOne: () => ({ select: () => ({ lean: async () => null }) }) },
    readRecommendedPosts: async (options, deps) => {
      calls.push(options);
      assert.equal(typeof deps.cache.get, 'function', '与用户无关的部分走共用缓存');
      return { categoryId: 'color', items: [{ id: 'post-1', reasons: [] }] };
    },
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

test('home recommended services route resolves the viewer and never allows shared caching', async () => {
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
    HomeRecommendationConfig: { findOne: () => ({ select: () => ({ lean: async () => null }) }) },
    readRecommendedServices: async (options, deps) => {
      calls.push(options);
      assert.equal(typeof deps.cache.get, 'function', '附近店铺的查询走共用缓存');
      return { categoryId: 'color', items: [{ id: 'salon-1:svc-1', reasons: [] }] };
    },
  });
  const recommend = async (req) => {
    const res = response();
    res.set = function set(name, value) { this.cacheControl = value; return this; };
    await routes.get('/api/salons/recommended-services')(req, res);
    return res;
  };

  assert.equal((await recommend({ query: {} })).statusCode, 400);
  assert.equal(calls.length, 0);

  const guest = await recommend({ query: { latitude: '39.9', longitude: '116.4', limit: '99', viewedSalonIds: ' s1 ,,s2' } });
  assert.deepEqual(guest.body, { categoryId: 'color', items: [{ id: 'salon-1:svc-1', reasons: [] }] });
  assert.equal(guest.cacheControl, 'private, no-store');
  assert.deepEqual(calls[0], {
    userLocation: { latitude: 39.9, longitude: 116.4 }, limit: 20, viewerId: '', viewedSalonIds: ['s1', 's2'],
  });
  assert.equal(userQueries.length, 0, '未登录不查用户');

  await recommend({ query: { latitude: '39.9', longitude: '116.4' }, token: 'valid' });
  assert.deepEqual(userQueries[0], { sessionTokenHash: 'hash:valid', authProvider: 'wechat' });
  assert.equal(calls[1].viewerId, 'u1');
  assert.equal(calls[1].limit, 10);
  // 登录态失效时按未登录处理，不报错。
  await recommend({ query: { latitude: '39.9', longitude: '116.4' }, token: 'expired' });
  assert.equal(calls[2].viewerId, '');
});

test('the admin switch hides home recommendations at once and shows them again when turned back on', async () => {
  const { createPublicResponseCaches } = require('../ttl-cache');
  const routes = new Map();
  const app = Object.fromEntries(['get', 'post', 'patch', 'delete', 'put'].map(method => [
    method,
    (path, ...handlers) => routes.set(`${method}:${path}`, handlers.at(-1)),
  ]));
  const publicResponseCaches = createPublicResponseCaches();
  let stored = null;
  let configReads = 0;
  let recommendationReads = 0;
  const HomeRecommendationConfig = {
    findOne: () => ({ select: () => ({ lean: async () => { configReads += 1; return stored; } }) }),
    findOneAndUpdate(filter, update, options) {
      assert.deepEqual(filter, { key: 'main' });
      assert.equal(options.upsert, true);
      stored = { key: 'main', ...update };
      return { lean: async () => stored };
    },
  };
  registerPublicRoutes(app, {
    rateLimits: { publicRead: [] },
    publicResponseCaches,
    getCoordinates: query => (query.latitude ? { latitude: 39.9, longitude: 116.4 } : null),
    normalizeLimit: (_value, fallback) => fallback,
    sessionTokenFromRequest: () => '',
    HomeRecommendationConfig,
    readRecommendedServices: async () => { recommendationReads += 1; return { categoryId: '', items: [{ id: 'salon-1:svc-1' }] }; },
    readRecommendedPosts: async () => { recommendationReads += 1; return { categoryId: '', items: [{ id: 'post-1', reasons: [] }] }; },
  });
  registerAdminRoutes(app, {
    rateLimits: new Proxy({}, { get: () => [] }),
    HomeRecommendationConfig,
    clearHomeRecommendationConfigCache: () => publicResponseCaches.homeRecommendationConfig.clear(),
  });
  const call = async (route, req = {}) => {
    const res = response();
    res.set = function set() { return this; };
    await routes.get(route)({ query: {}, body: {}, adminUser: { id: 'admin-1' }, ...req }, res);
    return res;
  };
  const location = { latitude: '39.9', longitude: '116.4' };
  const services = () => call('get:/api/salons/recommended-services', { query: location });

  // 没有设置过：默认显示。开关读一次后复用，不是每次请求都查。
  assert.deepEqual((await call('get:/api/admin/home-recommendations')).body, { enabled: true });
  assert.equal((await services()).body.items.length, 1);
  assert.equal((await services()).body.items.length, 1);
  assert.equal(configReads, 2);

  // 只接受布尔值。
  assert.equal((await call('patch:/api/admin/home-recommendations', { body: { enabled: 'false' } })).statusCode, 400);
  assert.equal(stored, null);

  // 关闭：两个推荐接口立即返回空（小程序因此不显示模块），不再查询推荐数据。
  const off = await call('patch:/api/admin/home-recommendations', { body: { enabled: false } });
  assert.deepEqual(off.body, { enabled: false });
  assert.deepEqual(stored, { key: 'main', enabled: false, updatedBy: 'admin-1' });
  const readsBefore = recommendationReads;
  assert.deepEqual((await services()).body, { categoryId: '', items: [] });
  assert.deepEqual((await call('get:/api/salons/recommended-posts', { query: location })).body, []);
  assert.deepEqual((await call('get:/api/salons/recommended-posts', { query: { ...location, version: '2' } })).body, { categoryId: '', items: [] });
  assert.equal(recommendationReads, readsBefore);
  assert.deepEqual((await call('get:/api/admin/home-recommendations')).body, { enabled: false });
  // 关闭时仍然先校验坐标。
  assert.equal((await call('get:/api/salons/recommended-services')).statusCode, 400);

  // 重新打开后立即恢复。
  await call('patch:/api/admin/home-recommendations', { body: { enabled: true } });
  assert.equal((await services()).body.items.length, 1);
});
