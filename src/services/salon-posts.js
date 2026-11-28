const {
  buildSalonImageList, normalizeSalonTags, resolveServiceTagIds, salonCoverImageUrl, servicePayload,
} = require('./salon');
const { isPromotionCategoryId } = require('./promotion-categories');
const { servicePromotionCategory } = require('./recommended-services');

const MAX_CONTENT_LENGTH = 500;
const MAX_IMAGE_COUNT = 9;
const MAX_IMAGE_URL_LENGTH = 2048;

const AUTHOR_TYPES = ['staff', 'salon'];

// 旧动态和旧版商家端都没有 authorType，一律视为理发师投稿。
const postAuthorType = post => (post?.authorType === 'salon' ? 'salon' : 'staff');

const validatePostInput = (payload = {}) => {
  const content = String(payload.content || '').trim();
  const rawAuthorType = payload.authorType;
  if (rawAuthorType != null && !AUTHOR_TYPES.includes(rawAuthorType)) return { error: '投稿人类型无效' };
  const authorType = rawAuthorType || 'staff';
  // 以店铺名义投稿时忽略 authorStaffId，避免动态同时挂在店铺和某位理发师名下。
  const authorStaffId = authorType === 'salon' ? '' : String(payload.authorStaffId || '').trim();
  const serviceId = String(payload.serviceId || '').trim();
  const imageUrls = Array.isArray(payload.imageUrls)
    ? [...new Set(payload.imageUrls.map(value => String(value || '').trim()).filter(Boolean))]
    : [];
  if (authorType === 'staff' && !authorStaffId) return { error: '请选择投稿人' };
  if (!content) return { error: '请输入动态文字' };
  if (content.length > MAX_CONTENT_LENGTH) return { error: `动态文字不能超过${MAX_CONTENT_LENGTH}字` };
  if (!Array.isArray(payload.imageUrls)) return { error: 'imageUrls must be an array' };
  if (imageUrls.length > MAX_IMAGE_COUNT) return { error: `动态图片不能超过${MAX_IMAGE_COUNT}张` };
  if (imageUrls.some(url => url.length > MAX_IMAGE_URL_LENGTH || !/^https:\/\//i.test(url))) {
    return { error: '动态图片地址无效' };
  }
  // 推广分类：新版商家端必传。旧版商家端没有这个字段（undefined / null），返回 null，
  // 发布时由 promotionCategoryForPost 按关联套餐的标签推算。传了但不是有效分类（包括空字符串）则拒绝。
  const rawPromotionCategoryId = payload.promotionCategoryId;
  if (rawPromotionCategoryId != null && !isPromotionCategoryId(rawPromotionCategoryId)) {
    return { error: '请选择推广分类' };
  }
  const promotionCategoryId = rawPromotionCategoryId ?? null;
  return { value: { authorType, authorStaffId, content, imageUrls, serviceId, promotionCategoryId } };
};

// 保存到动态上的推广分类：商家选了就用商家选的；旧版商家端没传时，按关联套餐的标签推算
// （与字段上线前「按分类查找」的规则一致，一个套餐属于多个分类时按 servicePromotionCategory 的优先级取一个），
// 没有关联套餐则不属于任何分类。
const promotionCategoryForPost = (promotionCategoryId, service) => {
  if (promotionCategoryId != null) return promotionCategoryId;
  return service ? servicePromotionCategory(resolveServiceTagIds(service)) : '';
};

// 店铺官方投稿的投稿人信息：与理发师投稿一样，保存发布时的名称和头像（店铺封面的原始地址）。
const salonAuthorFields = (salon) => {
  const cover = [salon?.image, ...buildSalonImageList(salon)]
    .find(image => typeof image === 'string' && image.trim());
  return {
    authorType: 'salon',
    authorStaffId: '',
    authorName: String(salon?.name || '').trim(),
    authorImageUrl: cover || '',
  };
};

const postPayload = (post, publicImageUrl = value => value) => ({
  id: post.id,
  salonId: post.salonId,
  authorType: postAuthorType(post),
  authorStaffId: post.authorStaffId || '',
  authorName: post.authorName,
  authorRoleId: post.authorRoleId || '',
  authorImageUrl: publicImageUrl(post.authorImageUrl || ''),
  content: post.content,
  serviceId: post.serviceId || '',
  serviceName: post.serviceName || '',
  promotionCategoryId: post.promotionCategoryId || '',
  imageUrls: (post.imageUrls || []).map(publicImageUrl).filter(Boolean),
  reviewStatus: post.reviewStatus || 'pending',
  reviewedAt: post.reviewedAt,
  createdAt: post.createdAt,
  updatedAt: post.updatedAt,
});

// 套餐卡片（小程序收藏页「套餐」、首页「套餐推荐」）用的动态：动态本身，加上所属店铺的名称、简介、
// 封面、标签，以及关联套餐的当前信息。relatedService 为 null 表示动态没有关联套餐或套餐已下架。
const postWithSalonPayload = (post, salon, publicImageUrl = value => value) => {
  const service = post.serviceId ? (salon.services || []).find(item => item.id === post.serviceId) : null;
  return {
    ...postPayload(post, publicImageUrl),
    salonName: salon.name || '',
    salonDescription: salon.description || '',
    salonImageUrl: salonCoverImageUrl(salon),
    salonTags: normalizeSalonTags(salon.tags),
    relatedService: service ? servicePayload(service) : null,
  };
};

module.exports = {
  MAX_CONTENT_LENGTH,
  MAX_IMAGE_COUNT,
  postAuthorType,
  postPayload,
  postWithSalonPayload,
  promotionCategoryForPost,
  salonAuthorFields,
  validatePostInput,
};
