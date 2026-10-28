const assert = require('node:assert/strict');
const test = require('node:test');
const registerMerchant = require('./merchant');
const { Salon } = require('../models');
const { servicePayload } = require('../services/salon');
const {
  applyDirectSalonContent, buildContentDraft, hasReviewableContentChanges, INPUT_LIMITS,
} = require('../../index');

function harness() {
  const service = {
    id: 'S1', name: '剪发', tags: ['洗剪吹'], tagIds: ['wash_cut_blow'],
    priceFen: 8000, durationMinutes: 60, note: '', imageUrl: '',
  };
  const salon = new Salon({ id: 'duration-salon', name: '门店', services: [service] });
  let saves = 0;
  salon.save = async () => { await salon.validate(); saves += 1; };
  const live = () => ({ name: salon.name, services: salon.services.map(servicePayload), staff: [] });
  const routes = new Map();
  const app = Object.fromEntries(['get', 'post', 'patch', 'delete'].map(method => [method,
    (path, ...handlers) => routes.set(`${method}:${path}`, handlers.at(-1)),
  ]));
  registerMerchant(app, {
    Salon: { findOne: () => Object.assign(Promise.resolve(salon), { lean: async () => null }) }, INPUT_LIMITS,
    rateLimits: { upload: [], login: [], publicRead: [], merchantBooking: [] },
    buildSalonDetail: async () => live(), buildMerchantSalonPayload: async () => live(),
    buildContentDraft, applyDirectSalonContent, hasReviewableContentChanges,
  });
  return {
    salon, service, get saves() { return saves; },
    async save(body) {
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(value) { this.body = value; },
      };
      await routes.get('patch:/api/merchant/salon')({
        merchantUser: { salonId: salon.id }, body,
      }, res);
      return res;
    },
  };
}

test('merchant service duration accepts current client options and the 180-minute boundary', async () => {
  const h = harness();
  for (const durationMinutes of [1, 30, 45, 60, 90, 120, 150, 180]) {
    const response = await h.save({ services: [{ ...h.service, durationMinutes }] });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.services[0].durationMinutes, durationMinutes);
    assert.equal(h.salon.services[0].durationMinutes, durationMinutes);
  }
});

test('merchant rejects invalid service durations before writing live content or review drafts', async () => {
  const h = harness();
  for (const durationMinutes of [181, 240, Number.MAX_SAFE_INTEGER, 0, -1, 1.5, '180', null, undefined]) {
    const response = await h.save({ services: [{ ...h.service, name: '新套餐', durationMinutes }] });
    assert.equal(response.statusCode, 400, String(durationMinutes));
    if (durationMinutes > 180) assert.equal(response.body.message, '套餐时长不能超过180分钟');
    assert.equal(h.salon.services[0].durationMinutes, 60);
    assert.equal(h.salon.pendingContent, undefined);
    assert.equal(h.saves, 0);
  }
});

test('new service review drafts accept 180 minutes and legacy tag requests keep working', async () => {
  const h = harness();
  const { tagIds, ...legacyService } = h.service;
  const response = await h.save({ services: [{ ...legacyService, id: 'S2', name: '新套餐', durationMinutes: 180 }] });
  assert.equal(response.statusCode, 200);
  assert.equal(h.salon.pendingContent.services[0].durationMinutes, 180);
});

test('historical long services do not block unrelated salon saves and can be shortened', async () => {
  const h = harness();
  h.salon.services[0].durationMinutes = 240;
  assert.equal((await h.save({ phone: '13800000000' })).statusCode, 200);
  assert.equal(h.salon.services[0].durationMinutes, 240);
  assert.equal((await h.save({ services: [{ ...h.service, durationMinutes: 180 }] })).statusCode, 200);
  assert.equal(h.salon.services[0].durationMinutes, 180);
});
