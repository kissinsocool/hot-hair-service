const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MIN_CATEGORY_ITEMS,
  PROMOTION_CATEGORY_TAG_IDS,
  parseViewedSalonIds,
  readRecommendedPosts,
  serviceMatchesPromotionCategory,
  servicePromotionCategory,
} = require('./recommended-posts');

const service = (id, tagIds = [], priceFen = 8800) => ({ id, name: `套餐${id}`, priceFen, durationMinutes: 30, tagIds });
const salon = (id, longitude, services, extra = {}) => ({
  id, name: `${id}店`, services, geoLocation: { type: 'Point', coordinates: [longitude, 39.9] }, ...extra,
});
const post = (id, salonId, serviceId, createdAt) => ({
  _id: id, id, salonId, serviceId, serviceName: `套餐${serviceId}`, content: id, imageUrls: [], createdAt: new Date(createdAt),
});

// 模拟数据库：候选店铺按传入顺序（由近到远）返回；动态按 (店铺, 套餐) 取最新一条。
const fakeModels = ({ salons, posts = [], bookings = [], otherSalons = [] }) => {
  const queries = { salons: [], posts: [], bookings: [] };
  const chain = result => ({
    select() { return this; }, sort() { return this; }, limit() { return this; }, lean: async () => result,
  });
  return {
    queries,
    Salon: { find(query) {
      queries.salons.push(query);
      return chain(query.geoLocation ? salons : otherSalons.filter(item => query.id.$in.includes(item.id)));
    } },
    Booking: { find(query) { queries.bookings.push(query); return chain(bookings); } },
    SalonPost: { aggregate(pipeline) {
      queries.posts.push(pipeline);
      const allowed = pipeline[0].$match.$or;
      const latest = new Map();
      [...posts].sort((a, b) => b.createdAt - a.createdAt).forEach((item) => {
        const key = `${item.salonId}\n${item.serviceId}`;
        const ok = allowed.some(filter => filter.salonId === item.salonId && filter.serviceId.$in.includes(item.serviceId));
        if (ok && !latest.has(key)) latest.set(key, item);
      });
      return { option: async () => [...latest.values()]
        .map(item => ({ _id: { salonId: item.salonId, serviceId: item.serviceId }, post: item })) };
    } },
  };
};
const recommend = (models, options = {}, cache = null) => readRecommendedPosts({
  userLocation: { latitude: 39.9, longitude: 116.4 }, limit: 10, ...options,
}, { models, publicImageUrl: value => value, cache });

test('promotion categories match the category finder and pick one interest per service', () => {
  assert.deepEqual(Object.keys(PROMOTION_CATEGORY_TAG_IDS), ['men-cut', 'women-cut', 'color', 'curly', 'straight', 'care']);
  assert.equal(serviceMatchesPromotionCategory('women-cut', ['wash_cut_blow', 'women']), true);
  assert.equal(serviceMatchesPromotionCategory('women-cut', ['wash_cut_blow', 'women', 'color']), false);
  assert.equal(serviceMatchesPromotionCategory('women-cut', ['women']), false);
  assert.equal(serviceMatchesPromotionCategory('men-cut', ['men', 'color']), true);
  assert.equal(serviceMatchesPromotionCategory('constructor', ['men']), false);
  // 烫染护理优先于剪发：男士染发算染发。
  assert.equal(servicePromotionCategory(['men', 'color']), 'color');
  assert.equal(servicePromotionCategory(['wash_cut_blow', 'women']), 'women-cut');
  assert.equal(servicePromotionCategory(['wash_cut_blow', 'men']), 'men-cut');
  assert.equal(servicePromotionCategory(['perm']), '');
  assert.equal(servicePromotionCategory([]), '');

  assert.deepEqual(parseViewedSalonIds(' a ,,b'), ['a', 'b']);
  assert.deepEqual(parseViewedSalonIds(undefined), []);
  assert.deepEqual(parseViewedSalonIds(['a']), []);
  assert.equal(parseViewedSalonIds(Array.from({ length: 30 }, (_, index) => `s${index}`).join(',')).length, 20);
  assert.deepEqual(parseViewedSalonIds(`${'x'.repeat(101)},ok`), ['ok']);
});

