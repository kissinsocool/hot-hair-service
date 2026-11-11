// Process-local, short-lived cache for public responses that are identical for every caller.
// Concurrent callers of one key share a single load; a failed load is not cached.
// ponytail: process-local like the salon detail cache; use Redis only when several backend instances need to share it.
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

module.exports = { createTtlCache };
