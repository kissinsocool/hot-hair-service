const assert = require('node:assert/strict');
const test = require('node:test');
const { Booking } = require('../models');
const { normalizeBookingPayload } = require('./booking');

test('private merchant appeal is omitted from client and websocket payloads but retained for merchant reads', () => {
  const doc = new Booking({
    id: 'appeal-private', serviceId: 'service-1', status: 'completed', startTime: new Date(),
    merchantAppeal: {
      reason: 'other', description: '商家私有申诉说明', merchantId: 'merchant-1',
      status: 'pending', submittedAt: new Date(),
    },
  });
  for (const source of [doc, doc.toObject()]) {
    const client = normalizeBookingPayload(source);
    assert.equal(Object.hasOwn(client, 'merchantAppeal'), false);
    const merchant = normalizeBookingPayload(source, true);
    assert.equal(merchant.merchantAppeal.description, '商家私有申诉说明');
    assert.equal(merchant.status, 'completed');
  }
  assert.equal(doc.merchantAppeal.description, '商家私有申诉说明');
});
