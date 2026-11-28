const assert = require('node:assert/strict');
const test = require('node:test');
const registerPublicRoutes = require('../routes/public');
const { readCategoryPosts } = require('./category-posts');

const fakeModels = (page) => {
  const pipelines = [];
  return {
    pipelines,
    SalonPost: { aggregate(pipeline) { pipelines.push(pipeline); return { option: async () => [page] }; } },
    Salon: { collection: { name: 'salons' } },
  };
};
const pagination = { page: 2, limit: 30, skip: 30 };

test('category posts come from approved posts with images in the merchant-chosen promotion category', async () => {
  const models = fakeModels({
    items: [{ salonId: 'salon-1', postId: 'post-1', imageUrl: 'a.jpg' }],
    total: [{ count: 31 }],
  });
  const result = await readCategoryPosts({ categoryId: 'women-cut', sort: 'latest', userLocation: null, pagination }, {
    models, publicImageUrl: value => `https://media.example.com/${value}`,
  });
  // 每条动态一张图，id 即动态 ID，点击后按 salonId + postId 打开动态详情。
  assert.deepEqual(result, {
    images: [{ id: 'post-1', salonId: 'salon-1', postId: 'post-1', imageUrl: 'https://media.example.com/a.jpg' }],
    total: 31,
  });

  const [pipeline] = models.pipelines;
  // 按动态上的推广分类筛选，不再看关联套餐的标签。
  assert.deepEqual(pipeline[0], { $match: {
    promotionCategoryId: 'women-cut',
    reviewStatus: 'approved',
    'imageUrls.0': { $exists: true, $nin: ['', null] },
  } });
  assert.ok(!JSON.stringify(pipeline).includes('tagIds'));
  // 只留在线店铺的动态，取第一张图。
  const lookup = pipeline.find(stage => stage.$lookup).$lookup;
  assert.equal(lookup.from, 'salons');
  assert.deepEqual(lookup.pipeline[0].$match, { $expr: { $eq: ['$id', '$$salonId'] }, publishStatus: 'online' });
  assert.deepEqual(pipeline.find(stage => stage.$project).$project.imageUrl, { $arrayElemAt: ['$imageUrls', 0] });
  // 默认按动态发布时间从新到旧，分页在数据库里做。
  assert.deepEqual(pipeline.find(stage => stage.$sort), { $sort: { createdAt: -1, _id: -1 } });
  assert.ok(!pipeline.some(stage => stage.$set));
  const facet = pipeline.at(-1).$facet;
  assert.deepEqual(facet.items.slice(0, 2), [{ $skip: 30 }, { $limit: 30 }]);

  // 按距离：先算店铺距离，再按距离、发布时间排序。
  const nearby = fakeModels({ items: [], total: [] });
  const empty = await readCategoryPosts({
    categoryId: 'color', sort: 'distance', userLocation: { latitude: 39.9, longitude: 116.4 }, pagination,
  }, { models: nearby, publicImageUrl: value => value });
  assert.deepEqual(empty, { images: [], total: 0 });
  assert.equal(nearby.pipelines[0][0].$match.promotionCategoryId, 'color');
  assert.ok(nearby.pipelines[0].some(stage => stage.$set && stage.$set.distanceKm));
  assert.deepEqual(nearby.pipelines[0].find(stage => stage.$sort), {
    $sort: { distanceKm: 1, createdAt: -1, _id: -1 },
  });

  // 不存在的分类不查询。
  const unknown = fakeModels({});
  assert.equal(await readCategoryPosts({ categoryId: '__proto__', sort: 'latest', pagination }, { models: unknown }), null);
  assert.equal(unknown.pipelines.length, 0);
});

test('category posts route validates input and caches only the shared latest order', async () => {
  const routes = new Map();
  const reads = [];
  const totals = [];
  registerPublicRoutes({ get: (path, ...handlers) => routes.set(path, handlers.at(-1)) }, {
    rateLimits: { publicRead: [] },
    normalizePagination: query => ({ page: Number(query.page) || 1, limit: 30, skip: 0 }),
    getCoordinates: value => (value.latitude ? { latitude: 39, longitude: 116 } : null),
    setPaginationHeaders(_res, _pagination, total) { totals.push(total); },
    readCategoryPosts: async (options) => {
      reads.push(options);
      return { images: [{ id: `post-${reads.length}`, salonId: 's', postId: `post-${reads.length}`, imageUrl: 'a.jpg' }], total: 7 };
    },
  });
  const request = async (query) => {
    const res = { statusCode: 200, set(name, value) { this.cacheControl = value; return this; },
      status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
    await routes.get('/api/salons/category-posts')({ query }, res);
    return res;
  };

  assert.equal((await request({ category: 'constructor' })).statusCode, 400);
  assert.equal((await request({})).statusCode, 400);
  assert.equal((await request({ category: 'color', sort: 'distance' })).statusCode, 400);
  assert.equal(reads.length, 0);

  const first = await request({ category: 'men-cut' });
  assert.equal(first.body[0].id, 'post-1');
  assert.equal(first.cacheControl, 'public, max-age=15, stale-while-revalidate=30');
  assert.deepEqual(reads[0], { categoryId: 'men-cut', sort: 'latest', userLocation: null, pagination: { page: 1, limit: 30, skip: 0 } });
  assert.equal((await request({ category: 'men-cut' })).body[0].id, 'post-1');
  assert.equal((await request({ category: 'men-cut', page: '2' })).body[0].id, 'post-2');
  assert.equal((await request({ category: 'color' })).body[0].id, 'post-3');
  const nearby = { category: 'men-cut', sort: 'distance', latitude: '39', longitude: '116' };
  assert.equal((await request(nearby)).body[0].id, 'post-4');
  assert.equal((await request(nearby)).body[0].id, 'post-5');
  assert.deepEqual(reads[3].userLocation, { latitude: 39, longitude: 116 });
  // 命中缓存的页仍然带总数。
  assert.deepEqual(totals, [7, 7, 7, 7, 7, 7]);
});
