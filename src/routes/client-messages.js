module.exports = (app, ctx) => {
  const {
    BookingMessage,
    normalizePagination,
    normalizeUserId,
    setPaginationHeaders,
    userIdAliases,
  } = ctx;

  const ownerQuery = req => ({
    userId: { $in: userIdAliases(normalizeUserId(req.clientUser.id)) },
  });

  app.get('/api/booking-messages/unread-count', async (req, res) => {
    const count = await BookingMessage.countDocuments({ ...ownerQuery(req), readAt: null });
    res.json({ count });
  });

  app.get('/api/booking-messages', async (req, res) => {
    const pagination = normalizePagination(req.query);
    const query = ownerQuery(req);
    const [messages, total] = await Promise.all([
      BookingMessage.find(query)
        .select('-_id -__v')
        .sort({ createdAt: -1 })
        .skip(pagination.skip)
        .limit(pagination.limit)
        .lean(),
      BookingMessage.countDocuments(query),
    ]);
    setPaginationHeaders(res, pagination, total);
    res.json(messages);
  });

  app.patch('/api/booking-messages/read', async (req, res) => {
    const through = new Date(req.body.through);
    if (Number.isNaN(through.getTime())) {
      return res.status(400).json({ message: 'through must be a valid date time' });
    }
    const result = await BookingMessage.updateMany(
      { ...ownerQuery(req), readAt: null, createdAt: { $lte: through } },
      { $set: { readAt: new Date() } },
    );
    res.json({ updatedCount: result.modifiedCount });
  });
};
