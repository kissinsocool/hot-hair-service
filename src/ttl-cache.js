// Process-local, short-lived cache for public responses that are identical for every caller.
// Concurrent callers of one key share a single load; a failed load is not cached.
const createTtlCache = ({ ttlMs, max = 100, now = Date.now }) => {
  const entries = new Map();
  return {
    async get(key, load) {
      const currentTime = now();
      const cached = entries.get(key);
      if (cached && cached.expiresAt > currentTime) return cached.value;

      const value = Promise.resolve().then(load);
      entries.delete(key);
      entries.set(key, { expiresAt: currentTime + ttlMs, value });
      while (entries.size > max) entries.delete(entries.keys().next().value);
      try {
        return await value;
      } catch (error) {
        if (entries.get(key)?.value === value) entries.delete(key);
        throw error;
      }
    },
    clear() { entries.clear(); },
  };
};

// The public responses that are identical for every caller. Admin and merchant writes clear the affected cache
// (see the clear* helpers in index.js), so a change shows at once and the lifetimes only bound how long a
// response is reused while nothing changes. The coupon campaign also starts and ends by the clock, with no write
// to clear it, so it keeps a short lifetime.
const createPublicResponseCaches = (now = Date.now) => ({
  ad: createTtlCache({ ttlMs: 5 * 60_000, max: 1, now }),
  couponCampaign: createTtlCache({ ttlMs: 15_000, max: 1, now }),
  promotedServices: createTtlCache({ ttlMs: 5 * 60_000, max: 200, now }),
});

module.exports = { createTtlCache, createPublicResponseCaches };
