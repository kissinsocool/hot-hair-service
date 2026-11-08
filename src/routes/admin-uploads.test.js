const assert = require('node:assert/strict');
const test = require('node:test');

// Exercise real OSS policy generation without credentials or network access.
Object.assign(process.env, {
  OSS_ACCESS_KEY_ID: 'test-key', OSS_ACCESS_KEY_SECRET: 'test-secret',
  OSS_BUCKET: 'test-media', OSS_PRIVATE_BUCKET: 'test-private',
  OSS_PUBLIC_BASE_URL: 'https://media.example.com',
  OSS_PUBLIC_UPLOAD_URL: 'https://test-media.oss-cn-beijing.aliyuncs.com',
  OSS_REGION: 'oss-cn-beijing', OSS_ENDPOINT: 'https://oss-cn-beijing.aliyuncs.com',
});
const { createMerchantUploadPolicies } = require('../images');
const { defaultCampaign, validateCampaignInput, campaignPayload } = require('../coupons');
const registerAdminRoutes = require('./admin');

function setup() {
  const routes = new Map();
  const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map(method => [
    method, (path, ...handlers) => routes.set(`${method}:${path}`, handlers),
  ]));
  const saved = [];
  const limiter = (_req, _res, next) => next();
  const model = { findOneAndUpdate(_query, value) {
    saved.push(value);
    return { lean: async () => value };
  } };
  registerAdminRoutes(app, {
    createMerchantUploadPolicies, rateLimits: { upload: [limiter] },
    AdConfig: model, CouponCampaign: model,
    UserCoupon: { countDocuments: async () => 0, aggregate: async () => [] },
    normalizeAdLink: value => value, buildAdPayload: value => value,
    validateCampaignInput, campaignPayload,
  });
  return { saved, routes, limiter, async request(method, path, body) {
    const res = { statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(value) { this.body = value; return this; } };
    await routes.get(`${method}:/api/admin/${path}`).at(-1)({ body, adminUser: { id: 'admin-1' } }, res);
    return res;
  } };
}

test('admin signing uses public media, exact keys and existing size/type limits', async () => {
  const f = setup();
  assert.equal(f.routes.get('post:/api/admin/uploads/sign')[0], f.limiter);
  const response = await f.request('post', 'uploads/sign', {
    type: 'qualification', userId: 'forged',
    files: [{ fileName: 'ad.png', contentType: 'image/png', size: 100 }],
  });
  assert.equal(response.statusCode, 200);
  const upload = response.body.uploads[0];
  const expected = createMerchantUploadPolicies({ type: 'public', userId: 'admin:admin-1',
    files: [{ fileName: 'ad.png', contentType: 'image/png', size: 100 }] })[0];
  assert.equal(upload.objectName.split('/')[1], expected.objectName.split('/')[1]);
  assert.equal(upload.url, `https://media.example.com/${upload.objectName}`);
  const policy = JSON.parse(Buffer.from(upload.fields.policy, 'base64').toString());
  assert.ok(policy.conditions.some(c => c[0] === 'eq' && c[1] === '$key' && c[2] === upload.objectName));
  assert.ok(policy.conditions.some(c => c[0] === 'content-length-range' && c[2] === 5 * 1024 * 1024));
  for (const files of [[], [{ fileName: 'a.svg', contentType: 'image/svg+xml', size: 10 }],
    [{ fileName: 'a.png', contentType: 'image/png', size: 5 * 1024 * 1024 + 1 }]]) {
    assert.equal((await f.request('post', 'uploads/sign', { files })).statusCode, 400);
  }
});

test('both save endpoints require URLs for enabled images; Base64 cannot replace a URL', async () => {
  const f = setup();
  const url = 'https://media.example.com/uploads/new.png';
  for (const base64Only of [false, true]) {
    const ad = await f.request('patch', 'ad', {
      imageUrl: base64Only ? '' : url, link: '/pages/home/home', enabled: true,
      ...(base64Only ? { fileName: 'ad.png', data: 'data:image/png;base64,iVBORw0KGgo=' } : {}),
    });
    assert.equal(ad.statusCode, base64Only ? 400 : 200);
    if (!base64Only) assert.equal(ad.body.imageUrl, url);
    const campaign = await f.request('patch', 'campaigns/new-user-registration', {
      ...defaultCampaign(), enabled: true,
      registrationStartAt: '2026-11-01T00:00:00.000Z', registrationEndAt: '2026-12-01T00:00:00.000Z',
      promotionImageUrl: base64Only ? '' : url,
      ...(base64Only ? { promotionImageFileName: 'gift.png', promotionImageData: 'data:image/png;base64,iVBORw0KGgo=' } : {}),
    });
    assert.equal(campaign.statusCode, base64Only ? 400 : 200);
    if (!base64Only) assert.equal(campaign.body.campaign.promotionImageUrl, url);
  }
  assert.equal(f.saved.length, 2);
});
