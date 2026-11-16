const assert = require('node:assert/strict');
const test = require('node:test');
const { createTtlCache } = require('../ttl-cache');
const {
  MIN_CATEGORY_ITEMS,
  promotionCategoryTagFilter,
  readRecommendedServices,
} = require('./recommended-services');

const service = (id, tagIds = [], extra = {}) => ({
  id, name: `套餐${id}`, priceFen: 8800, durationMinutes: 30, tagIds,
  promotionEnabled: true, promotionReviewStatus: 'approved', promotionReviewedAt: new Date('2026-01-01'), ...extra,
});
const salon = (id, longitude, services, extra = {}) => ({
  id, name: `${id}店`, services, geoLocation: { type: 'Point', coordinates: [longitude, 39.9] }, ...extra,
});

// 模拟数据库：候选店铺按传入顺序（由近到远）返回。
const fakeModels = ({ salons, bookings = [], otherSalons = [] }) => {
  const queries = { salons: [], bookings: [] };
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
  };
};
const recommend = (models, options = {}, cache = null) => readRecommendedServices({
  userLocation: { latitude: 39.9, longitude: 116.4 }, limit: 10, ...options,
}, { models, cache });

test('category tag filters for MongoDB follow the same rule as the in-memory match', () => {
  assert.equal(promotionCategoryTagFilter('color'), 'color');
  assert.equal(promotionCategoryTagFilter('men-cut'), 'men');
  assert.deepEqual(promotionCategoryTagFilter('women-cut'), {
    $all: ['wash_cut_blow', 'women'], $nin: ['perm', 'color', 'curly', 'straight'],
  });
  assert.equal(promotionCategoryTagFilter('constructor'), null);
  assert.equal(promotionCategoryTagFilter(undefined), null);
});

test('guests get each nearby salons most recently approved promoted service, nearest first', async () => {
  const models = fakeModels({ salons: [
    salon('near', 116.4, [
      service('n-old', [], { promotionReviewedAt: new Date('2026-01-01') }),
      service('n-new', [], { promotionReviewedAt: new Date('2026-03-01'), priceFen: 12000 }),
      // 没开推广、推广未审核通过的套餐不推荐。
      service('n-off', [], { promotionEnabled: false, promotionReviewedAt: new Date('2026-05-01') }),
      service('n-pending', [], { promotionReviewStatus: 'pending', promotionReviewedAt: new Date('2026-05-01') }),
    ], { description: '地铁口', tags: ['近地铁'], image: 'https://example.com/near.jpg', afterSalesPolicyIds: ['no_active_sales'] }),
    // 查询条件之外又变成没有可推荐套餐的店铺不出现，也不占名额。
    salon('none', 116.41, [service('x', [], { promotionReviewStatus: 'rejected' })]),
    salon('far', 116.5, [service('f1')], { acceptsSameDayBooking: false }),
  ] });
  const result = await recommend(models);
  assert.equal(result.categoryId, '');
  assert.deepEqual(result.items.map(item => item.id), ['near:n-new', 'far:f1']);
  const [first, second] = result.items;
  assert.equal(first.salonId, 'near');
  assert.equal(first.salonName, 'near店');
  assert.equal(first.salonDescription, '地铁口');
  assert.equal(first.salonImageUrl, 'https://example.com/near.jpg');
  assert.deepEqual(first.salonTags, ['近地铁']);
  assert.equal(first.service.id, 'n-new');
  assert.equal(first.service.name, '套餐n-new');
  assert.equal(first.service.priceFen, 12000);
  assert.deepEqual(first.reasons, []);
  assert.equal(first.distanceKm, 0);
  assert.ok(second.distanceKm > 8 && second.distanceKm < 9);
  assert.equal(first.salonAcceptsSameDayBooking, true);
  assert.deepEqual(first.salonAfterSalesPolicyIds, ['no_active_sales']);
  assert.equal(second.salonAcceptsSameDayBooking, false);

  // 只查在线且有已审核推广套餐的店铺，由近到远；未登录不查预约。
  assert.equal(models.queries.salons.length, 1);
  assert.equal(models.queries.salons[0].publishStatus, 'online');
  assert.deepEqual(models.queries.salons[0].services, {
    $elemMatch: { promotionEnabled: true, promotionReviewStatus: 'approved' },
  });
  assert.deepEqual(models.queries.salons[0].geoLocation.$nearSphere.$geometry.coordinates, [116.4, 39.9]);
  assert.equal(models.queries.bookings.length, 0);

  assert.deepEqual((await recommend(models, { limit: 1 })).items.map(item => item.id), ['near:n-new']);
  assert.deepEqual(await recommend(fakeModels({ salons: [] })), { categoryId: '', items: [] });
});

