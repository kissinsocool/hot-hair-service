const crypto = require('crypto');

const requestLogger = (req, res, next) => {
  const startedAt = process.hrtime.bigint();
  const incomingId = String(req.headers['x-request-id'] || '');
  req.requestId = /^[A-Za-z0-9._-]{1,100}$/.test(incomingId) ? incomingId : crypto.randomUUID();
  res.set('X-Request-ID', req.requestId);
  res.once('finish', () => {
    const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
    const route = String(req.route?.path || 'unmatched');
    console.log(JSON.stringify({
      level: 'info',
      event: 'http_request',
      requestId: req.requestId,
      method: req.method,
      route,
      status: res.statusCode,
      durationMs: Number((durationSeconds * 1000).toFixed(2)),
      ip: req.ip,
    }));
  });
  next();
};

const errorLogger = (error, req) => {
  console.error(JSON.stringify({
    level: 'error',
    event: 'request_error',
    requestId: req.requestId,
    method: req.method,
    path: req.path,
    message: error.message,
    name: error.name,
  }));
};

module.exports = { errorLogger, requestLogger };
