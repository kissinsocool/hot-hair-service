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
