const assert = require('node:assert/strict');
const test = require('node:test');
const { readLoadTestConfig } = require('./create-load-test-users');

test('load-test token generation is bounded and requires batch confirmation', () => {
  assert.deepEqual(readLoadTestConfig({
    MONGODB_URI: 'mongodb://example/test',
    K6_TOKEN_COUNT: '5',
    K6_USER_PREFIX: 'K6-Team',
    K6_RUN_ID: 'Run-20260804',
    K6_CREATE_CONFIRM: 'create-k6-run-20260804',
  }), {
    mongoUri: 'mongodb://example/test',
    count: 5,
    prefix: 'k6-team',
    runId: 'run-20260804',
  });
  assert.throws(
    () => readLoadTestConfig({
      MONGODB_URI: 'mongodb://example/test',
      K6_RUN_ID: 'run-1',
    }),
    /K6_CREATE_CONFIRM/,
  );
  assert.throws(
    () => readLoadTestConfig({
      MONGODB_URI: 'mongodb://example/test',
      K6_RUN_ID: 'run-1',
      K6_CREATE_CONFIRM: 'create-k6-run-1',
      K6_TOKEN_COUNT: '51',
    }),
    /1 to 50/,
  );
});

test('creation confirmation must exactly match the normalized run id', () => {
  assert.equal(readLoadTestConfig({
    MONGODB_URI: 'mongodb://example/test',
    K6_RUN_ID: 'Run-1',
    K6_CREATE_CONFIRM: 'create-k6-run-1',
  }).runId, 'run-1');
});
