const {
  calculateDistanceKm, getCoordinates, normalizeAfterSalesPolicyIds, resolveServiceTagIds,
} = require('./salon');
const { userIdAliases } = require('./auth');
const { postWithSalonPayload } = require('./salon-posts');

// 小程序首页「套餐推荐」。规则与响应见 docs/home-recommended-posts.md。

// 只在离用户最近的这些在线店铺里选动态，每家店最多出一条。
const SALON_CANDIDATES = 50;
// 用最近这些已完成的预约判断用户感兴趣的分类、哪些店去过。
const RECENT_BOOKINGS = 20;
// 分类下可推荐的内容少于这个数时，不按分类筛选。
const MIN_CATEGORY_ITEMS = 3;
const MAX_VIEWED_SALON_IDS = 20;
// 坐标取到小数点后 3 位（约 100 米）：这一格内的用户共用同一份附近店铺和动态。
const LOCATION_DECIMALS = 3;

// 分类与套餐标签的对应，和「按分类查找」（/api/salons/promoted-services）相同。
const PROMOTION_CATEGORY_TAG_IDS = Object.freeze({
  'men-cut': 'men',
  'women-cut': 'women',
  color: 'color',
  curly: 'curly',
  straight: 'straight',
  care: 'care',
});
const WOMEN_CUT_EXCLUDED_TAG_IDS = Object.freeze(['perm', 'color', 'curly', 'straight']);

// 套餐是否属于某个分类。女士精剪要求同时有洗剪吹和女士标签，且不含烫染类标签，其余分类只看对应标签。
const serviceMatchesPromotionCategory = (categoryId, tagIds = []) => {
  if (!Object.hasOwn(PROMOTION_CATEGORY_TAG_IDS, categoryId)) return false;
  if (categoryId === 'women-cut') {
    return tagIds.includes('wash_cut_blow') && tagIds.includes('women')
      && !tagIds.some(id => WOMEN_CUT_EXCLUDED_TAG_IDS.includes(id));
  }
  return tagIds.includes(PROMOTION_CATEGORY_TAG_IDS[categoryId]);
};

// 一个套餐代表用户对哪个分类感兴趣：烫染护理类优先于剪发类（男士染发算染发）。都不属于时返回 ''。
const INTEREST_CATEGORY_ORDER = Object.freeze(['color', 'curly', 'straight', 'care', 'women-cut', 'men-cut']);
const servicePromotionCategory = (tagIds = []) =>
  INTEREST_CATEGORY_ORDER.find(categoryId => serviceMatchesPromotionCategory(categoryId, tagIds)) || '';

// 客户端传来的「最近看过的店铺」：逗号分隔的店铺 ID，只取前若干个。
const parseViewedSalonIds = (value) => (typeof value === 'string' ? value.split(',') : [])
  .map(id => id.trim())
  .filter(id => id && id.length <= 100)
  .slice(0, MAX_VIEWED_SALON_IDS);

const isNewer = (a, b) => {
  const difference = new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime();
  return difference ? difference > 0 : String(a._id) > String(b._id);
};

// 每家店在允许的套餐范围内取最新一条动态；没有符合的动态的店铺不出现。
const pickSalonPosts = (salons, latestPostByService, allowsService) => salons.flatMap((salon) => {
  let latest = null;
  for (const service of salon.services || []) {
    const post = allowsService(service) ? latestPostByService.get(`${salon.id}\n${service.id}`) : null;
    if (post && (!latest || isNewer(post, latest))) latest = post;
  }
  return latest ? [{ salon, post: latest }] : [];
});

// 与用户无关的部分：某个位置附近的候选店铺（由近到远），以及这些店铺每个在售套餐的最新已审核动态。
async function loadNearbyPosts({ Salon, SalonPost }, center) {
  const salons = await Salon.find({
    publishStatus: 'online',
    'services.0': { $exists: true },
    geoLocation: { $nearSphere: { $geometry: {
      type: 'Point',
      coordinates: [center.longitude, center.latitude],
    } } },
  })
    .select('id name description tags image images promoImages services location geoLocation afterSalesPolicyIds acceptsSameDayBooking')
    .limit(SALON_CANDIDATES)
    .lean();
  // 每家店只匹配关联了本店现有套餐的动态，套餐已下架的动态不参与推荐。
  const salonFilters = salons
    .map(salon => ({
      salonId: salon.id,
      serviceId: { $in: (salon.services || []).map(service => service.id).filter(Boolean) },
    }))
    .filter(filter => filter.serviceId.$in.length);
  const latestPosts = salonFilters.length
    ? await SalonPost.aggregate([
      { $match: { reviewStatus: 'approved', $or: salonFilters } },
      { $sort: { createdAt: -1, _id: -1 } },
      { $group: { _id: { salonId: '$salonId', serviceId: '$serviceId' }, post: { $first: '$$ROOT' } } },
    ]).option({ maxTimeMS: 5000 })
    : [];
  return {
    salons,
    latestPostByService: new Map(latestPosts
      .map(entry => [`${entry._id.salonId}\n${entry._id.serviceId}`, entry.post])),
  };
}

