const test = require('node:test');
const assert = require('node:assert/strict');
const { rateLimits } = require('./rate-limit');

const [, loginAccountIp] = rateLimits.login;

const attempt = async (ip, body, path = '/api/admin/auth/login') => {
  let passed = false;
  const res = {
    statusCode: 200,
    set() { return this; },
    status(code) { this.statusCode = code; return this; },
    json() { return this; },
  };
  await loginAccountIp({ ip, body, originalUrl: path, headers: {} }, res, () => { passed = true; });
  return passed ? 200 : res.statusCode;
};

test('login limiter is keyed by account and IP, so other IPs cannot lock an account out', async () => {
  const body = { username: 'owner-lockout-check' };
  for (let i = 0; i < 10; i += 1) assert.equal(await attempt('203.0.113.10', body), 200);
  assert.equal(await attempt('203.0.113.10', body), 429, 'the guessing IP is throttled');
  assert.equal(await attempt('198.51.100.20', body), 200, 'the owner on another IP can still log in');
  assert.equal(await attempt('203.0.113.10', { username: 'another-account' }), 200, 'other accounts are counted separately');
});

test('requests without an account field are not counted by the account limiter', async () => {
  for (let i = 0; i < 20; i += 1) {
    assert.equal(await attempt('192.0.2.30', { code: 'wechat-code' }, '/api/auth/wechat/phone'), 200);
  }
});
