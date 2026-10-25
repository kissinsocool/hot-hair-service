const assert = require('node:assert/strict');
const test = require('node:test');
const registerMerchant = require('./merchant');
const { Salon } = require('../models');
const { serviceForStorage, servicePayload } = require('../services/salon');
const {
  applyDirectSalonContent, buildContentDraft, hasReviewableContentChanges,
  INPUT_LIMITS,
} = require('../../index');

const oldService = {
  id: 'S1', name: '剪发', tags: ['洗剪吹'], tagIds: ['wash_cut_blow'],
  priceFen: 196400, durationMinutes: 60, note: '套餐', imageUrl: '',
};

function harness() {
  const salon = new Salon({ id: 'discount-salon', name: '门店', services: [oldService] });
  salon.save = async () => { await salon.validate(); };
  const live = () => ({ name: salon.name, services: salon.services.map(servicePayload), staff: [] });
  const routes = new Map();
  const app = Object.fromEntries(['get', 'post', 'patch', 'delete'].map(method => [method,
    (path, ...handlers) => routes.set(`${method}:${path}`, handlers.at(-1)),
  ]));
  registerMerchant(app, {
    Salon: { findOne: async () => salon },
    INPUT_LIMITS, rateLimits: { upload: [], login: [], publicRead: [], merchantBooking: [] },
    buildSalonDetail: async () => live(), buildMerchantSalonPayload: async () => live(),
    buildContentDraft, applyDirectSalonContent, hasReviewableContentChanges,
  });
  return { salon, async save(service) {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
    await routes.get('patch:/api/merchant/salon')({ merchantUser: { salonId: salon.id }, body: { services: [service] } }, res);
    return res;
  } };
}

test('released merchant request, new discount, omitted field and explicit clear round trip', async () => {
  const h = harness();
  assert.equal((await h.save(oldService)).statusCode, 200);
  const updated = await h.save({ ...oldService, discountTenths: 65 });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.body.services[0].discountTenths, 65);
  assert.equal(updated.body.services[0].priceFen, 196400);
  assert.equal(h.salon.contentReviewStatus, 'approved');
  // Released clients can still send the old full service shape, without dropping the discount.
  const legacy = await h.save(oldService);
  assert.equal(legacy.body.services[0].discountTenths, 65);
  assert.equal((await h.save({ ...oldService, discountTenths: null })).body.services[0].discountTenths, null);
});

test('invalid discount is rejected before storage and boundary values are accepted', async () => {
  const h = harness();
  for (const value of [0, -1, 101, 65.5, '65', false]) {
    const response = await h.save({ ...oldService, discountTenths: value });
    assert.equal(response.statusCode, 400, String(value));
    assert.equal(h.salon.services[0].discountTenths, undefined);
  }
  for (const value of [1, 100]) {
    assert.equal((await h.save({ ...oldService, discountTenths: value })).statusCode, 200);
  }
});

test('discount survives real Mongoose subdocuments, pending drafts and legacy normalization', async () => {
  const h = harness();
  await h.save({ ...oldService, discountTenths: 60 });
  assert.equal(servicePayload(h.salon.services[0]).discountTenths, 60);
  assert.equal(serviceForStorage(oldService, oldService.id, h.salon.services[0]).discountTenths, 60);
  const draft = await buildContentDraft(h.salon, { services: [{ ...oldService, name: '新套餐' }] }, {
    services: h.salon.services.map(servicePayload), staff: [],
  });
  assert.equal(draft.services[0].discountTenths, 60);
  h.salon.pendingContent = draft;
  await h.salon.validate();
  assert.equal(h.salon.pendingContent.services[0].discountTenths, 60);
});

