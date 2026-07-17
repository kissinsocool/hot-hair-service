const assert = require('node:assert/strict');
const test = require('node:test');
const { percentile } = require('./load-test');

test('load test percentile reports tail latency', () => {
  assert.equal(percentile([10, 20, 30, 40, 50], 0.5), 30);
  assert.equal(percentile([10, 20, 30, 40, 50], 0.95), 50);
  assert.equal(percentile([], 0.95), 0);
});