// userLocation：请求坐标；viewerId：已登录用户的规范化 ID（未登录为 ''）；viewedSalonIds：客户端记录的最近看过的店铺。
// cache（可选）：按取整后的坐标复用与用户无关的部分，同一格内的请求只查一次；其中的数据多个请求共用，只读不改。
// 分类、推荐理由、排序和距离每次按当前用户和实际坐标计算。
async function readRecommendedPosts({ userLocation, limit, viewerId = '', viewedSalonIds = [] }, {
  models = require('../models'),
  publicImageUrl = require('../images').publicImageUrl,
  cache = null,
} = {}) {
  const { Salon, Booking } = models;
  const center = {
    latitude: Number(userLocation.latitude.toFixed(LOCATION_DECIMALS)),
    longitude: Number(userLocation.longitude.toFixed(LOCATION_DECIMALS)),
  };
  const loadNearby = () => loadNearbyPosts(models, center);
  const [{ salons, latestPostByService }, bookings] = await Promise.all([
    cache ? cache.get(`${center.latitude},${center.longitude}`, loadNearby) : loadNearby(),
    viewerId
      ? Booking.find({ userId: { $in: userIdAliases(viewerId) }, status: 'completed' })
        .sort({ createdAt: -1 }).limit(RECENT_BOOKINGS).select('salonId serviceId').lean()
      : [],
  ]);
  if (!latestPostByService.size) return { categoryId: '', items: [] };

  // 订过的套餐可能属于候选范围之外的店铺，分类要从这些店铺的套餐标签里读。
  const candidateIds = new Set(salons.map(salon => salon.id));
  const otherBookedSalonIds = [...new Set(bookings.map(booking => booking.salonId))]
    .filter(id => id && !candidateIds.has(id));
  const otherBookedSalons = otherBookedSalonIds.length
    ? await Salon.find({ id: { $in: otherBookedSalonIds } })
      .select('id services.id services.tagIds services.tags').lean()
    : [];

  // 感兴趣的分类：最近一次能归到分类的已完成预约。
  const servicesBySalonId = new Map([...salons, ...otherBookedSalons]
    .map(salon => [salon.id, salon.services || []]));
  let categoryId = '';
  for (const booking of bookings) {
    const service = (servicesBySalonId.get(booking.salonId) || []).find(item => item.id === booking.serviceId);
    categoryId = service ? servicePromotionCategory(resolveServiceTagIds(service)) : '';
    if (categoryId) break;
  }
  let picks = categoryId
    ? pickSalonPosts(salons, latestPostByService,
      service => serviceMatchesPromotionCategory(categoryId, resolveServiceTagIds(service)))
    : [];
  if (picks.length < MIN_CATEGORY_ITEMS) {
    categoryId = '';
    picks = pickSalonPosts(salons, latestPostByService, () => true);
  }

  const visited = new Set(bookings.map(booking => booking.salonId));
  const viewed = new Set(viewedSalonIds);
  const reasonsOf = salon => [
    ...(viewed.has(salon.id) ? ['viewed'] : []),
    ...(visited.has(salon.id) ? ['visited'] : []),
  ];
  // 有推荐理由（看过、去过）的店铺排在前面，其余保持由近到远。
  const withReasons = picks.map(pick => ({ ...pick, reasons: reasonsOf(pick.salon) }));
  const ordered = [
    ...withReasons.filter(pick => pick.reasons.length),
    ...withReasons.filter(pick => !pick.reasons.length),
  ];
  return {
    categoryId,
    items: ordered.slice(0, limit).map(({ salon, post, reasons }) => {
      const coordinates = getCoordinates(salon.location || salon.geoLocation);
      return {
        ...postWithSalonPayload(post, salon, publicImageUrl),
        ...(coordinates
          ? { distanceKm: Number(calculateDistanceKm(userLocation, coordinates).toFixed(2)) }
          : {}),
        reasons,
        // 卡片标签的备选：没有推荐理由或理由不足两个时，小程序用「当日可约」和售后政策补足。
        salonAcceptsSameDayBooking: salon.acceptsSameDayBooking !== false,
        salonAfterSalesPolicyIds: normalizeAfterSalesPolicyIds(salon.afterSalesPolicyIds),
      };
    }),
  };
}

module.exports = {
  MIN_CATEGORY_ITEMS,
  PROMOTION_CATEGORY_TAG_IDS,
  parseViewedSalonIds,
  readRecommendedPosts,
  serviceMatchesPromotionCategory,
  servicePromotionCategory,
};
