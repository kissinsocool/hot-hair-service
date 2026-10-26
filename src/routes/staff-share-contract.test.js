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
