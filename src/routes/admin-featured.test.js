const assert = require('node:assert/strict');
const test = require('node:test');
const { Salon } = require('../models');
const { stripSensitiveSalonFields } = require('../services/salon');
const registerAdminRoutes = require('./admin');

function setup({ missingMerchant = false, missingSalon = false, failSave = false } = {}) {
  const routes = new Map();
  const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map(method => [
    method, (path, ...handlers) => routes.set(`${method}:${path}`, handlers.at(-1)),
  ]));
  const salon = new Salon({ id: 'salon-1', publishStatus: 'offline', tags: ['人气店铺'] });
  let clears = 0;
  let saves = 0;
  salon.save = async () => {
    if (failSave) throw new Error('save failed');
    await salon.validate();
    saves += 1;
    return salon;
  };
  registerAdminRoutes(app, {
    rateLimits: { upload: [] },
    MerchantUser: { findOne(query) {
      assert.deepEqual(query, { id: 'merchant-1' });
      return { lean: async () => missingMerchant ? null : { id: 'merchant-1', salonId: salon.id } };
    } },
    Salon: { findOne: async query => {
      assert.deepEqual(query, { id: salon.id });
      return missingSalon ? null : salon;
    } },
    buildAdminMerchantPayload: async (user, value) => ({ id: user.id, salon: stripSensitiveSalonFields(value.toObject()) }),
    clearPublicSalonDetailCache: () => { clears += 1; },
  });
  return {
    salon, clears: () => clears, saves: () => saves,
    async request(body) {
      const res = {
        statusCode: 200, body: null,
        status(code) { this.statusCode = code; return this; },
        json(value) { this.body = value; return this; },
      };
      await routes.get('patch:/api/admin/merchants/:id/featured')({ params: { id: 'merchant-1' }, body }, res);
      return res;
    },
  };
}

test('featured defaults off for new and legacy salons', () => {
  assert.equal(new Salon({ id: 'new' }).isFeatured, false);
  assert.equal(stripSensitiveSalonFields({ id: 'legacy' }).isFeatured, false);
});

test('admin enables and disables featured without changing publication or tags', async () => {
  const fixture = setup();
  for (const isFeatured of [true, false]) {
    const response = await fixture.request({ isFeatured });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.merchant.salon.isFeatured, isFeatured);
    assert.equal(fixture.salon.toObject().isFeatured, isFeatured);
    assert.equal(fixture.salon.publishStatus, 'offline');
    assert.deepEqual(fixture.salon.toObject().tags, ['人气店铺']);
  }
  assert.equal(fixture.saves(), 2);
  assert.equal(fixture.clears(), 2);
});

test('featured rejects absent and non-boolean values without writes', async () => {
  const fixture = setup();
  for (const body of [{}, { isFeatured: null }, { isFeatured: 'true' }, { isFeatured: 1 }, { isFeatured: [] }, { isFeatured: {} }]) {
    assert.equal((await fixture.request(body)).statusCode, 400);
  }
  assert.equal(fixture.saves(), 0);
  assert.equal(fixture.clears(), 0);
});

for (const missing of ['missingMerchant', 'missingSalon']) {
  test(`featured returns 404 for ${missing}`, async () => {
    const fixture = setup({ [missing]: true });
    assert.equal((await fixture.request({ isFeatured: true })).statusCode, 404);
    assert.equal(fixture.saves(), 0);
    assert.equal(fixture.clears(), 0);
  });
}

test('save failure propagates and does not invalidate cache as a successful write', async () => {
  const fixture = setup({ failSave: true });
  await assert.rejects(fixture.request({ isFeatured: true }), /save failed/);
  assert.equal(fixture.clears(), 0);
});