test('guests get each nearby salons latest post whose service is still on sale, nearest first', async () => {
  const models = fakeModels({
    salons: [
      salon('near', 116.4, [service('n1'), service('n2')], { description: '地铁口', tags: ['近地铁'], image: 'https://example.com/near.jpg' }),
      // 没有可推荐动态的店铺不出现，也不占名额。
      salon('no-post', 116.41, [service('x1')]),
      salon('far', 116.5, [service('f1')]),
    ],
    posts: [
      post('near-old', 'near', 'n1', '2026-01-01'),
      post('near-new', 'near', 'n2', '2026-02-01'),
      // 关联的套餐已不在店铺的套餐列表里。
      post('near-gone', 'near', 'removed', '2026-03-01'),
      post('far-1', 'far', 'f1', '2026-01-15'),
    ],
  });
  const result = await recommend(models);
  assert.equal(result.categoryId, '');
  assert.deepEqual(result.items.map(item => item.id), ['near-new', 'far-1']);
  const [first, second] = result.items;
  assert.equal(first.salonName, 'near店');
  assert.equal(first.salonDescription, '地铁口');
  assert.equal(first.salonImageUrl, 'https://example.com/near.jpg');
  assert.deepEqual(first.salonTags, ['近地铁']);
  assert.equal(first.relatedService.id, 'n2');
  assert.equal(first.relatedService.priceFen, 8800);
  assert.equal(first.distanceKm, 0);
  assert.ok(second.distanceKm > 8 && second.distanceKm < 9);
  assert.deepEqual(first.reasons, []);

  // 只查在线且有套餐的店铺，由近到远；未登录不查预约。
  assert.equal(models.queries.salons.length, 1);
  assert.equal(models.queries.salons[0].publishStatus, 'online');
  assert.deepEqual(models.queries.salons[0].geoLocation.$nearSphere.$geometry.coordinates, [116.4, 39.9]);
  assert.equal(models.queries.bookings.length, 0);
  // 每家店只匹配已审核、且关联本店现有套餐的动态。
  assert.deepEqual(models.queries.posts[0][0], { $match: { reviewStatus: 'approved', $or: [
    { salonId: 'near', serviceId: { $in: ['n1', 'n2'] } },
    { salonId: 'no-post', serviceId: { $in: ['x1'] } },
    { salonId: 'far', serviceId: { $in: ['f1'] } },
  ] } });
  assert.deepEqual(models.queries.posts[0][1], { $sort: { createdAt: -1, _id: -1 } });

  assert.deepEqual((await recommend(models, { limit: 1 })).items.map(item => item.id), ['near-new']);

  // 附近店铺都没有套餐时不查询动态。
  const empty = fakeModels({ salons: [salon('bare', 116.4, [])] });
  assert.deepEqual(await recommend(empty), { categoryId: '', items: [] });
  assert.equal(empty.queries.posts.length, 0);
});

test('viewed and visited salons come first and carry their reasons', async () => {
  const models = fakeModels({
    salons: [salon('a', 116.4, [service('a1')]), salon('b', 116.41, [service('b1')]),
      salon('c', 116.42, [service('c1')]), salon('d', 116.43, [service('d1')])],
    posts: [post('pa', 'a', 'a1', '2026-01-01'), post('pb', 'b', 'b1', '2026-01-01'),
      post('pc', 'c', 'c1', '2026-01-01'), post('pd', 'd', 'd1', '2026-01-01')],
    bookings: [{ salonId: 'd', serviceId: 'd1' }, { salonId: 'c', serviceId: 'c1' }],
  });
  const result = await recommend(models, { viewerId: 'u1', viewedSalonIds: ['c', 'elsewhere'] });
  // 有理由的店铺在前（仍按距离），其余按距离。
  assert.deepEqual(result.items.map(item => [item.salonId, item.reasons]), [
    ['c', ['viewed', 'visited']], ['d', ['visited']], ['a', []], ['b', []],
  ]);
  // 预约只读已完成的，按用户的全部 ID 写法查。
  assert.deepEqual(models.queries.bookings[0], { userId: { $in: ['u1', 'user-u1'] }, status: 'completed' });
  // 未登录时只有「看过」。
  const guest = await recommend(models, { viewedSalonIds: ['b'] });
  assert.deepEqual(guest.items.map(item => [item.salonId, item.reasons]).slice(0, 2), [['b', ['viewed']], ['a', []]]);
});

