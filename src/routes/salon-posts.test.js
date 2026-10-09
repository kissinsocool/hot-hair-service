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
  }).value, {
    authorStaffId: 'staff-1',
    content: '新发型',
    imageUrls: ['https://example.com/1.jpg'],
  });
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
      findOne: () => ({ select: () => ({ lean: async () => ({ id: 'salon-1', staffIds: ['staff-1'] }) }) }),
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
    body: { authorStaffId: 'staff-1', content: '今日作品', imageUrls: [] },
  }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(created[0].authorName, '小林');
  assert.equal(created[0].salonId, 'salon-1');
  assert.equal(created[0].reviewStatus, 'pending');
  assert.equal(res.body.id, 'post-1');
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
        assert.deepEqual(filter, { salonId: 'salon-1', reviewStatus: 'approved' });
        return query;
      },
      countDocuments: async () => 11,
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
  await routes.get('/api/salons/:id/posts')({ params: { id: 'salon-1' }, query: {} }, res);
  assert.deepEqual(res.headers, { page: 2, total: 11 });
  assert.equal(res.body[0].id, 'post-11');
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
