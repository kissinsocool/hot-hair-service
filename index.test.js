const assert = require('node:assert/strict');
const test = require('node:test');
const {
  acceptedBookingAtTimeQuery,
  buildGeoLocation,
  buildSearchRadii,
  ensureSalonForMerchant,
  filterNearbySalons,
  getCoordinates,
  hashPassword,
  INPUT_LIMITS,
  normalizeServiceTags,
  normalizeAdLink,
  normalizePagination,
  stripSensitiveSalonFields,
  verifyPassword,
} = require('./index');
const { isAllowedOrigin } = require('./src/config');
const { Booking } = require('./src/models');

test('getCoordinates accepts common location shapes', () => {
  assert.deepEqual(getCoordinates('121.4737,31.2304'), { latitude: 31.2304, longitude: 121.4737 });
  assert.deepEqual(getCoordinates({ lat: '31.2304', lng: '121.4737' }), { latitude: 31.2304, longitude: 121.4737 });
  assert.deepEqual(getCoordinates({ coordinates: [121.4737, 31.2304] }), { latitude: 31.2304, longitude: 121.4737 });
});

test('buildGeoLocation stores MongoDB GeoJSON coordinates', () => {
  assert.deepEqual(buildGeoLocation({ latitude: 31.2304, longitude: 121.4737 }), {
    type: 'Point',
    coordinates: [121.4737, 31.2304],
  });
});

test('normalizeServiceTags trims, deduplicates and limits service tags', () => {
  assert.deepEqual(normalizeServiceTags([' 洗剪吹 ', '染发', '洗剪吹', '', '烫发', '护理', '发型设计', '头皮护理', '造型']), [
    '洗剪吹',
    '染发',
    '烫发',
    '护理',
    '发型设计',
    '头皮护理',
  ]);
  assert.deepEqual(normalizeServiceTags('洗剪吹，染发、头皮护理'), ['洗剪吹', '染发', '头皮护理']);
});

test('normalizeAdLink only accepts mini program page paths', () => {
  assert.equal(normalizeAdLink('/pages/ad/ad'), '/pages/ad/ad');
  assert.equal(normalizeAdLink('/pages/detail/detail?id=1'), '/pages/detail/detail?id=1');
  assert.equal(normalizeAdLink('https://example.com'), '');
  assert.equal(normalizeAdLink('/pages/../admin'), '');
});

test('normalizePagination applies defaults and caps page size', () => {
  assert.deepEqual(normalizePagination({}), { page: 1, limit: 50, skip: 0 });
  assert.deepEqual(normalizePagination({ page: '3', limit: '500' }), { page: 3, limit: 100, skip: 200 });
  assert.deepEqual(normalizePagination({ page: 'Infinity' }), { page: 1, limit: 50, skip: 0 });
});

test('async password hashing remains verifiable', async () => {
  const password = await hashPassword('correct horse battery staple');
  assert.equal(await verifyPassword('correct horse battery staple', {
    passwordSalt: password.salt,
    passwordHash: password.hash,
  }), true);
  assert.equal(await verifyPassword('wrong', {
    passwordSalt: password.salt,
    passwordHash: password.hash,
  }), false);
});

test('input limits cap query amplification and user content', () => {
  assert.equal('candidateStaff' in INPUT_LIMITS, false);
  assert.equal(INPUT_LIMITS.note, 500);
  assert.equal(INPUT_LIMITS.services, 50);
});

test('no-preference booking can remain unassigned until merchant acceptance', async () => {
  const booking = new Booking({
    id: 'BK-unassigned',
    serviceId: 'service-1',
    startTime: new Date('2030-01-01T10:00:00.000Z'),
    isNoPreference: true,
    staffName: '无需指定',
  });

  await booking.validate();
  assert.equal(booking.staffId, '');
});

test('buildSearchRadii expands until the max radius', () => {
  assert.deepEqual(buildSearchRadii(10, 80), [10, 20, 40, 80]);
  assert.deepEqual(buildSearchRadii(10, 5), [10]);
});

test('filterNearbySalons returns only nearby salons sorted by distance', () => {
  const salons = [
    { id: 'far', location: { latitude: 31.9, longitude: 121.9 } },
    { id: 'near-2', location: { latitude: 31.231, longitude: 121.475 } },
    { id: 'near-1', location: { latitude: 31.2305, longitude: 121.4738 } },
    { id: 'missing-location' },
  ];

  assert.deepEqual(
    filterNearbySalons(salons, { latitude: 31.2304, longitude: 121.4737 }, 1).map(salon => salon.id),
    ['near-1', 'near-2'],
  );
});

test('acceptedBookingAtTimeQuery only blocks already accepted bookings', () => {
  const query = acceptedBookingAtTimeQuery('S1', '2026-06-21T03:30:00.000Z', 'BK1');

  assert.equal(query.staffId, 'S1');
  assert.equal(query.startTime.getTime(), Date.parse('2026-06-21T03:30:00.000Z'));
  assert.deepEqual(query.id, { $ne: 'BK1' });
  assert.equal(query.status, 'accepted');
});

test('isAllowedOrigin allows local Flutter web ports', () => {
  assert.equal(isAllowedOrigin('http://localhost:61234'), true);
  assert.equal(isAllowedOrigin('http://127.0.0.1:61234'), true);
  assert.equal(isAllowedOrigin('http://example.com'), false);
});

test('stripSensitiveSalonFields removes license fields from public salon payloads', () => {
  const payload = stripSensitiveSalonFields({
    id: '1',
    name: 'Hot Hair',
    licenseUrl: 'licenses/license.png',
    licenseStatus: 'pending',
    licenseRejectReason: 'bad image',
    licenseSubmittedAt: new Date(),
    licenseReviewedAt: new Date(),
    pendingContent: { name: 'unreviewed' },
    contentRejectReason: 'internal reason',
  });

  assert.deepEqual(payload, { id: '1', name: 'Hot Hair' });
});

test('admin merchant creation helper is wired into route context', () => {
  assert.equal(typeof ensureSalonForMerchant, 'function');
});