test('original 280 at 9折 stores selling 252 and returns the original without inversion', async () => {
  const h = harness();
  const result = await h.save({ ...oldService, originalPriceFen: 28000, discountTenths: 90, priceFen: 25200 });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.services[0].originalPriceFen, 28000);
  assert.equal(result.body.services[0].priceFen, 25200);
  assert.equal(servicePayload(h.salon.services[0]).originalPriceFen, 28000);
  const draft = await buildContentDraft(h.salon, {
    services: [{ ...result.body.services[0], name: '新名称' }],
  }, { services: result.body.services, staff: [] });
  h.salon.pendingContent = draft;
  await h.salon.validate();
  assert.equal(h.salon.pendingContent.services[0].originalPriceFen, 28000);
  assert.equal(h.salon.pendingContent.services[0].priceFen, 25200);

  const legacyEcho = { ...result.body.services[0], priceFen: 30000 };
  const legacyEdit = await h.save(legacyEcho);
  assert.equal(legacyEdit.statusCode, 200);
  assert.equal(legacyEdit.body.services[0].priceFen, 30000);
  assert.equal(legacyEdit.body.services[0].originalPriceFen, null);
  assert.equal(legacyEdit.body.services[0].discountTenths, null);
});

test('new original price must be valid and match the selling price', async () => {
  for (const originalPriceFen of [-1, 280.1, '28000', false, 28000]) {
    const h = harness();
    const result = await h.save({ ...oldService, originalPriceFen, discountTenths: 90 });
    assert.equal(result.statusCode, 400, String(originalPriceFen));
  }
});

test('released clients omitting original price retain it until selling price changes', async () => {
  const h = harness();
  await h.save({ ...oldService, originalPriceFen: 28000, discountTenths: 90, priceFen: 25200 });
  const unchanged = await h.save({ ...oldService, priceFen: 25200 });
  assert.equal(unchanged.body.services[0].originalPriceFen, 28000);
  const changed = await h.save({ ...oldService, priceFen: 30000 });
  assert.equal(changed.body.services[0].originalPriceFen, null);
  assert.equal(changed.body.services[0].priceFen, 30000);
});

test('backend rounds discounted prices to yuan for released and integer-price merchant requests', async () => {
  for (const [originalPriceFen, discountTenths, legacyPriceFen, expected] of [
    [9900, 90, 8910, 8900],
    [9950, 90, 8955, 9000],
    [10000, 65, 6500, 6500],
    [10050, 1, 101, 100],
    [5000, 1, 50, 100],
    [4900, 1, 49, 0],
  ]) {
    const h = harness();
    const request = { ...oldService, originalPriceFen, discountTenths, priceFen: legacyPriceFen };
    const integerRequest = await harness().save({ ...request, priceFen: expected });
    assert.equal(integerRequest.statusCode, 200);
    assert.equal(integerRequest.body.services[0].priceFen, expected);
    const saved = await h.save(request);
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.body.services[0].priceFen, expected);
    assert.equal(h.salon.services[0].priceFen, expected);
    assert.equal(saved.body.services[0].originalPriceFen, originalPriceFen);
    assert.equal(saved.body.services[0].discountTenths, discountTenths);
    // The released editor recalculates cents when loading; saving again must be stable.
    assert.equal((await h.save(request)).body.services[0].priceFen, expected);
    assert.equal((await h.save({ ...request, priceFen: expected })).body.services[0].priceFen, expected);
    const draft = await buildContentDraft(h.salon, {
      services: [{ ...saved.body.services[0], name: '新套餐名称' }],
    }, { services: saved.body.services, staff: [] });
    assert.equal(draft.services[0].priceFen, expected);
    assert.equal(draft.services[0].originalPriceFen, originalPriceFen);
    const cleared = await h.save({ ...request, discountTenths: null, priceFen: originalPriceFen });
    assert.equal(cleared.body.services[0].priceFen, originalPriceFen);
  }
});

test('undiscounted fractions and historical stored prices are not rounded on reads', async () => {
  for (const discountTenths of [null, 100]) {
    const h = harness();
    const saved = await h.save({ ...oldService, originalPriceFen: 9950, discountTenths, priceFen: 9950 });
    assert.equal(saved.body.services[0].priceFen, 9950);
  }
  const historical = new Salon({ services: [{ ...oldService, originalPriceFen: 9950, discountTenths: 90, priceFen: 8955 }] });
  assert.equal(servicePayload(historical.services[0]).priceFen, 8955);
  assert.equal(servicePayload(historical.services[0]).originalPriceFen, 9950);
});
