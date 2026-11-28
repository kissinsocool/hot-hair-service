// 推广分类：小程序首页「按分类查找」的分类，也是商家发布作品时选择的推广分类（SalonPost.promotionCategoryId）。
// 值是分类与套餐标签的对应：首页推荐和旧数据补分类仍按套餐标签判断（见 recommended-services.js）。
// 分类 ID 是跨端约定：小程序 utils/promotionCategories.js、商家端 salon_post_promotion_categories.dart 必须一致。
// 本文件不依赖其他业务模块，models.js 可以直接引用（recommended-services.js 依赖 models，不能反过来）。
const PROMOTION_CATEGORY_TAG_IDS = Object.freeze({
  'men-cut': 'men',
  'women-cut': 'women',
  color: 'color',
  curly: 'curly',
  straight: 'straight',
  care: 'care',
});

const PROMOTION_CATEGORY_IDS = Object.freeze(Object.keys(PROMOTION_CATEGORY_TAG_IDS));

const isPromotionCategoryId = value =>
  typeof value === 'string' && Object.hasOwn(PROMOTION_CATEGORY_TAG_IDS, value);

module.exports = { PROMOTION_CATEGORY_IDS, PROMOTION_CATEGORY_TAG_IDS, isPromotionCategoryId };
