const test = require('node:test');
const assert = require('node:assert/strict');
const { Booking, ClientUser, Salon } = require('../models');
const {
  SALON_RATING_STATS_SELECTION,
  refreshSalonRatingSummaries,
  salonRatingSummary,
  salonReviewStats,
} = require('./salon-ratings');
const { getSalonReviewsPage } = require('./salon-reviews');
const { stripSensitiveSalonFields } = require('./salon');

const stub = (t, Model, method, replacement) => {
  const original = Model[method];
  Model[method] = replacement;
  t.after(() => { Model[method] = original; });
};

test('salon ratings are grouped by the booking salon, not by the current stylists', async (t) => {
  let pipeline;
  const updates = [];
  stub(t, Booking, 'aggregate', async (value) => {
    pipeline = value;
    return [{
      ratings: [{
        _id: 'salon-1', reviewCount: 3, ratingTotal: 12, techniqueCount: 3, techniqueTotal: 11,
        negativeCount: 1, neutralCount: 0, photoCount: 2,
      }],
      tags: [
        { _id: { salonId: 'salon-1', name: '服务周到' }, count: 2 },
        { _id: { salonId: 'salon-1', name: '善于沟通' }, count: 1 },
      ],
    }];
  });
  stub(t, Salon, 'updateOne', async (...args) => { updates.push(args); });

  await refreshSalonRatingSummaries(['salon-1', 'salon-1', '', 'salon-empty']);

  assert.deepEqual(pipeline[0].$match, {
    salonId: { $in: ['salon-1', 'salon-empty'] },
    'review.reviewStatus': 'approved',
  });
  assert.equal(pipeline[1].$facet.ratings[1].$group._id, '$salonId');
  assert.equal(updates.length, 2);

  const [filter, update, options] = updates[0];
  const { computedAt, ...stored } = update.$set.ratingStats;
  assert.ok(computedAt instanceof Date);
  assert.deepEqual(filter, { id: 'salon-1', $or: [
    { 'ratingStats.computedAt': { $lt: computedAt } },
    { 'ratingStats.computedAt': { $exists: false } },
  ] });
  // Technique scores belong to stylists; tag counts keep the configured display order.
  assert.deepEqual(stored, {
    reviewCount: 3, ratingTotal: 12, negativeCount: 1, neutralCount: 0, photoCount: 2,
    tagCounts: [{ name: '善于沟通', count: 1 }, { name: '服务周到', count: 2 }],
  });
  // A rating refresh is not a content change and must not move updatedAt.
  assert.deepEqual(options, { timestamps: false });

  // A salon whose last approved review is gone is reset to zero rather than left stale.
  const { computedAt: _resetAt, ...reset } = updates[1][1].$set.ratingStats;
  assert.equal(updates[1][0].id, 'salon-empty');
  assert.deepEqual(reset, {
    reviewCount: 0, ratingTotal: 0, negativeCount: 0, neutralCount: 0, photoCount: 0, tagCounts: [],
  });
});

test('refreshing no salons runs no query', async (t) => {
  stub(t, Booking, 'aggregate', async () => { throw new Error('unexpected query'); });
  await refreshSalonRatingSummaries([]);
  await refreshSalonRatingSummaries(['', null, undefined]);
});

test('salon rating readers use the stored totals and report an explicit unrated state', () => {
  const salon = { id: 'salon-1', ratingStats: {
    reviewCount: 4, ratingTotal: 17, negativeCount: 1, neutralCount: 1, photoCount: 2,
    tagCounts: [{ name: '服务周到', count: 3 }, { name: '善于沟通', count: 1 }],
  } };
  assert.deepEqual(salonRatingSummary(salon), { rating: 4.25, reviewCount: 4 });
  assert.deepEqual(salonReviewStats(salon), {
    counts: { all: 4, negative: 1, neutral: 1, photos: 2 },
    reviewTags: [{ name: '善于沟通', count: 1 }, { name: '服务周到', count: 3 }],
    rating: 4.25,
    reviewCount: 4,
  });
  for (const unrated of [{ id: 'new-salon' }, { ratingStats: { reviewCount: 0, ratingTotal: 0 } }, undefined]) {
    assert.deepEqual(salonRatingSummary(unrated), { rating: null, reviewCount: 0 });
  }
  assert.deepEqual(salonReviewStats({}).counts, { all: 0, negative: 0, neutral: 0, photos: 0 });
});

test('stored salon totals are hidden unless a query asks for them, and never reach payloads', () => {
  const selected = (projection) => {
    const query = Salon.find({}).select(projection);
    query._applyPaths();
    return query._fields;
  };
  assert.equal(selected('id name').ratingStats, undefined);
  assert.equal(selected(`id name ${SALON_RATING_STATS_SELECTION}`).ratingStats, 1);
  // In an exclusion projection the field is returned as long as it is not excluded.
  assert.equal(Object.hasOwn(selected(`-services ${SALON_RATING_STATS_SELECTION}`), 'ratingStats'), false);
  assert.equal(Object.hasOwn(stripSensitiveSalonFields({ id: 's', ratingStats: {} }), 'ratingStats'), false);
});

test('a salon review page reads every review of the salon and counts from its stored totals', async (t) => {
  let filter;
  const chain = rows => {
    const query = {
      sort: () => query, skip: () => query, limit: () => query, select: () => query, maxTimeMS: () => query,
      lean: async () => rows,
    };
    return query;
  };
  stub(t, Booking, 'find', (value) => {
    filter = value;
    return chain([{
      id: 'booking-1', userId: 'customer-1', staffId: 'departed-stylist', staffName: '已离职',
      review: { id: 'review-1', rating: 2, reviewStatus: 'approved' },
    }]);
  });
  stub(t, ClientUser, 'find', () => chain([]));

  const page = await getSalonReviewsPage(
    // staffIds no longer decide which reviews belong to the salon.
    { id: 'salon-1', staffIds: ['current-stylist'], ratingStats: { reviewCount: 5, negativeCount: 3 } },
    { page: 1, limit: 1, skip: 0 },
    'negative',
  );

  assert.deepEqual(filter, {
    salonId: 'salon-1',
    'review.reviewStatus': 'approved',
    'review.rating': { $gte: 1, $lt: 3 },
  });
  assert.equal(page.items[0].staffId, 'departed-stylist');
  assert.equal(page.total, 3);
  assert.equal(page.hasMore, true);
  assert.deepEqual(page.counts, { all: 5, negative: 3, neutral: 0, photos: 0 });
});
