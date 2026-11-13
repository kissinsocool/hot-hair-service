const test = require('node:test');
const assert = require('node:assert/strict');
const { serviceAreaStatus } = require('./service-area');

test('service area distinguishes Beijing, other cities and unresolved addresses', async () => {
  assert.equal(await serviceAreaStatus('::ffff:202.106.0.20', (ip, family) => {
    assert.equal(ip, '202.106.0.20');
    assert.equal(family, 4);
    return '中国|北京市|北京市|联通|CN';
  }), 'open');
  assert.equal(await serviceAreaStatus('240e:3b7::1', (_ip, family) => {
    assert.equal(family, 6);
    return '中国|广东省|深圳市|电信|CN';
  }), 'closed');
  assert.equal(await serviceAreaStatus('8.8.8.8', () => 'United States|California|0|0|US'), 'closed');
  assert.equal(await serviceAreaStatus('127.0.0.1', () => 'Reserved|Reserved|Reserved|0|0'), 'unknown');
  assert.equal(await serviceAreaStatus('1.2.3.4', () => '中国|0|0|0|CN'), 'unknown');
  assert.equal(await serviceAreaStatus('1.2.3.4', () => ''), 'unknown');
  assert.equal(await serviceAreaStatus('', () => assert.fail('invalid address must not be looked up')), 'unknown');
});
