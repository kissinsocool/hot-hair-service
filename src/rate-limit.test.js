const assert = require('node:assert/strict');
const test = require('node:test');
const { createRateLimiter } = require('./rate-limit');

test('rate limiter rejects excess requests with retry guidance', () => {
  let time = 0;
  const limit = createRateLimiter({ name: 'test', limit: 2, windowMs: 1000, key: () => 'same-user', now: () => time });
  const responses = [];
  const request = () => limit({}, {
    set(name, value) { this[name] = value; },
    status(value) { this.statusCode = value; return this; },
    json(body) { responses.push({ status: this.statusCode, retryAfter: this['Retry-After'], body }); },
  }, () => responses.push({ status: 200 }));

  request();
  request();
  request();
  assert.deepEqual(responses.map(item => item.status), [200, 200, 429]);
  assert.equal(responses[2].retryAfter, '1');

  time = 500;
  request();
  assert.equal(responses.at(-1).status, 200);
});
