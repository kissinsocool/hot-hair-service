const test = require('node:test');
const assert = require('node:assert/strict');
const { server } = require('../index');

const post = (port, path, body, method = 'POST') => fetch(`http://127.0.0.1:${port}${path}`, {
  method,
  headers: { 'content-type': 'application/json' },
  body,
});

test('JSON body limits', async (t) => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  t.after(() => new Promise(resolve => server.close(resolve)));

  await t.test('public endpoint rejects bodies over the default limit with 413', async () => {
    const response = await post(port, '/api/analytics/events', JSON.stringify({ x: 'a'.repeat(1.2 * 1024 * 1024) }));
    assert.equal(response.status, 413);
    assert.equal((await response.json()).message, '请求内容过大');
  });

  await t.test('malformed JSON returns 400, not 500', async () => {
    const response = await post(port, '/api/analytics/events', '{bad json');
    assert.equal(response.status, 400);
  });

  await t.test('former base64 admin routes no longer accept large bodies', async () => {
    const response = await post(port, '/api/admin/ad', JSON.stringify({ data: 'a'.repeat(1.2 * 1024 * 1024) }), 'PATCH');
    assert.equal(response.status, 413);
  });
});
