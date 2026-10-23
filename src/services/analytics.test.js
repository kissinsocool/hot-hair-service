const assert = require('node:assert/strict');
const test = require('node:test');
const {
  bookingEvent,
  clientEvent,
  funnelMetrics,
  validateClientEvent,
} = require('./analytics');

test('analytics validates client events and attributes server booking stages', () => {
  const event = clientEvent({
    eventId: 'event-1',
    name: 'salon_detail_click',
    anonymousId: 'visitor-1',
    salonId: 'salon-1',
  }, 'user-1');
  assert.equal(validateClientEvent(event), '');
  assert.equal(event.userId, 'user-1');
  assert.equal(validateClientEvent({ ...event, name: 'merchant_accepted' }), 'Invalid analytics event');

  assert.deepEqual(bookingEvent('booking_submitted', {
    id: 'booking-1',
    userId: 'user-1',
    salonId: 'salon-1',
    serviceId: 'service-1',
  }), {
    eventId: 'booking:booking-1:booking_submitted',
    name: 'booking_submitted',
    userId: 'user-1',
    salonId: 'salon-1',
    serviceId: 'service-1',
    bookingId: 'booking-1',
    source: 'server',
  });
});

test('analytics computes the two dashboard conversion rates', () => {
  const funnel = funnelMetrics([
    { _id: 'home_exposure', count: 200 },
    { _id: 'salon_detail_click', count: 50 },
    { _id: 'booking_started', count: 20 },
    { _id: 'booking_submitted', count: 9 },
  ]);
  assert.equal(funnel.salonDetailClickRate, 25);
  assert.equal(funnel.bookingSubmissionRate, 45);
  assert.equal(funnel.counts.visit_completed, 0);
});
