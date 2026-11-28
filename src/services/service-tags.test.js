const assert = require('node:assert/strict');
const { test } = require('node:test');
const { serviceTagLabels, serviceTagIdsFromLegacy, incomingServiceTagIds, resolveServiceTagIds } = require('./salon');

test('styling displays the new label and preserves tags from released clients and legacy data', () => {
  assert.deepEqual(serviceTagLabels(['styling']), ['造型设计']);
  for (const label of ['发型设计', '造型设计']) {
    assert.deepEqual(serviceTagIdsFromLegacy([label]), ['styling']);
    assert.deepEqual(resolveServiceTagIds({ tags: [label] }), ['styling']);
    assert.deepEqual(incomingServiceTagIds({ tags: [label] }), ['styling']);
    assert.deepEqual(incomingServiceTagIds(
      { tagIds: ['styling'], tags: [label] },
      { tagIds: ['styling'] },
    ), ['styling']);
  }
});
