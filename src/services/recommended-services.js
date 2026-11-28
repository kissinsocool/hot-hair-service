const {
  calculateDistanceKm, getCoordinates, normalizeAfterSalesPolicyIds, normalizeSalonTags, resolveServiceTagIds,
  salonCoverImageUrl, servicePayload,
} = require('./salon');
const { userIdAliases } = require('./auth');
const { PROMOTION_CATEGORY_TAG_IDS } = require('./promotion-categories');

// 小程序首页推荐（「你可能喜欢」）：附近店铺开了推广、且推广已审核通过的套餐。
// 规则与响应见 docs/home-recommended-services.md。

// 只在离用户最近的这些有推广套餐的在线店铺里选，每家店最多出一个套餐。
const SALON_CANDIDATES = 50;
// 用最近这些已完成的预约判断用户感兴趣的分类、哪些店去过。
const RECENT_BOOKINGS = 20;
// 分类下可推荐的内容少于这个数时，不按分类筛选。
const MIN_CATEGORY_ITEMS = 3;
const MAX_VIEWED_SALON_IDS = 20;
// 坐标取到小数点后 3 位（约 100 米）：这一格内的用户共用同一份附近店铺。
const LOCATION_DECIMALS = 3;

// 分类与套餐标签的对应定义在 promotion-categories.js；首页推荐、旧作品补分类按这里的规则判断套餐属于哪个分类。
const WOMEN_CUT_REQUIRED_TAG_IDS = Object.freeze(['wash_cut_blow', 'women']);
const WOMEN_CUT_EXCLUDED_TAG_IDS = Object.freeze(['perm', 'color', 'curly', 'straight']);

// 套餐是否属于某个分类。女士精剪要求同时有洗剪吹和女士标签，且不含烫染类标签，其余分类只看对应标签。
const serviceMatchesPromotionCategory = (categoryId, tagIds = []) => {
  if (!Object.hasOwn(PROMOTION_CATEGORY_TAG_IDS, categoryId)) return false;
  if (categoryId === 'women-cut') {
    return WOMEN_CUT_REQUIRED_TAG_IDS.every(id => tagIds.includes(id))
      && !tagIds.some(id => WOMEN_CUT_EXCLUDED_TAG_IDS.includes(id));
  }
  return tagIds.includes(PROMOTION_CATEGORY_TAG_IDS[categoryId]);
};

