const path = require('node:path');
const mongoose = require('mongoose');
const { Salon, SalonPost } = require('../src/models');
const { promotionCategoryForPost } = require('../src/services/salon-posts');

// 给 promotionCategoryId 字段上线前发布的动态补上推广分类，规则与字段上线前「按分类查找」一致：
// 按关联套餐（店铺当前套餐列表里的那个）的标签推算；没有关联套餐或套餐已下架的动态记为 ''（不属于任何分类）。
// 只处理还没有这个字段的动态，重复运行不会改动已有分类（包括商家在新版商家端选的分类）。
async function migratePostPromotionCategories({ models = { Salon, SalonPost } } = {}) {
  const posts = models.SalonPost.find({ promotionCategoryId: { $exists: false } })
    .select('id salonId serviceId').lean().cursor();
  const servicesBySalon = new Map();
  const counts = {};
  for await (const post of posts) {
    if (!servicesBySalon.has(post.salonId)) {
      const salon = await models.Salon.findOne({ id: post.salonId }).select('services').lean();
      servicesBySalon.set(post.salonId, salon?.services || []);
    }
    const service = post.serviceId
      ? servicesBySalon.get(post.salonId).find(item => item.id === post.serviceId) || null
      : null;
    const promotionCategoryId = promotionCategoryForPost(null, service);
    // 条件里再带上 $exists: false：迁移期间商家端新发布的动态已带分类，不会被覆盖。
    const result = await models.SalonPost.updateOne(
      { id: post.id, promotionCategoryId: { $exists: false } },
      { $set: { promotionCategoryId } },
      { timestamps: false },
    );
    if (result.modifiedCount) counts[promotionCategoryId || '(none)'] = (counts[promotionCategoryId || '(none)'] || 0) + 1;
  }
  return counts;
}

async function main() {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const uri = String(process.env.MONGODB_URI || '').trim();
  if (!uri) throw new Error('MONGODB_URI is missing');
  await mongoose.connect(uri);
  try {
    await SalonPost.createIndexes();
    console.log('Backfilled post promotion categories:', JSON.stringify(await migratePostPromotionCategories()));
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Post promotion category migration failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { migratePostPromotionCategories };
