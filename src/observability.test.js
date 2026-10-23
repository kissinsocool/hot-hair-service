const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { requestLogger } = require('./observability');

test('request logging emits structured metadata without request data', () => {
  const req = {
    headers: { 'x-request-id': 'request-1' },
    ip: '127.0.0.1',
    method: 'GET',
    route: { path: '/health' },
  };
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    set(name, value) { this[name] = value; },
  });

  const originalLog = console.log;
  let log;
  console.log = value => { log = JSON.parse(value); };
  try {
    requestLogger(req, res, () => {});
    res.emit('finish');
  } finally {
    console.log = originalLog;
  }

  assert.equal(res['X-Request-ID'], 'request-1');
  assert.equal(log.event, 'http_request');
  assert.equal(log.route, '/health');
  assert.equal(log.status, 200);
});
