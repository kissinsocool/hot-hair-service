const assert = require('node:assert/strict');
const test = require('node:test');
const registerMerchant = require('./merchant');
const { Salon } = require('../models');
const {
  normalizeUnavailableSlots,
  withoutExpiredUnavailableSlots,
  withoutExpiredStaffUnavailableSlots,
} = require('../services/booking');
const { INPUT_LIMITS } = require('../../index');

// 2030-05-10 23:30 in Shanghai is still 2030-05-10 15:30 UTC; half an hour later the business day changes.
const beforeMidnight = new Date('2030-05-10T15:30:00Z');
const afterMidnight = new Date('2030-05-10T16:00:00Z');

test('unavailable slots dated before today in the business time zone are dropped', () => {
  const slots = ['2030-05-09 10:00', '2030-05-10 09:00', '2030-05-10 23:30', '2030-05-11 00:00', '2031-01-01 10:00'];
  assert.deepEqual(withoutExpiredUnavailableSlots(slots, beforeMidnight), slots.slice(1));
  // Earlier slots of today stay: the day is the unit, and they no longer matter once it ends.
  assert.deepEqual(withoutExpiredUnavailableSlots(slots, afterMidnight), slots.slice(3));
});

test('pruning leaves malformed entries and non-lists for validation to judge', () => {
  const mixed = [' 2020-01-01 10:00 ', 'not-a-slot', 42, null, '2020-01-01', '2099-01-01 10:00'];
  assert.deepEqual(withoutExpiredUnavailableSlots(mixed, beforeMidnight), ['not-a-slot', 42, null, '2020-01-01', '2099-01-01 10:00']);
  assert.equal(withoutExpiredUnavailableSlots(undefined, beforeMidnight), undefined);
  assert.equal(withoutExpiredUnavailableSlots('2020-01-01 10:00', beforeMidnight), '2020-01-01 10:00');
});

test('staff lists are pruned per stylist without touching other fields', () => {
  const staff = [
    { id: 'a', name: 'Ann', unavailableSlots: ['2020-01-01 10:00', '2099-01-01 10:00'] },
    { id: 'b', name: 'Bob' },
    null,
  ];
  assert.deepEqual(withoutExpiredStaffUnavailableSlots(staff, beforeMidnight), [
    { id: 'a', name: 'Ann', unavailableSlots: ['2099-01-01 10:00'] },
    { id: 'b', name: 'Bob' },
    null,
  ]);
  assert.equal(withoutExpiredStaffUnavailableSlots(undefined, beforeMidnight), undefined);
});

test('reading stored slots is unchanged: past slots still normalize', () => {
  assert.deepEqual(normalizeUnavailableSlots(['2020-01-01 10:00', '2099-01-01 10:00']),
    ['2020-01-01 10:00', '2099-01-01 10:00']);
});

const slotsOn = (year, count) => Array.from({ length: count }, (_, index) => {
  const day = String(1 + Math.floor(index / 48) % 28).padStart(2, '0');
  const month = String(1 + Math.floor(index / (48 * 28))).padStart(2, '0');
  const minutes = (index % 48) * 30;
  return `${year}-${month}-${day} ${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
});

function harness() {
  const salon = new Salon({ id: 'slots-salon', name: '门店', staffIds: ['staff-1'] });
  salon.save = async () => {};
  const received = {};
  const routes = new Map();
  const app = Object.fromEntries(['get', 'post', 'patch', 'delete'].map(method => [method,
    (path, ...handlers) => routes.set(`${method}:${path}`, handlers.at(-1)),
  ]));
  registerMerchant(app, {
    Salon: { findOne: () => Object.assign(Promise.resolve(salon), { lean: async () => null }) },
    INPUT_LIMITS,
    rateLimits: { upload: [], login: [], publicRead: [], merchantBooking: [] },
    validateSalonStaffIds: async () => '',
    buildSalonDetail: async () => ({ staff: [] }),
    buildMerchantSalonPayload: async () => ({}),
    buildContentDraft: async (_salon, payload) => { received.draft = payload.staff; return {}; },
    applyDirectSalonContent: async (_salon, payload) => { received.direct = payload.staff; },
    hasReviewableContentChanges: () => false,
  });
  return {
    received,
    async save(unavailableSlots) {
      const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; } };
      await routes.get('patch:/api/merchant/salon')({
        merchantUser: { salonId: salon.id },
        body: { staff: [{ id: 'staff-1', name: 'Ann', roleId: 'designer', extraServiceFeeFen: 0, unavailableSlots }] },
      }, res);
      return res;
    },
  };
}

test('a stylist with a full list of past slots can be saved, and only current slots are written', async () => {
  const h = harness();
  const future = slotsOn(2099, 20);
  const response = await h.save([...slotsOn(2020, 500), ...future]);

  assert.equal(response.statusCode, 200);
  // Both write paths (direct changes and the review draft) receive the pruned list.
  assert.deepEqual(h.received.direct[0].unavailableSlots, future);
  assert.deepEqual(h.received.draft[0].unavailableSlots, future);
});

test('the limit still applies to slots that have not passed', async () => {
  const h = harness();
  assert.equal((await h.save(slotsOn(2099, 500))).statusCode, 200);

  const rejected = harness();
  const response = await rejected.save([...slotsOn(2020, 10), ...slotsOn(2099, 501)]);
  assert.equal(response.statusCode, 400);
  assert.match(response.body.message, /unavailableSlots cannot exceed 500/);
  assert.equal(rejected.received.direct, undefined);
});

test('approving a draft publishes only the slots that have not passed while it waited', async (t) => {
  const { applyPendingContent } = require('../../index');
  const { StaffProfile } = require('../models');
  const written = [];
  for (const [Model, method, replacement] of [
    [Salon, 'exists', async () => null],
    [StaffProfile, 'exists', async () => null],
    [StaffProfile, 'findOneAndUpdate', async (_filter, update) => { written.push(update.$set); }],
  ]) {
    const original = Model[method];
    Model[method] = replacement;
    t.after(() => { Model[method] = original; });
  }
  const salon = new Salon({
    id: 'slots-draft-salon', name: '门店', staffIds: ['staff-1'],
    pendingContent: { staff: [{
      id: 'staff-1', name: 'Ann', roleId: 'designer', extraServiceFeeFen: 0,
      unavailableSlots: ['2020-01-01 10:00', '2099-01-01 10:00'],
    }] },
  });

  await applyPendingContent(salon);

  assert.equal(written.length, 1);
  assert.deepEqual([...written[0].unavailableSlots], ['2099-01-01 10:00']);
  assert.equal(written[0].name, 'Ann');
});
