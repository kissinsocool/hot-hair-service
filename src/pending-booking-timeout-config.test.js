const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

for (const [value, expected] of [[undefined, 24], ['0', 0], ['-1', 24], ['invalid', 24]]) {
  test(`pending booking timeout for ${value === undefined ? 'unset' : JSON.stringify(value)} is ${expected} hours`, () => {
    const env = { ...process.env };
    delete env.PENDING_BOOKING_TIMEOUT_HOURS;
    if (value !== undefined) env.PENDING_BOOKING_TIMEOUT_HOURS = value;

    const actual = execFileSync(process.execPath, [
      '-p', `require(${JSON.stringify(require.resolve('./config'))}).pendingBookingTimeoutHours`,
    ], { env, encoding: 'utf8' });
    assert.equal(actual.trim(), String(expected));
  });
}