test('the latest completed booking picks the category when enough nearby posts match it', async () => {
  assert.equal(MIN_CATEGORY_ITEMS, 3);
  const colorSalon = (id, longitude) => salon(id, longitude, [service(`${id}-cut`, ['wash_cut_blow', 'men']), service(`${id}-color`, ['color'])]);
  const salons = [colorSalon('a', 116.4), colorSalon('b', 116.41), colorSalon('c', 116.42), salon('d', 116.43, [service('d-cut', ['wash_cut_blow', 'men'])])];
  const posts = [
    // 每家店剪发动态更新，染发动态更早。
    ...['a', 'b', 'c'].flatMap(id => [post(`${id}-color-post`, id, `${id}-color`, '2026-01-01'), post(`${id}-cut-post`, id, `${id}-cut`, '2026-02-01')]),
    post('d-cut-post', 'd', 'd-cut', '2026-02-01'),
  ];
  // 最近一次预约的套餐已下架、归不到分类，往前找到在候选范围之外的店铺订过的染发套餐。
  const bookings = [{ salonId: 'a', serviceId: 'removed' }, { salonId: 'away', serviceId: 'away-color' }];
  const otherSalons = [salon('away', 121.5, [service('away-color', ['men', 'color'])])];
  const models = fakeModels({ salons, posts, bookings, otherSalons });
  const colored = await recommend(models, { viewerId: 'u1' });
  assert.equal(colored.categoryId, 'color');
  // 只出染发套餐的动态，没有染发动态的店铺不出现；a 去过，排在最前。
  assert.deepEqual(colored.items.map(item => item.id), ['a-color-post', 'b-color-post', 'c-color-post']);
  assert.deepEqual(colored.items[0].reasons, ['visited']);
  assert.deepEqual(models.queries.salons[1].id, { $in: ['away'] });

  // 分类下的内容不足三条时不按分类筛选，每家店回到最新一条。
  const fewer = fakeModels({ salons, posts: posts.filter(item => item.id !== 'c-color-post'), bookings, otherSalons });
  const general = await recommend(fewer, { viewerId: 'u1' });
  assert.equal(general.categoryId, '');
  assert.deepEqual(general.items.map(item => item.id), ['a-cut-post', 'b-cut-post', 'c-cut-post', 'd-cut-post']);

  // 没有已完成预约的用户不按分类。
  const fresh = await recommend(fakeModels({ salons, posts }), { viewerId: 'u2' });
  assert.equal(fresh.categoryId, '');
});

test('nearby salons and posts are read once per location cell while personal parts stay per request', async () => {
  const { createTtlCache } = require('../ttl-cache');
  let time = 0;
  const cache = createTtlCache({ ttlMs: 60_000, max: 200, now: () => time });
  const models = fakeModels({
    salons: [salon('a', 116.4, [service('a1')]), salon('b', 116.41, [service('b1')])],
    posts: [post('pa', 'a', 'a1', '2026-01-01'), post('pb', 'b', 'b1', '2026-01-01')],
    bookings: [{ salonId: 'b', serviceId: 'b1' }],
  });
  // 同一格（坐标取到小数点后 3 位）内的两个人：店铺和动态只查一次。
  const guest = await recommend(models, { userLocation: { latitude: 39.9001, longitude: 116.4004 } }, cache);
  const member = await recommend(models, {
    userLocation: { latitude: 39.9004, longitude: 116.3996 }, viewerId: 'u1', viewedSalonIds: ['a'],
  }, cache);
  assert.equal(models.queries.salons.length, 1);
  assert.equal(models.queries.posts.length, 1);
  assert.deepEqual(models.queries.salons[0].geoLocation.$nearSphere.$geometry.coordinates, [116.4, 39.9]);
  // 推荐理由和排序仍按各自的用户计算，互不影响。
  assert.deepEqual(guest.items.map(item => [item.salonId, item.reasons]), [['a', []], ['b', []]]);
  assert.deepEqual(member.items.map(item => [item.salonId, item.reasons]), [['a', ['viewed']], ['b', ['visited']]]);
  assert.equal(models.queries.bookings.length, 1);
  // 距离按各自的实际坐标计算。
  assert.notEqual(guest.items[0].distanceKm, member.items[0].distanceKm);
  // 共用的数据没有被某次请求改动。
  assert.deepEqual((await recommend(models, {}, cache)).items.map(item => item.reasons), [[], []]);
  assert.equal(models.queries.salons.length, 1);

  // 另一格重新查询；一分钟后同一格也重新查询。
  await recommend(models, { userLocation: { latitude: 39.902, longitude: 116.4 } }, cache);
  assert.equal(models.queries.salons.length, 2);
  time = 60_001;
  await recommend(models, {}, cache);
  assert.equal(models.queries.salons.length, 3);
  assert.equal(models.queries.posts.length, 3);
});
