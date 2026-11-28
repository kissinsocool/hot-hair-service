const test = require('node:test');
const assert = require('node:assert/strict');
const { migratePostPromotionCategories } = require('./migrate-post-promotion-categories');
const { SalonPost: SalonPostModel } = require('../src/models');

test('backfill derives categories from the related service tags and never overwrites an existing category', async () => {
  const posts = [
    { id: 'p-curly', salonId: 's1', serviceId: 'svc-curly' },
    { id: 'p-women', salonId: 's1', serviceId: 'svc-women' },
    { id: 'p-legacy-tags', salonId: 's1', serviceId: 'svc-legacy' },
    { id: 'p-no-service', salonId: 's1', serviceId: '' },
    { id: 'p-removed', salonId: 's1', serviceId: 'gone' },
    { id: 'p-closed', salonId: 's2', serviceId: 'svc' },
    { id: 'p-chosen-meanwhile', salonId: 's1', serviceId: 'svc-curly' },
  ];
  const updates = [];
  const salonLookups = [];
  const models = {
    SalonPost: {
      find(filter) {
        assert.deepEqual(filter, { promotionCategoryId: { $exists: false } });
        return { select() { return this; }, lean() { return this; }, cursor: () => posts };
      },
      async updateOne(filter, update, options) {
        assert.deepEqual(filter.promotionCategoryId, { $exists: false });
        assert.deepEqual(options, { timestamps: false });
        // 迁移期间商家端已经给这条动态选了分类：条件不满足，不覆盖。
        if (filter.id === 'p-chosen-meanwhile') return { modifiedCount: 0 };
        updates.push([filter.id, update.$set.promotionCategoryId]);
        return { modifiedCount: 1 };
      },
    },
    Salon: {
      findOne({ id }) {
        salonLookups.push(id);
        return { select() { return this; }, lean: async () => (id === 's1' ? { services: [
          { id: 'svc-curly', tagIds: ['curly'] },
          { id: 'svc-women', tagIds: ['wash_cut_blow', 'women'] },
          { id: 'svc-legacy', tags: ['染发'] },
        ] } : null) };
      },
    },
  };
  const counts = await migratePostPromotionCategories({ models });
  assert.deepEqual(updates, [
    ['p-curly', 'curly'],
    ['p-women', 'women-cut'],
    ['p-legacy-tags', 'color'],
    ['p-no-service', ''],
    ['p-removed', ''],
    ['p-closed', ''],
  ]);
  assert.deepEqual(counts, { curly: 1, 'women-cut': 1, color: 1, '(none)': 3 });
  // 每家店只查一次套餐。
  assert.deepEqual(salonLookups, ['s1', 's2']);
});

test('the schema accepts every backfilled value', async () => {
  const base = { id: 'p', salonId: 's', authorType: 'salon', authorName: '店', content: '动态' };
  for (const promotionCategoryId of ['', 'women-cut', 'men-cut', 'color', 'curly', 'straight', 'care']) {
    await new SalonPostModel({ ...base, promotionCategoryId }).validate();
  }
  await assert.rejects(new SalonPostModel({ ...base, promotionCategoryId: 'perm' }).validate(), /promotionCategoryId/);
  assert.equal(new SalonPostModel(base).promotionCategoryId, '');
});
