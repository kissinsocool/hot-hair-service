const { isPromotionCategoryId } = require('./promotion-categories');

// 小程序「按分类查找」的图片：店铺发布的动态。一条动态属于哪个分类，由商家发布时选的推广分类
// （SalonPost.promotionCategoryId）决定，不再看关联套餐的标签。店铺不在线、没有图片或未审核通过的动态不出现。
// 每条动态只出第一张图。规则与响应见 docs/category-posts.md。

// 店铺到用户的球面距离（公里）；店铺没有坐标时排在最后。
const distanceKmStage = (userLocation) => {
  const lat = { $ifNull: ['$location.latitude', { $arrayElemAt: ['$geoLocation.coordinates', 1] }] };
  const lon = { $ifNull: ['$location.longitude', { $arrayElemAt: ['$geoLocation.coordinates', 0] }] };
  const radians = value => ({ $degreesToRadians: value });
  const cosine = { $add: [
    { $multiply: [{ $sin: radians(userLocation.latitude) }, { $sin: radians(lat) }] },
    { $multiply: [{ $cos: radians(userLocation.latitude) }, { $cos: radians(lat) },
      { $cos: radians({ $subtract: [lon, userLocation.longitude] }) }] },
  ] };
  return { $set: { distanceKm: { $cond: [
    { $and: [{ $ne: [lat, null] }, { $ne: [lon, null] }] },
    { $multiply: [6371, { $acos: { $min: [1, { $max: [-1, cosine] }] } }] },
    1e12,
  ] } } };
};

// 从该分类下已审核、有图片的动态出发（索引 promotionCategoryId + reviewStatus + createdAt），只留在线店铺的动态。
// sort 为 'distance' 时按店铺距离由近到远（需要 userLocation），否则按动态发布时间从新到旧。
const categoryPostsPipeline = ({ categoryId, sort, userLocation, pagination, salonsCollection }) => [
  { $match: {
    promotionCategoryId: categoryId,
    reviewStatus: 'approved',
    'imageUrls.0': { $exists: true, $nin: ['', null] },
  } },
  { $lookup: {
    from: salonsCollection,
    let: { salonId: '$salonId' },
    pipeline: [
      { $match: { $expr: { $eq: ['$id', '$$salonId'] }, publishStatus: 'online' } },
      { $project: { _id: 0, location: 1, geoLocation: 1 } },
    ],
    as: 'salon',
  } },
  { $unwind: '$salon' },
  { $project: {
    salonId: 1,
    postId: '$id',
    imageUrl: { $arrayElemAt: ['$imageUrls', 0] },
    createdAt: 1,
    location: '$salon.location',
    geoLocation: '$salon.geoLocation',
  } },
  ...(sort === 'distance' ? [distanceKmStage(userLocation)] : []),
  { $sort: { ...(sort === 'distance' ? { distanceKm: 1 } : {}), createdAt: -1, _id: -1 } },
  { $facet: {
    items: [
      { $skip: pagination.skip },
      { $limit: pagination.limit },
      { $project: { _id: 0, salonId: 1, postId: 1, imageUrl: 1 } },
    ],
    total: [{ $count: 'count' }],
  } },
];

// 返回 { images: [{ id, salonId, postId, imageUrl }], total }；id 即动态 ID。分类不存在时返回 null。
async function readCategoryPosts({ categoryId, sort, userLocation, pagination }, {
  models = require('../models'),
  publicImageUrl = require('../images').publicImageUrl,
} = {}) {
  if (!isPromotionCategoryId(categoryId)) return null;
  const { Salon, SalonPost } = models;
  const [page] = await SalonPost.aggregate(categoryPostsPipeline({
    categoryId, sort, userLocation, pagination, salonsCollection: Salon.collection.name,
  })).option({ maxTimeMS: 5000, allowDiskUse: true });
  return {
    images: (page?.items || []).map(item => ({
      id: item.postId,
      salonId: item.salonId,
      postId: item.postId,
      imageUrl: publicImageUrl(item.imageUrl),
    })),
    total: page?.total?.[0]?.count || 0,
  };
}

module.exports = { categoryPostsPipeline, readCategoryPosts };
