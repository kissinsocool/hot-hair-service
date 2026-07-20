const assert = require('node:assert/strict');
const test = require('node:test');
const { readLoadTestConfig } = require('./create-load-test-users');

test('load-test token generation is bounded and blocked in production', () => {
  assert.deepEqual(readLoadTestConfig({
    MONGODB_URI: 'mongodb://example/test',
    K6_TOKEN_COUNT: '5',
    K6_USER_PREFIX: 'K6-Team',
  }), {
    mongoUri: 'mongodb://example/test',
    count: 5,
    prefix: 'k6-team',
  });
  assert.throws(
    () => readLoadTestConfig({ NODE_ENV: 'production', MONGODB_URI: 'mongodb://example/test' }),
    /production/,
  );
  assert.throws(
    () => readLoadTestConfig({ MONGODB_URI: 'mongodb://example/test', K6_TOKEN_COUNT: '51' }),
    /1 to 50/,
  );
});
