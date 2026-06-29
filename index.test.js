const assert = require('node:assert/strict');
const test = require('node:test');
const { buildGeoLocation, buildSearchRadii, filterNearbySalons, getCoordinates } = require('./index');

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
