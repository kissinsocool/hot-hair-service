const test = require('node:test');
const assert = require('node:assert/strict');
const registerClientFavoriteRoutes = require('./client-favorites');

const collectRoutes = (ctx) => {
  const routes = new Map();
  const app = {
    get(path, handler) { routes.set(`GET ${path}`, handler); },
    put(path, handler) { routes.set(`PUT ${path}`, handler); },
    delete(path, handler) { routes.set(`DELETE ${path}`, handler); },
  };
  registerClientFavoriteRoutes(app, {
    normalizeUserId: value => String(value).replace(/^user-/, ''),
    async readFavoriteTargetIds(kind) { return kind === 'staff' ? ['staff-1'] : ['post-1']; },
    async readFavoriteStaff() { return [{ id: 'staff-1' }]; },
    async readFavoritePosts() { return [{ id: 'post-1' }]; },
    async favoriteTargetExists() { return true; },
    async setFavoriteTarget() {},
    async countStaffFavorites() { return 0; },
    ...ctx,
  });
  return routes;
};

const call = async (handler, params = {}) => {
  const response = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
  await handler({ clientUser: { id: 'user-1' }, params }, response);
  return response;
};

test('favorite staff and post routes read ids and lists for the signed-in user', async () => {
  const routes = collectRoutes();
  assert.deepEqual((await call(routes.get('GET /api/favorites/staff/ids'))).body, { staffIds: ['staff-1'] });
  assert.deepEqual((await call(routes.get('GET /api/favorites/posts/ids'))).body, { postIds: ['post-1'] });
  assert.deepEqual((await call(routes.get('GET /api/favorites/staff'))).body, [{ id: 'staff-1' }]);
  assert.deepEqual((await call(routes.get('GET /api/favorites/posts'))).body, [{ id: 'post-1' }]);
});

test('favorite writes pass the normalized user id and return the stylist favorite count', async () => {
  const writes = [];
  let count = 0;
  const routes = collectRoutes({
    async setFavoriteTarget(kind, userId, targetId, favorite) {
      writes.push([kind, userId, targetId, favorite]);
      count = favorite ? 1 : 0;
    },
    async countStaffFavorites() { return count; },
  });
  assert.deepEqual((await call(routes.get('PUT /api/favorites/staff/:id'), { id: 'staff-1' })).body, { favorite: true, favoriteCount: 1 });
  assert.deepEqual((await call(routes.get('DELETE /api/favorites/staff/:id'), { id: 'staff-1' })).body, { favorite: false, favoriteCount: 0 });
  assert.deepEqual((await call(routes.get('PUT /api/favorites/posts/:id'), { id: 'post-1' })).body, { favorite: true });
  assert.deepEqual(writes, [
    ['staff', '1', 'staff-1', true],
    ['staff', '1', 'staff-1', false],
    ['posts', '1', 'post-1', true],
  ]);
});

test('favoriting a hidden or missing target is rejected while unfavoriting still succeeds', async () => {
  const writes = [];
  const routes = collectRoutes({
    async favoriteTargetExists() { return false; },
    async setFavoriteTarget(...args) { writes.push(args); },
  });
  const rejected = await call(routes.get('PUT /api/favorites/posts/:id'), { id: 'post-gone' });
  assert.equal(rejected.statusCode, 404);
  const removed = await call(routes.get('DELETE /api/favorites/posts/:id'), { id: 'post-gone' });
  assert.equal(removed.statusCode, 200);
  assert.deepEqual(writes, [['posts', '1', 'post-gone', false]]);
  assert.equal((await call(routes.get('PUT /api/favorites/staff/:id'), { id: ' ' })).statusCode, 400);
});
