const { buildSalonImageList, normalizeSalonTags, salonCoverImageUrl, servicePayload } = require('./salon');

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
  return { value: { authorType, authorStaffId, content, imageUrls, serviceId } };
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
  salonAuthorFields,
  validatePostInput,
};
