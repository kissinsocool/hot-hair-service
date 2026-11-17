const path = require('node:path');
const mongoose = require('mongoose');
const { FavoritePackage, FavoritePost, SalonPost } = require('../src/models');

async function migrateFavoritePackages() {
  await FavoritePackage.createIndexes();
  const favorites = FavoritePost.find().select('userId postId createdAt').sort({ _id: -1 }).lean().cursor();
  let inserted = 0;
  for await (const favorite of favorites) {
    const post = await SalonPost.findOne({ id: favorite.postId }).select('salonId serviceId serviceName').lean();
    if (!post?.salonId || !post.serviceId) continue;
    const filter = { userId: favorite.userId, packageId: `${post.salonId}:${post.serviceId}` };
    const createdAt = favorite.createdAt || favorite._id.getTimestamp();
    const result = await FavoritePackage.updateOne(filter, {
      $setOnInsert: { ...filter, serviceName: post.serviceName, createdAt, updatedAt: createdAt },
    }, { upsert: true, timestamps: false });
    inserted += result.upsertedCount;
  }
  return inserted;
}

async function main() {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const uri = String(process.env.MONGODB_URI || '').trim();
  if (!uri) throw new Error('MONGODB_URI is missing');
  await mongoose.connect(uri);
  try {
    console.log(`Inserted package favorites: ${await migrateFavoritePackages()}`);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Package favorites migration failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { migrateFavoritePackages };