// 同一条规则写成对套餐 tagIds 字段的 MongoDB 条件；分类不存在时返回 null。
const promotionCategoryTagFilter = (categoryId) => {
  if (typeof categoryId !== 'string' || !Object.hasOwn(PROMOTION_CATEGORY_TAG_IDS, categoryId)) return null;
  return categoryId === 'women-cut'
    ? { $all: [...WOMEN_CUT_REQUIRED_TAG_IDS], $nin: [...WOMEN_CUT_EXCLUDED_TAG_IDS] }
    : PROMOTION_CATEGORY_TAG_IDS[categoryId];
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

// 请求坐标所在的格子：同一格内的请求共用附近店铺的查询结果。
const locationCell = userLocation => ({
  latitude: Number(userLocation.latitude.toFixed(LOCATION_DECIMALS)),
  longitude: Number(userLocation.longitude.toFixed(LOCATION_DECIMALS)),
});

// 已登录用户最近完成的预约（新的在前）；未登录返回空。
const readViewerBookings = ({ Booking }, viewerId) => (viewerId
  ? Booking.find({ userId: { $in: userIdAliases(viewerId) }, status: 'completed' })
    .sort({ createdAt: -1 }).limit(RECENT_BOOKINGS).select('salonId serviceId').lean()
  : []);

// 感兴趣的分类：最近一次能归到分类的已完成预约。订过的套餐可能属于候选范围之外的店铺，
// 这些店铺的套餐标签另外读取。
async function resolveInterestCategory({ Salon }, bookings, salons) {
  const candidateIds = new Set(salons.map(salon => salon.id));
  const otherBookedSalonIds = [...new Set(bookings.map(booking => booking.salonId))]
    .filter(id => id && !candidateIds.has(id));
  const otherBookedSalons = otherBookedSalonIds.length
    ? await Salon.find({ id: { $in: otherBookedSalonIds } })
      .select('id services.id services.tagIds services.tags').lean()
    : [];
  const servicesBySalonId = new Map([...salons, ...otherBookedSalons]
    .map(salon => [salon.id, salon.services || []]));
  for (const booking of bookings) {
    const service = (servicesBySalonId.get(booking.salonId) || []).find(item => item.id === booking.serviceId);
    const categoryId = service ? servicePromotionCategory(resolveServiceTagIds(service)) : '';
    if (categoryId) return categoryId;
  }
  return '';
}

// 给每个候选（{ salon, ... }）标上推荐理由，有理由（看过、去过）的排在前面，其余保持原来由近到远的顺序。
const orderByReasons = (picks, bookings, viewedSalonIds) => {
  const visited = new Set(bookings.map(booking => booking.salonId));
  const viewed = new Set(viewedSalonIds);
  const withReasons = picks.map(pick => ({
    ...pick,
    reasons: [
      ...(viewed.has(pick.salon.id) ? ['viewed'] : []),
      ...(visited.has(pick.salon.id) ? ['visited'] : []),
    ],
  }));
  return [
    ...withReasons.filter(pick => pick.reasons.length),
    ...withReasons.filter(pick => !pick.reasons.length),
  ];
};

// 距离，以及卡片标签的备选：没有推荐理由或理由不足两个时，小程序用「当日可约」和售后政策补足。
const salonRecommendationFields = (salon, userLocation) => {
  const coordinates = getCoordinates(salon.location || salon.geoLocation);
  return {
    ...(coordinates
      ? { distanceKm: Number(calculateDistanceKm(userLocation, coordinates).toFixed(2)) }
      : {}),
    salonAcceptsSameDayBooking: salon.acceptsSameDayBooking !== false,
    salonAfterSalesPolicyIds: normalizeAfterSalesPolicyIds(salon.afterSalesPolicyIds),
  };
};

const isPromoted = service => service.promotionEnabled === true && service.promotionReviewStatus === 'approved';

// 每家店在允许的范围内取最近审核通过推广的那个套餐；没有符合的推广套餐的店铺不出现。
const pickSalonServices = (salons, allowsService) => salons.flatMap((salon) => {
  let latest = null;
  for (const service of salon.services || []) {
    if (!service.id || !isPromoted(service) || !allowsService(service)) continue;
    const reviewedAt = new Date(service.promotionReviewedAt || 0).getTime();
    if (!latest || reviewedAt > latest.reviewedAt) latest = { service, reviewedAt };
  }
  return latest ? [{ salon, service: latest.service }] : [];
});

// 与用户无关的部分：某个位置附近、有已审核推广套餐的在线店铺（由近到远）。
const loadNearbyPromotedSalons = ({ Salon }, center) => Salon.find({
  publishStatus: 'online',
  services: { $elemMatch: { promotionEnabled: true, promotionReviewStatus: 'approved' } },
  geoLocation: { $nearSphere: { $geometry: {
    type: 'Point',
    coordinates: [center.longitude, center.latitude],
  } } },
})
  .select('id name description tags image images promoImages services location geoLocation afterSalesPolicyIds acceptsSameDayBooking')
  .limit(SALON_CANDIDATES)
  .lean();

// userLocation：请求坐标；viewerId：已登录用户的规范化 ID（未登录为 ''）；viewedSalonIds：客户端记录的最近看过的店铺。
// cache（可选）：按取整后的坐标复用附近店铺的查询结果，同一格内的请求只查一次；其中的数据多个请求共用，只读不改。
// 分类、推荐理由、排序和距离每次按当前用户和实际坐标计算。
async function readRecommendedServices({ userLocation, limit, viewerId = '', viewedSalonIds = [] }, {
  models = require('../models'),
  cache = null,
} = {}) {
  const center = locationCell(userLocation);
  const loadNearby = () => loadNearbyPromotedSalons(models, center);
  const [salons, bookings] = await Promise.all([
    cache ? cache.get(`${center.latitude},${center.longitude}`, loadNearby) : loadNearby(),
    readViewerBookings(models, viewerId),
  ]);
  if (!salons.length) return { categoryId: '', items: [] };

  let categoryId = await resolveInterestCategory(models, bookings, salons);
  let picks = categoryId
    ? pickSalonServices(salons, service => serviceMatchesPromotionCategory(categoryId, resolveServiceTagIds(service)))
    : [];
  if (picks.length < MIN_CATEGORY_ITEMS) {
    categoryId = '';
    picks = pickSalonServices(salons, () => true);
  }
  return {
    categoryId,
    items: orderByReasons(picks, bookings, viewedSalonIds).slice(0, limit).map(({ salon, service, reasons }) => ({
      id: `${salon.id}:${service.id}`,
      salonId: salon.id,
      salonName: salon.name || '',
      salonDescription: salon.description || '',
      salonImageUrl: salonCoverImageUrl(salon),
      salonTags: normalizeSalonTags(salon.tags),
      service: servicePayload(service),
      reasons,
      ...salonRecommendationFields(salon, userLocation),
    })),
  };
}

module.exports = {
  MIN_CATEGORY_ITEMS,
  PROMOTION_CATEGORY_TAG_IDS,
  locationCell,
  orderByReasons,
  parseViewedSalonIds,
  promotionCategoryTagFilter,
  readRecommendedServices,
  readViewerBookings,
  resolveInterestCategory,
  salonRecommendationFields,
  serviceMatchesPromotionCategory,
  servicePromotionCategory,
};
