const { resolveServiceTagIds } = require('./salon');
const { postWithSalonPayload } = require('./salon-posts');
const {
  MIN_CATEGORY_ITEMS,
  PROMOTION_CATEGORY_TAG_IDS,
  locationCell,
  orderByReasons,
  parseViewedSalonIds,
  readViewerBookings,
  resolveInterestCategory,
  salonRecommendationFields,
  serviceMatchesPromotionCategory,
  servicePromotionCategory,
} = require('./recommended-services');

// 首页推荐的第一版数据来源：附近店铺各自最新的、关联了在售套餐的已审核动态（/api/salons/recommended-posts）。
// 小程序现在改用推广套餐（services/recommended-services.js，/api/salons/recommended-services）；
// 这个接口只为已经对接它的客户端保留，确认没有客户端使用后连同本文件一起删除。
// 分类、推荐理由等与用户有关的规则两处共用 recommended-services.js 里的实现。

// 只在离用户最近的这些在线店铺里选动态，每家店最多出一条。
const SALON_CANDIDATES = 50;

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
  const center = locationCell(userLocation);
  const loadNearby = () => loadNearbyPosts(models, center);
  const [{ salons, latestPostByService }, bookings] = await Promise.all([
    cache ? cache.get(`${center.latitude},${center.longitude}`, loadNearby) : loadNearby(),
    readViewerBookings(models, viewerId),
  ]);
  if (!latestPostByService.size) return { categoryId: '', items: [] };

  let categoryId = await resolveInterestCategory(models, bookings, salons);
  let picks = categoryId
    ? pickSalonPosts(salons, latestPostByService,
      service => serviceMatchesPromotionCategory(categoryId, resolveServiceTagIds(service)))
    : [];
  if (picks.length < MIN_CATEGORY_ITEMS) {
    categoryId = '';
    picks = pickSalonPosts(salons, latestPostByService, () => true);
  }
  return {
    categoryId,
    items: orderByReasons(picks, bookings, viewedSalonIds).slice(0, limit).map(({ salon, post, reasons }) => ({
      ...postWithSalonPayload(post, salon, publicImageUrl),
      reasons,
      ...salonRecommendationFields(salon, userLocation),
    })),
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