test('viewed and visited salons come first and carry their reasons', async () => {
  const models = fakeModels({
    salons: [salon('a', 116.4, [service('a1')]), salon('b', 116.41, [service('b1')]),
      salon('c', 116.42, [service('c1')]), salon('d', 116.43, [service('d1')])],
    bookings: [{ salonId: 'd', serviceId: 'd1' }, { salonId: 'c', serviceId: 'c1' }],
  });
  const result = await recommend(models, { viewerId: 'u1', viewedSalonIds: ['c', 'elsewhere'] });
  assert.deepEqual(result.items.map(item => [item.salonId, item.reasons]), [
    ['c', ['viewed', 'visited']], ['d', ['visited']], ['a', []], ['b', []],
  ]);
  assert.deepEqual(models.queries.bookings[0], { userId: { $in: ['u1', 'user-u1'] }, status: 'completed' });
  const guest = await recommend(models, { viewedSalonIds: ['b'] });
  assert.deepEqual(guest.items.map(item => [item.salonId, item.reasons]).slice(0, 2), [['b', ['viewed']], ['a', []]]);
});

test('the latest completed booking picks the category when enough nearby promoted services match it', async () => {
  assert.equal(MIN_CATEGORY_ITEMS, 3);
  // 每家店剪发套餐的推广更新，染发套餐更早。
  const colorSalon = (id, longitude) => salon(id, longitude, [
    service(`${id}-cut`, ['wash_cut_blow', 'men'], { promotionReviewedAt: new Date('2026-02-01') }),
    service(`${id}-color`, ['color'], { promotionReviewedAt: new Date('2026-01-01') }),
  ]);
  const salons = [colorSalon('a', 116.4), colorSalon('b', 116.41), colorSalon('c', 116.42),
    salon('d', 116.43, [service('d-cut', ['wash_cut_blow', 'men'])])];
  // 最近一次预约的套餐已下架、归不到分类，往前找到在候选范围之外的店铺订过的染发套餐（该套餐不必开推广）。
  const bookings = [{ salonId: 'a', serviceId: 'removed' }, { salonId: 'away', serviceId: 'away-color' }];
  const otherSalons = [salon('away', 121.5, [service('away-color', ['men', 'color'], { promotionEnabled: false })])];
  const models = fakeModels({ salons, bookings, otherSalons });
  const colored = await recommend(models, { viewerId: 'u1' });
  assert.equal(colored.categoryId, 'color');
  assert.deepEqual(colored.items.map(item => item.id), ['a:a-color', 'b:b-color', 'c:c-color']);
  assert.deepEqual(colored.items[0].reasons, ['visited']);
  assert.deepEqual(models.queries.salons[1].id, { $in: ['away'] });

  // 分类下不足三个时不按分类筛选，每家店回到最近审核通过的推广套餐。
  const fewer = fakeModels({
    salons: [salons[0], salons[1], salon('c', 116.42, [service('c-cut', ['wash_cut_blow', 'men'])]), salons[3]],
    bookings, otherSalons,
  });
  const general = await recommend(fewer, { viewerId: 'u1' });
  assert.equal(general.categoryId, '');
  assert.deepEqual(general.items.map(item => item.id), ['a:a-cut', 'b:b-cut', 'c:c-cut', 'd:d-cut']);

  assert.equal((await recommend(fakeModels({ salons }), { viewerId: 'u2' })).categoryId, '');
});

test('nearby promoted salons are read once per location cell while personal parts stay per request', async () => {
  let time = 0;
  const cache = createTtlCache({ ttlMs: 60_000, max: 200, now: () => time });
  const models = fakeModels({
    salons: [salon('a', 116.4, [service('a1')]), salon('b', 116.41, [service('b1')])],
    bookings: [{ salonId: 'b', serviceId: 'b1' }],
  });
  const guest = await recommend(models, { userLocation: { latitude: 39.9001, longitude: 116.4004 } }, cache);
  const member = await recommend(models, {
    userLocation: { latitude: 39.9004, longitude: 116.3996 }, viewerId: 'u1', viewedSalonIds: ['a'],
  }, cache);
  assert.equal(models.queries.salons.length, 1);
  assert.deepEqual(models.queries.salons[0].geoLocation.$nearSphere.$geometry.coordinates, [116.4, 39.9]);
  assert.deepEqual(guest.items.map(item => [item.salonId, item.reasons]), [['a', []], ['b', []]]);
  assert.deepEqual(member.items.map(item => [item.salonId, item.reasons]), [['a', ['viewed']], ['b', ['visited']]]);
  assert.notEqual(guest.items[0].distanceKm, member.items[0].distanceKm);
  // 共用的数据没有被某次请求改动。
  assert.deepEqual((await recommend(models, {}, cache)).items.map(item => item.reasons), [[], []]);
  assert.equal(models.queries.salons.length, 1);

  await recommend(models, { userLocation: { latitude: 39.902, longitude: 116.4 } }, cache);
  assert.equal(models.queries.salons.length, 2);
  time = 60_001;
  await recommend(models, {}, cache);
  assert.equal(models.queries.salons.length, 3);
});
