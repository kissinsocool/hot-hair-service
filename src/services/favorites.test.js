const test = require('node:test');
const assert = require('node:assert/strict');
const { FavoriteStaff, FavoritePost, StaffProfile, SalonPost, Salon } = require('../models');
const favorites = require('./favorites');

const query = rows => ({
  select() { return this; },
  sort() { return this; },
  lean: async () => rows,
});

const patch = (model, overrides) => {
  const originals = Object.fromEntries(Object.keys(overrides).map(key => [key, model[key]]));
  Object.assign(model, overrides);
  return () => Object.assign(model, originals);
};

test('favorite stylists keep favorite order and drop stylists without an online salon', async (t) => {
  t.after(patch(FavoriteStaff, { find: () => query([{ staffId: 'staff-2' }, { staffId: 'staff-1' }, { staffId: 'staff-3' }]) }));
  t.after(patch(StaffProfile, { find: () => query([
    { id: 'staff-1', name: 'A', roleId: 'senior_barber', imageUrl: '', bio: 'bio-1' },
    { id: 'staff-2', name: 'B', roleId: 'unknown', imageUrl: '' },
    { id: 'staff-3', name: 'C', roleId: 'senior_barber', imageUrl: '' },
  ]) }));
  t.after(patch(Salon, { find: () => query([{ id: 'salon-1', name: '店一', staffIds: ['staff-1', 'staff-2'] }]) }));

  const list = await favorites.readFavoriteStaff('user-1');
  assert.deepEqual(list.map(item => [item.id, item.salonId, item.salonName]), [
    ['staff-2', 'salon-1', '店一'],
    ['staff-1', 'salon-1', '店一'],
  ]);
  assert.equal(list[0].roleId, '');
  assert.equal(list[1].bio, 'bio-1');
});

test('favorite posts carry salon name and the current related service', async (t) => {
  t.after(patch(FavoritePost, { find: () => query([{ postId: 'post-2' }, { postId: 'post-1' }, { postId: 'post-3' }]) }));
  t.after(patch(SalonPost, { find: () => query([
    { id: 'post-1', salonId: 'salon-1', authorStaffId: 's', authorName: 'A', authorRoleId: 'stylist', content: 'one', serviceId: 'svc-1', serviceName: '剪发', imageUrls: [] },
    { id: 'post-2', salonId: 'salon-1', authorStaffId: 's', authorName: 'A', authorRoleId: 'stylist', content: 'two', serviceId: 'svc-gone', serviceName: '旧套餐', imageUrls: [] },
    { id: 'post-3', salonId: 'salon-offline', authorStaffId: 's', authorName: 'A', authorRoleId: 'stylist', content: 'three', imageUrls: [] },
  ]) }));
  t.after(patch(Salon, { find: () => query([{ id: 'salon-1', name: '店一', description: '简介', tags: ['近地铁', ' ', '近地铁', '安静'], images: ['https://cdn.example.com/cover.jpg'], services: [{ id: 'svc-1', name: '剪发', priceFen: 8800 }] }]) }));

  const list = await favorites.readFavoritePosts('user-1');
  assert.deepEqual(list.map(item => item.id), ['post-2', 'post-1']);
  assert.equal(list[0].relatedService, null);
  assert.equal(list[0].serviceName, '旧套餐');
  assert.equal(list[1].salonName, '店一');
  assert.equal(list[1].salonDescription, '简介');
  assert.deepEqual(list[1].salonTags, ['近地铁', '安静']);
  assert.match(list[1].salonImageUrl, /cover\.jpg/);
  assert.equal(list[1].relatedService.id, 'svc-1');
  assert.equal(list[1].relatedService.priceFen, 8800);
});

test('favorite writes are idempotent upserts and deletes scoped to the user', async (t) => {
  const calls = [];
  t.after(patch(FavoriteStaff, {
    async updateOne(...args) { calls.push(['update', ...args]); const error = new Error('dup'); error.code = 11000; throw error; },
    async deleteOne(filter) { calls.push(['delete', filter]); },
  }));
  await favorites.setFavoriteTarget('staff', 'user-1', 'staff-1', true);
  await favorites.setFavoriteTarget('staff', 'user-1', 'staff-1', false);
  assert.deepEqual(calls, [
    ['update', { userId: 'user-1', staffId: 'staff-1' }, { $setOnInsert: { userId: 'user-1', staffId: 'staff-1' } }, { upsert: true }],
    ['delete', { userId: 'user-1', staffId: 'staff-1' }],
  ]);
});
