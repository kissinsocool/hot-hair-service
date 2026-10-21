const assert = require('node:assert/strict');
const test = require('node:test');
const { Salon, MerchantUser } = require('../models');
const { BUSINESS_DISTRICTS } = require('../services/business-districts');
const registerAdminRoutes = require('./admin');

function setup() {
  const routes = new Map();
  const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map(method => [
    method, (path, ...handlers) => routes.set(`${method}:${path}`, handlers.at(-1)),
  ]));
  const salon = new Salon({ id: 'district-salon', tags: ['人气店铺'], businessDistrict: '国贸', isFeatured: true });
  const user = new MerchantUser({ id: 'district-merchant', username: 'merchant', displayName: 'merchant', salonId: salon.id });
  let saves = 0;
  salon.save = async () => { await salon.validate(); saves += 1; return salon; };
  user.save = async () => user;
  registerAdminRoutes(app, {
    rateLimits: { upload: [] },
    MerchantUser: { findOne: async query => query.id ? user : null, create: async value => value },
    Salon: { findOne: async () => salon },
    normalizeDeposit: value => Number(value),
    normalizeSalonTags: value => value,
    ensureSalonForMerchant: async () => salon,
    hashPassword: async () => ({ salt: 'salt', hash: 'hash' }),
    buildMerchantUserPayload: value => ({ id: value.id }),
    clearPublicSalonDetailCache: () => {},
  });
  return {
    salon, saves: () => saves,
    async request(method, body) {
      const response = {
        statusCode: 200, body: null,
        status(code) { this.statusCode = code; return this; },
        json(value) { this.body = value; return this; },
      };
      await routes.get(`${method}:/api/admin/merchants${method === 'patch' ? '/:id' : ''}`)(
        { params: { id: user.id }, body }, response,
      );
      return response;
    },
  };
}

// Matches the released admin client's request, which has no businessDistrict.
const legacyBody = {
  username: 'merchant', displayName: 'merchant', salonId: 'district-salon',
  deposit: '0', tags: ['人气店铺'], password: '123456',
};

for (const method of ['post', 'patch']) {
  test(`${method} accepts the released admin request and preserves the district`, async () => {
    const fixture = setup();
    const response = await fixture.request(method, legacyBody);
    assert.equal(response.statusCode, method === 'post' ? 201 : 200);
    assert.equal(fixture.salon.businessDistrict, '国贸');
    assert.equal(fixture.salon.isFeatured, true);
  });

  test(`${method} persists all static districts and allows clearing`, async () => {
    const fixture = setup();
    for (const businessDistrict of [...BUSINESS_DISTRICTS, '']) {
      const response = await fixture.request(method, { ...legacyBody, businessDistrict });
      assert.equal(response.statusCode, method === 'post' ? 201 : 200);
      assert.equal(fixture.salon.toObject().businessDistrict, businessDistrict);
      assert.deepEqual(fixture.salon.toObject().tags, legacyBody.tags);
    }
  });

  test(`${method} rejects invalid districts before saving`, async () => {
    const fixture = setup();
    for (const businessDistrict of ['未知商圈', null, [], {}, 123]) {
      const response = await fixture.request(method, { ...legacyBody, businessDistrict });
      assert.equal(response.statusCode, 400);
      assert.equal(fixture.salon.businessDistrict, '国贸');
    }
    assert.equal(fixture.saves(), 0);
  });
}

test('updating only the district preserves existing tags', async () => {
  const fixture = setup();
  const response = await fixture.request('patch', { businessDistrict: '旧宫' });
  assert.equal(response.statusCode, 200);
  assert.equal(fixture.salon.businessDistrict, '旧宫');
  assert.deepEqual(fixture.salon.toObject().tags, ['人气店铺']);
});

test('merchant content drafts cannot overwrite the admin-managed district', () => {
  const salon = new Salon({
    id: 'pending-district', businessDistrict: '国贸',
    pendingContent: { name: '待审核店名', businessDistrict: '黄村' },
  });
  assert.equal(salon.toObject().pendingContent.businessDistrict, undefined);
  assert.equal(salon.businessDistrict, '国贸');
});


test('admin options endpoint returns the same districts accepted by writes', async () => {
  const routes = new Map();
  const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map(method => [
    method, (path, ...handlers) => routes.set(`${method}:${path}`, handlers.at(-1)),
  ]));
  registerAdminRoutes(app, { rateLimits: { upload: [] } });
  let payload;
  const headers = {};
  await routes.get('get:/api/admin/business-districts')({}, {
    set(name, value) { headers[name] = value; },
    json(value) { payload = value; },
  });
  assert.deepEqual(payload, BUSINESS_DISTRICTS);
  assert.equal(headers['Cache-Control'], 'no-store');
  for (const businessDistrict of payload) {
    const fixture = setup();
    const response = await fixture.request('patch', { businessDistrict });
    assert.equal(response.statusCode, 200);
    assert.equal(fixture.salon.businessDistrict, businessDistrict);
  }
});
