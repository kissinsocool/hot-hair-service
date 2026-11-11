const test = require('node:test');
const assert = require('node:assert/strict');
const { createTtlCache } = require('./ttl-cache');

test('ttl cache reuses a value until it expires', async () => {
  let time = 1000;
  let loads = 0;
  const cache = createTtlCache({ ttlMs: 15000, now: () => time });
  const load = async () => { loads += 1; return { loads }; };

  assert.deepEqual(await cache.get('ad', load), { loads: 1 });
  time += 14999;
  assert.deepEqual(await cache.get('ad', load), { loads: 1 });
  time += 1;
  assert.deepEqual(await cache.get('ad', load), { loads: 2 });
});

test('ttl cache shares one load between concurrent callers and keeps keys apart', async () => {
  let loads = 0;
  const cache = createTtlCache({ ttlMs: 15000 });
  const load = async () => { loads += 1; return loads; };

  assert.deepEqual(await Promise.all([cache.get('a', load), cache.get('a', load), cache.get('b', load)]), [1, 1, 2]);
});

test('ttl cache does not keep a failed load', async () => {
  const cache = createTtlCache({ ttlMs: 15000 });
  await assert.rejects(cache.get('ad', async () => { throw new Error('database down'); }), /database down/);
  assert.equal(await cache.get('ad', async () => 'recovered'), 'recovered');
});

test('ttl cache evicts the oldest key beyond its size limit', async () => {
  let loads = 0;
  const cache = createTtlCache({ ttlMs: 15000, max: 2 });
  const load = async () => { loads += 1; return loads; };

  await cache.get('a', load);
  await cache.get('b', load);
  await cache.get('c', load);
  assert.equal(await cache.get('c', load), 3);
  assert.equal(await cache.get('a', load), 4);
});
