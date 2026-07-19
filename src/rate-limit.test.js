const assert = require('node:assert/strict');
const test = require('node:test');
const { createRateLimiter, rateLimits } = require('./rate-limit');

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
  assert.equal(responses[2].body.message, '操作频繁，请稍后再试');

  time = 500;
  request();
  assert.equal(responses.at(-1).status, 200);
});

test('short-window cleanup cannot reset another limiter bucket', () => {
  let time = 1_000_000;
  const responses = [];
  const response = () => ({
    set() {},
    status(status) { this.statusCode = status; return this; },
    json() { responses.push(this.statusCode); },
  });
  const long = createRateLimiter({ name: 'long', limit: 1, windowMs: 15 * 60_000, key: () => 'user', now: () => time });
  const short = createRateLimiter({ name: 'short', limit: 1, windowMs: 60_000, key: () => 'user', now: () => time });

  long({}, response(), () => {});
  long({}, response(), () => {});
  time += 61_000;
  short({}, response(), () => {});
  long({}, response(), () => {});

  assert.deepEqual(responses, [429, 429]);
});

test('public read limit is 50 requests per IP and route', () => {
  const limit = rateLimits.publicRead[0];
  const statuses = [];
  const response = () => ({
    set() {},
    status(value) { this.statusCode = value; return this; },
    json() { statuses.push(this.statusCode); },
  });
  const request = route => limit(
    { ip: '203.0.113.50', route: { path: route } },
    response(),
    () => statuses.push(200),
  );

  for (let index = 0; index < 50; index += 1) request('/api/salons');
  request('/api/salons');
  request('/api/salons/:id');

  assert.equal(statuses[49], 200);
  assert.equal(statuses[50], 429);
  assert.equal(statuses[51], 200);
});
