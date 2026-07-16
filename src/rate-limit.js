const crypto = require('crypto');

const MINUTE = 60 * 1000;
const buckets = new Map();

const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const ipKey = req => req.ip || req.socket?.remoteAddress || '';
const bodyKey = field => req => {
  const value = String(req.body?.[field] || '').trim().toLowerCase();
  const endpoint = String(req.originalUrl || req.path || '').split('?')[0];
  return value ? hash(`${endpoint}:${value}`) : '';
};
const phoneKey = req => {
  const phone = String(req.body?.phone || '').replace(/\D/g, '');
  return phone ? hash(phone) : '';
};
const actorKey = req => {
  const actor = req.clientUser?.id || req.merchantUser?.id || req.adminUser?.id;
  const bearer = String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const claimedUser = req.body?.userId || req.query?.userId;
  const value = actor || bearer || claimedUser || (ipKey(req) ? `ip:${ipKey(req)}` : '');
  return value ? hash(value) : '';
};

function createRateLimiter({ name, limit, windowMs, key = ipKey, now = Date.now }) {
  let lastSweep = 0;
  return (req, res, next) => {
    const currentTime = now();
    if (currentTime - lastSweep >= windowMs) {
      for (const [bucketKey, bucket] of buckets) {
        if (currentTime - bucket.updatedAt >= windowMs) buckets.delete(bucketKey);
      }
      lastSweep = currentTime;
    }

    const identity = key(req);
    if (!identity) return next();
    const bucketKey = `${name}:${identity}`;
    const previous = buckets.get(bucketKey);
    const restored = previous
      ? Math.min(limit, previous.tokens + (currentTime - previous.updatedAt) * limit / windowMs)
      : limit;

    if (restored < 1) {
      const retryAfter = Math.max(1, Math.ceil((1 - restored) * windowMs / limit / 1000));
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ message: '请求过于频繁，请稍后再试', retryAfterSeconds: retryAfter });
    }

    buckets.set(bucketKey, { tokens: restored - 1, updatedAt: currentTime });
    next();
  };
}

// ponytail: process-local buckets; replace the storage with Redis before running multiple API instances.
const rateLimits = {
  login: [
    createRateLimiter({ name: 'login-ip', limit: 30, windowMs: 5 * MINUTE }),
    createRateLimiter({ name: 'login-account', limit: 10, windowMs: 15 * MINUTE, key: req =>
      bodyKey(req.body?.account === undefined ? 'username' : 'account')(req) }),
  ],
  smsRequest: [
    createRateLimiter({ name: 'sms-request-ip', limit: 20, windowMs: 60 * MINUTE }),
    createRateLimiter({ name: 'sms-request-phone-minute', limit: 1, windowMs: MINUTE, key: phoneKey }),
    createRateLimiter({ name: 'sms-request-phone-hour', limit: 5, windowMs: 60 * MINUTE, key: phoneKey }),
  ],
  smsVerify: [
    createRateLimiter({ name: 'sms-verify-ip', limit: 30, windowMs: 10 * MINUTE }),
    createRateLimiter({ name: 'sms-verify-phone', limit: 5, windowMs: 5 * MINUTE, key: phoneKey }),
  ],
  booking: [
    createRateLimiter({ name: 'booking-ip', limit: 60, windowMs: MINUTE }),
    createRateLimiter({ name: 'booking-actor', limit: 10, windowMs: MINUTE, key: actorKey }),
  ],
  merchantBooking: [
    createRateLimiter({ name: 'merchant-booking-ip', limit: 120, windowMs: MINUTE }),
    createRateLimiter({ name: 'merchant-booking-actor', limit: 60, windowMs: MINUTE, key: actorKey }),
  ],
  upload: [
    createRateLimiter({ name: 'upload-ip', limit: 20, windowMs: MINUTE }),
    createRateLimiter({ name: 'upload-actor', limit: 10, windowMs: MINUTE, key: actorKey }),
  ],
};

module.exports = { createRateLimiter, rateLimits };
