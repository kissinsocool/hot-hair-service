module.exports = (app, { Booking, Salon, rateLimits, recordReviewHelpful }) => {
  app.post('/api/bookings/:id/review/helpful', ...rateLimits.reviewHelpful, async (req, res) => {
    const reviewId = req.body?.reviewId;
    if (typeof reviewId !== 'string' || !reviewId.trim() || reviewId.length > 100) {
      return res.status(400).json({ message: '评价信息无效' });
    }
    const booking = await Booking.findOne({
      id: req.params.id, 'review.id': reviewId, 'review.reviewStatus': 'approved',
      'review.rating': { $gte: 1, $lte: 5 },
    }).select('id staffId review.id').lean();
    if (!booking || !await Salon.exists({ staffIds: booking.staffId, publishStatus: 'online' })) {
      return res.status(404).json({ message: '评价不存在或已不可见' });
    }
    res.json(await recordReviewHelpful(booking.id, booking.review.id, req.clientUser.id));
  });
};
