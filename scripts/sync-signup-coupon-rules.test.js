const test = require('node:test');
const assert = require('node:assert/strict');
const { CouponCampaign, UserCoupon } = require('../src/models');
const { defaultCampaign, CAMPAIGN_KEY } = require('../src/coupons');
const { campaignTemplates, syncableFilter, outdatedFilter } = require('./sync-signup-coupon-rules');

const campaign = () => ({ ...defaultCampaign(), registrationStartAt: new Date('2026-01-01'), registrationEndAt: new Date('2035-01-01') });

test('campaign rules validate real Mongoose subdocuments through toObject and normalize text', () => {
  const doc = new CouponCampaign(campaign());
  doc.coupons[0].title = '  新规则  ';
  const templates = campaignTemplates(doc.toObject());
  assert.equal(templates[0].title, '新规则');
  assert.equal(templates.length, 2);
  assert.equal(templates[1].discountFen, 3000);
});

for (const [name, mutate] of [
  ['missing campaign', () => null],
  ['missing key', c => ({ ...c, coupons: c.coupons.slice(0, 1) })],
  ['duplicate key', c => ({ ...c, coupons: [c.coupons[0], c.coupons[0]] })],
  ['unknown key', c => { c.coupons[1].key = 'unknown'; return c; }],
  ...[undefined, null, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(amount => [
    `invalid amount ${amount}`, c => { c.coupons[1].discountFen = amount; return c; },
  ]),
  ['discount exceeds threshold', c => { c.coupons[1].discountFen = 20000; return c; }],
  ['zero minimum', c => { c.coupons[1].minimumSpendFen = 0; return c; }],
  ['fractional minimum', c => { c.coupons[1].minimumSpendFen = 19900.5; return c; }],
  ['empty title', c => { c.coupons[1].title = ' '; return c; }],
  ['long title', c => { c.coupons[1].title = 'x'.repeat(51); return c; }],
  ['long description', c => { c.coupons[1].description = 'x'.repeat(201); return c; }],
  ['invalid activity dates', c => ({ ...c, registrationEndAt: c.registrationStartAt })],
]) {
  test(`rejects ${name} before synchronization`, () => {
    assert.throws(() => campaignTemplates(mutate(campaign())));
  });
}

test('syncable filter casts without losing the legacy empty redeemedAt string and never gates validFrom or claimedAt', () => {
  const now = new Date();
  const filter = UserCoupon.find(syncableFilter('99-20', now)).cast(UserCoupon);
  assert.equal(filter.campaignKey, CAMPAIGN_KEY);
  assert.equal(filter.couponType, '99-20');
  assert.deepEqual(filter.validUntil, { $gt: now });
  assert.deepEqual(filter.reservedBookingId, { $in: ['', null] });
  assert.deepEqual(filter.$expr.$in[1], ['', null]);
  assert.equal(filter.validFrom, undefined);
  assert.equal(filter.claimedAt, undefined);
});

test('outdated filter compares all four snapshot fields including missing description', () => {
  const template = campaign().coupons[0];
  delete template.description;
  assert.deepEqual(outdatedFilter(template), { $or: [
    { minimumSpendFen: { $ne: 9900 } }, { discountFen: { $ne: 2000 } },
    { title: { $ne: template.title } }, { description: { $ne: '' } },
  ] });
});
