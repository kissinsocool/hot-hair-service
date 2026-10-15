const analytics = require('../services/analytics');

module.exports = (app, ctx) => {
  const {
    AnalyticsEvent,
    ClientUser,
    activeSessionQuery,
    rateLimits,
    sessionTokenFromRequest,
  } = ctx;

  app.post('/api/analytics/events', ...(rateLimits.analytics || []), async (req, res) => {
    const token = sessionTokenFromRequest(req);
    const user = token
      ? await ClientUser.findOne(activeSessionQuery(token)).select('id').lean()
      : null;
    const event = analytics.clientEvent(req.body, user?.id);
    const error = analytics.validateClientEvent(event);
    if (error) return res.status(400).json({ message: error });
    await analytics.recordAnalyticsEvent(AnalyticsEvent, event);
    res.status(202).json({ accepted: true });
  });
};
