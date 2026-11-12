const { FavoriteStaff, FavoritePost, StaffProfile, SalonPost, Salon } = require('../models');
const { publicImageUrl } = require('../images');
const { normalizeSalonTags, normalizeStaffRoleId, salonCoverImageUrl, servicePayload } = require('./salon');
const { postPayload } = require('./salon-posts');

// 理发师、店铺动态的收藏只按规范化后的 userId 写入，不存在历史别名，读写都直接用 userId。
const FAVORITE_KINDS = Object.freeze({
  staff: { model: () => FavoriteStaff, field: 'staffId' },
  posts: { model: () => FavoritePost, field: 'postId' },
});

const favoriteKind = (kind) => {
  const config = FAVORITE_KINDS[kind];
  if (!config) throw new Error(`Unknown favorite kind: ${kind}`);
  return config;
};

// 最近收藏的排在前面。
async function readFavoriteTargetIds(kind, userId) {
  if (!userId) return [];
  const { model, field } = favoriteKind(kind);
  const favorites = await model().find({ userId }).select(field).sort({ createdAt: -1, _id: -1 }).lean();
  return [...new Set(favorites.map(favorite => favorite[field]).filter(Boolean))];
}

// 收藏写入是幂等的：重复收藏、重复取消都视为成功。
async function setFavoriteTarget(kind, userId, targetId, favorite) {
  const { model, field } = favoriteKind(kind);
  const filter = { userId, [field]: targetId };
  if (!favorite) {
    await model().deleteOne(filter);
    return;
  }
  try {
    await model().updateOne(filter, { $setOnInsert: filter }, { upsert: true });
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }
}

// 只允许收藏仍对用户可见的对象：理发师所在店铺在线，动态已审核通过。
async function favoriteTargetExists(kind, targetId) {
  if (kind === 'staff') {
    const [staff, salon] = await Promise.all([
      StaffProfile.exists({ id: targetId }),
      Salon.exists({ staffIds: targetId, publishStatus: 'online' }),
    ]);
    return Boolean(staff && salon);
  }
  const post = await SalonPost.findOne({ id: targetId, reviewStatus: 'approved' }).select('salonId').lean();
  return Boolean(post && await Salon.exists({ id: post.salonId, publishStatus: 'online' }));
}

const countStaffFavorites = staffId => (staffId ? FavoriteStaff.countDocuments({ staffId }) : Promise.resolve(0));

const favoriteStaffPayload = (person, salon) => ({
  id: person.id,
  name: person.name || '',
  roleId: normalizeStaffRoleId(person.roleId),
  experience: person.experience || '',
  imageUrl: publicImageUrl(person.imageUrl || ''),
  bio: person.bio || '',
  salonId: salon.id,
  salonName: salon.name || '',
});

async function readFavoriteStaff(userId) {
  const staffIds = await readFavoriteTargetIds('staff', userId);
  if (!staffIds.length) return [];
  const [people, salons] = await Promise.all([
    StaffProfile.find({ id: { $in: staffIds } }).select('id name roleId experience imageUrl bio').lean(),
    Salon.find({ staffIds: { $in: staffIds }, publishStatus: 'online' }).select('id name staffIds').lean(),
  ]);
  const peopleById = new Map(people.map(person => [person.id, person]));
  const salonsByStaffId = new Map();
  salons.forEach(salon => (salon.staffIds || []).forEach((staffId) => {
    if (!salonsByStaffId.has(staffId)) salonsByStaffId.set(staffId, salon);
  }));
  return staffIds
    .filter(staffId => peopleById.has(staffId) && salonsByStaffId.has(staffId))
    .map(staffId => favoriteStaffPayload(peopleById.get(staffId), salonsByStaffId.get(staffId)));
}

// 每条动态带上店铺名、简介、标签、封面和关联套餐的当前信息；套餐已下架时 relatedService 为 null，客户端只展示名称。
async function readFavoritePosts(userId) {
  const postIds = await readFavoriteTargetIds('posts', userId);
  if (!postIds.length) return [];
  const posts = await SalonPost.find({ id: { $in: postIds }, reviewStatus: 'approved' }).lean();
  const salonIds = [...new Set(posts.map(post => post.salonId))];
  const salons = salonIds.length
    ? await Salon.find({ id: { $in: salonIds }, publishStatus: 'online' }).select('id name description tags image images promoImages services').lean()
    : [];
  const postsById = new Map(posts.map(post => [post.id, post]));
  const salonsById = new Map(salons.map(salon => [salon.id, salon]));
  return postIds
    .map(postId => postsById.get(postId))
    .filter(post => post && salonsById.has(post.salonId))
    .map((post) => {
      const salon = salonsById.get(post.salonId);
      const service = post.serviceId ? (salon.services || []).find(item => item.id === post.serviceId) : null;
      return {
        ...postPayload(post, publicImageUrl),
        salonName: salon.name || '',
        salonDescription: salon.description || '',
        salonImageUrl: salonCoverImageUrl(salon),
        salonTags: normalizeSalonTags(salon.tags),
        relatedService: service ? servicePayload(service) : null,
      };
    });
}

module.exports = {
  countStaffFavorites,
  favoriteTargetExists,
  readFavoritePosts,
  readFavoriteStaff,
  readFavoriteTargetIds,
  setFavoriteTarget,
};
