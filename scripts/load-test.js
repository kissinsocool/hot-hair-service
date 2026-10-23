const target = process.env.LOAD_TEST_URL || 'http://127.0.0.1:3000/health';
const concurrency = Math.min(Math.max(Number(process.env.LOAD_TEST_CONCURRENCY) || 20, 1), 200);
const durationSeconds = Math.min(Math.max(Number(process.env.LOAD_TEST_DURATION_SECONDS) || 10, 1), 60);
const timeoutMs = Math.min(Math.max(Number(process.env.LOAD_TEST_TIMEOUT_MS) || 5000, 100), 60000);
const authorization = process.env.LOAD_TEST_TOKEN ? `Bearer ${process.env.LOAD_TEST_TOKEN}` : '';

const percentile = (sorted, value) => sorted.length
  ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)]
  : 0;

const run = async () => {
  const stopAt = Date.now() + durationSeconds * 1000;
  const startedAt = Date.now();
  const latencies = [];
  const statuses = {};
  let failed = 0;

  const worker = async () => {
    while (Date.now() < stopAt) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const requestStartedAt = performance.now();
      try {
        const response = await fetch(target, {
          signal: controller.signal,
          headers: authorization ? { authorization } : {},
        });
        await response.arrayBuffer();
        statuses[response.status] = (statuses[response.status] || 0) + 1;
        if (!response.ok) failed += 1;
      } catch {
        failed += 1;
      } finally {
        clearTimeout(timeout);
        latencies.push(performance.now() - requestStartedAt);
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  latencies.sort((left, right) => left - right);
  const elapsedSeconds = (Date.now() - startedAt) / 1000;
  console.log(JSON.stringify({
    target,
    concurrency,
    elapsedSeconds: Number(elapsedSeconds.toFixed(2)),
    requests: latencies.length,
    requestsPerSecond: Number((latencies.length / elapsedSeconds).toFixed(2)),
    failed,
    statuses,
    latencyMs: {
      p50: Number(percentile(latencies, 0.5).toFixed(2)),
      p95: Number(percentile(latencies, 0.95).toFixed(2)),
      p99: Number(percentile(latencies, 0.99).toFixed(2)),
      max: Number((latencies.at(-1) || 0).toFixed(2)),
    },
  }, null, 2));
  if (!latencies.length) process.exitCode = 1;
};

if (require.main === module && !process.env.NODE_TEST_CONTEXT) run();

module.exports = { percentile };
