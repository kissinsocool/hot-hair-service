const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { server, gracefulShutdown } = require('../index');

const app = server.listeners('request')[0];
app.get('/__test/slow', (_req, res) => setTimeout(() => res.json({ finished: true }), 300));

const get = (port, path) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path, agent: false }, (res) => {
    let body = '';
    res.on('data', chunk => { body += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, body, connection: res.headers.connection }));
  }).on('error', reject);
});

test('shutdown lets in-flight requests finish, refuses new connections and exits cleanly', async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const inFlight = get(port, '/__test/slow');
  await new Promise(resolve => setTimeout(resolve, 50));

  const exitCodes = [];
  const shutdown = gracefulShutdown('SIGTERM', { timeoutMs: 5000, exit: code => exitCodes.push(code) });
  assert.equal(gracefulShutdown('SIGTERM'), shutdown, 'a repeated signal reuses the running shutdown');

  const response = await inFlight;
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { finished: true });
  assert.equal(response.connection, 'close');

  await assert.rejects(get(port, '/health'), /ECONNREFUSED/);
  await shutdown;
  assert.deepEqual(exitCodes, [0]);
});
