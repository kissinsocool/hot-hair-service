const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { performance } = require('node:perf_hooks');
const { server, gracefulShutdown } = require('../index');

const app = server.listeners('request')[0];

test('shutdown cuts off requests that outlive the timeout and exits with code 1', { timeout: 5000 }, async (t) => {
  const requestStarted = new Promise(resolve => app.get('/__test/hang', () => resolve()));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address();
  let request;
  const hung = new Promise((resolve) => {
    request = http.get({ host: '127.0.0.1', port, path: '/__test/hang', agent: false }, resolve)
      .on('error', error => resolve(error));
  });
  t.after(() => request.destroy());
  await requestStarted;

  const exitCodes = [];
  const timeoutMs = 200;
  const startedAt = performance.now();
  const shutdown = gracefulShutdown('SIGTERM', { timeoutMs, exit: code => exitCodes.push(code) });
  assert.deepEqual(exitCodes, [], 'shutdown waits for the in-flight request');
  assert.equal(request.destroyed, false);
  await shutdown;
  const elapsedMs = performance.now() - startedAt;
  assert.deepEqual(exitCodes, [1]);
  assert.ok(elapsedMs >= timeoutMs - 10, `shutdown exited too early after ${elapsedMs}ms`);
  assert.ok(elapsedMs < 2000, `shutdown exceeded its deadline: ${elapsedMs}ms`);
  assert.equal((await hung).code, 'ECONNRESET', 'the hung request connection was closed');
});
