const { normalizeSalonTags, salonCoverImageUrl, servicePayload } = require('./salon');

const MAX_CONTENT_LENGTH = 500;
const MAX_IMAGE_COUNT = 9;
const MAX_IMAGE_URL_LENGTH = 2048;

const validatePostInput = (payload = {}) => {
  const content = String(payload.content || '').trim();
  const authorStaffId = String(payload.authorStaffId || '').trim();
  const serviceId = String(payload.serviceId || '').trim();
  const imageUrls = Array.isArray(payload.imageUrls)
    ? [...new Set(payload.imageUrls.map(value => String(value || '').trim()).filter(Boolean))]
    : [];
  if (!authorStaffId) return { error: '请选择投稿人' };
  if (!content) return { error: '请输入动态文字' };
  if (content.length > MAX_CONTENT_LENGTH) return { error: `动态文字不能超过${MAX_CONTENT_LENGTH}字` };
  if (!Array.isArray(payload.imageUrls)) return { error: 'imageUrls must be an array' };
  if (imageUrls.length > MAX_IMAGE_COUNT) return { error: `动态图片不能超过${MAX_IMAGE_COUNT}张` };
  if (imageUrls.some(url => url.length > MAX_IMAGE_URL_LENGTH || !/^https:\/\//i.test(url))) {
    return { error: '动态图片地址无效' };
  }
  return { value: { authorStaffId, content, imageUrls, serviceId } };
};

const postPayload = (post, publicImageUrl = value => value) => ({
  id: post.id,
  salonId: post.salonId,
  authorStaffId: post.authorStaffId,
  authorName: post.authorName,
  authorRoleId: post.authorRoleId,
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
  postPayload,
  postWithSalonPayload,
  validatePostInput,
};
