const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const registerPublicRoutes = require('./public');
const { buildStaffPayload, servicePayload } = require('../services/salon');

for (const salon of [
  { id: 'salon-1', name: '靓丝造型', staffIds: ['staff-1'], services: [] },
  null,
]) {
  test(`staff detail GET adds a public salon name without additional queries (${salon ? 'associated' : 'unassociated'})`, async t => {
    const person = { id: 'staff-1', name: 'Tony', imageUrl: '/tony.jpg', roleId: 'designer' };
    let staffReads = 0;
    let salonReads = 0;
    const app = express();
    registerPublicRoutes(app, {
      rateLimits: { publicRead: [] },
      getStaffById(id) {
        assert.equal(id, person.id);
        staffReads++;
        return { lean: async () => person };
      },
      getSalonByStaffId(id) {
        assert.equal(id, person.id);
        salonReads++;
        return { lean: async () => salon };
      },
      getStaffMapByIds: async () => ({ 'staff-1': person }),
      getApprovedReviewsByStaffIds: async () => [],
      getApprovedRatingSummariesByStaffIds: async () => ({}),
      buildStaffPayload,
      servicePayload,
      expandedSalonClosedDates: () => [],
    });
    const server = app.listen(0, '127.0.0.1');
    t.after(() => new Promise(resolve => server.close(resolve)));
    await new Promise(resolve => server.once('listening', resolve));
    // Existing clients issue this GET without any extra query or request fields.
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/staff/staff-1`);
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.salonName, salon ? salon.name : '');
    assert.equal(payload.salonId, salon ? salon.id : '');
    // All existing staff fields retain their shape and values for old consumers.
    for (const [key, value] of Object.entries(JSON.parse(JSON.stringify(buildStaffPayload(person))))) {
      assert.deepEqual(payload[key], value, key);
    }
    assert.deepEqual(payload.salonServices, []);
    assert.equal(payload.salonStaff.length, salon ? 1 : 0);
    assert.deepEqual(payload.salonClosedDates, []);
    assert.equal(payload.salonAcceptsSameDayBooking, true);
    assert.equal(staffReads, 1);
    assert.equal(salonReads, 1);
  });
}


test('restricted package slots reject specified staff and use the salon pool for no preference', async t => {
  const salon = { id: 'salon-1', services: [{ id: 'service-1', durationMinutes: 90, staffSelectionRestricted: true }] };
  const app = express();
  let poolReads = 0;
  registerPublicRoutes(app, {
    rateLimits: { publicRead: [] },
    Salon: { findOne: () => ({ lean: async () => salon }) },
    getSalonByStaffId: () => ({ lean: async () => salon }),
    async generateSlotsForNoPreferenceAndDate(actualSalon, date, duration) {
      assert.equal(actualSalon, salon);
      assert.equal(duration, 90);
      poolReads++;
      return [{ time: '10:00', isAvailable: true }];
    },
  });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/staff`;
  const rejected = await fetch(`${base}/staff-1/slots?date=2030-01-01&serviceId=service-1`);
  assert.equal(rejected.status, 409);
  const allowed = await fetch(`${base}/__no_preference__/slots?date=2030-01-01&salonId=salon-1&serviceId=service-1`);
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json())[0].time, '10:00');
  assert.equal(poolReads, 1);
});
