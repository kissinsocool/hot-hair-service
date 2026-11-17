const test = require('node:test');
const assert = require('node:assert/strict');
const { FavoritePackage, FavoritePost, SalonPost } = require('../src/models');
const { migrateFavoritePackages } = require('./migrate-favorite-packages');

test('copying packages from legacy post favorites keeps post favorites and deduplicates by user and service', async (t) => {
  const createdAt = new Date('2026-01-01T00:00:00Z');
  const existing = new Map();
  const legacy = ['p1', 'p2', 'no-service', 'deleted'].map(postId => ({ postId, userId: 'u1', createdAt }));
  t.mock.method(FavoritePost, 'find', () => ({
    select() { return this; },
    sort() { return this; },
    lean() { return this; },
    cursor: () => legacy,
  }));
  t.mock.method(SalonPost, 'findOne', ({ id }) => ({
    select() { return this; },
    lean: async () => id === 'deleted' ? null : {
      salonId: 's1', serviceId: id === 'no-service' ? '' : 'svc', serviceName: '剪发',
    },
  }));
  t.mock.method(FavoritePackage, 'createIndexes', async () => {});
  t.mock.method(FavoritePackage, 'updateOne', async ({ userId, packageId }, { $setOnInsert }, options) => {
    assert.deepEqual(options, { upsert: true, timestamps: false });
    const key = `${userId}/${packageId}`;
    if (existing.has(key)) return { upsertedCount: 0 };
    existing.set(key, $setOnInsert);
    return { upsertedCount: 1 };
  });
  assert.equal(await migrateFavoritePackages(), 1);
  assert.equal(await migrateFavoritePackages(), 0);
  assert.equal(legacy.length, 4);
  assert.deepEqual([...existing.values()], [{
    userId: 'u1', packageId: 's1:svc', serviceName: '剪发', createdAt, updatedAt: createdAt,
  }]);
});
