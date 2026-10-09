const assert = require('node:assert/strict');
const test = require('node:test');
const { readCleanupConfig } = require('./cleanup-load-test-data');

test('cleanup is a dry run unless the batch-specific confirmation matches', () => {
  const base = {
    MONGODB_URI: 'mongodb://example/test',
    K6_USER_PREFIX: 'K6-Team',
    K6_RUN_ID: 'Run-20260804',
  };
  assert.equal(readCleanupConfig(base).apply, false);
  assert.equal(readCleanupConfig({
    ...base,
    K6_CLEANUP_CONFIRM: 'delete-k6-run-20260804',
  }).apply, true);
});

test('cleanup rejects a missing or unsafe run id', () => {
  assert.throws(
    () => readCleanupConfig({ MONGODB_URI: 'mongodb://example/test' }),
    /K6_RUN_ID/,
  );
  assert.throws(
    () => readCleanupConfig({ MONGODB_URI: 'mongodb://example/test', K6_RUN_ID: 'run.*' }),
    /K6_RUN_ID/,
  );
});
