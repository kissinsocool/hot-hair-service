module.exports = (app, ctx) => {
  const {
    getNearbySalons,
    normalizeLimit,
    buildSalonDetail,
    resolveRequestUser,
    readFavoriteSalons,
    FavoriteSalon,
    DEMO_USER_ID,
    getCoordinates,
    toFiniteNumber,
    salonCoverImage,
    existingSalonImages,
    Salon,
    calculateDistanceKm,
    userIdAliases,
    stripSensitiveSalonFields,
    AdConfig,
    buildAdPayload,
  } = ctx;

  app.get('/api/ad', async (_req, res) => {
    res.json(buildAdPayload(await AdConfig.findOne({ key: 'main' }).lean()));
  });

  app.get('/api/salons', async (req, res) => {
    const userLocation = getCoordinates(req.query);
    if (!userLocation) return res.status(400).json({ message: 'latitude and longitude are required' });
    const radiusKm = toFiniteNumber(req.query.radiusKm) ?? 10;
    const limit = normalizeLimit(req.query.limit);
    const minResults = normalizeLimit(req.query.minResults, 10, limit);
    const maxRadiusKm = toFiniteNumber(req.query.maxRadiusKm) ?? 5000;
    const salonList = await getNearbySalons(userLocation, radiusKm, limit, minResults, maxRadiusKm);
    res.json(await Promise.all(salonList.map(async (s) => {
      const { fullDescription, openingHours, phone, staffIds, services, staff, reviews, geoLocation, _id, __v, createdAt, updatedAt, ...basic } = stripSensitiveSalonFields(s);
      return {
        ...basic,
        image: await salonCoverImage(s),
        images: await existingSalonImages(s),
      };
    })));
  });
  
  app.get('/api/salons/suggestions', async (req, res) => {
    const keyword = String(req.query.keyword || '').trim();
    if (!keyword) return res.json([]);
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const salons = await Salon
      .find({ publishStatus: 'online', name: { $regex: escaped, $options: 'i' } })
      .select('id name address location geoLocation rating image images promoImages description publishStatus')
      .limit(8)
      .lean();
    const userLocation = getCoordinates(req.query);
    res.json(await Promise.all(salons.map(async (salon) => {
      const coordinates = getCoordinates(salon.location || salon.geoLocation);
      const distanceKm = userLocation && coordinates
        ? Number(calculateDistanceKm(userLocation, coordinates).toFixed(2))
        : undefined;
      const { fullDescription, openingHours, phone, staffIds, services, staff, reviews, geoLocation, _id, __v, createdAt, updatedAt, ...basic } = stripSensitiveSalonFields(salon);
      return {
        ...basic,
        image: await salonCoverImage(salon),
        images: await existingSalonImages(salon),
        ...(distanceKm === undefined ? {} : { distanceKm }),
      };
    })));
  });
  
  app.get('/api/salons/:id', async (req, res) => {
    const salon = await Salon.findOne({ id: req.params.id, publishStatus: 'online' })
      .select('-licenseUrl -licenseStatus -licenseRejectReason -licenseSubmittedAt -licenseReviewedAt -pendingContent -contentReviewStatus -contentRejectReason -contentReviewedAt');
    if (!salon) return res.status(404).json({ message: 'Salon not found' });
  
    res.json(await buildSalonDetail(salon));
  });
  
  app.get('/api/favorites', async (req, res) => {
    const { userId } = await resolveRequestUser(req);
    res.json(await readFavoriteSalons(userId));
  });
  
  app.post('/api/favorites/toggle', async (req, res) => {
    const { userId } = await resolveRequestUser(req);
    const salonId = req.body?.id?.toString();
    if (!salonId) return res.status(400).json({ message: 'Salon id is required' });
  
    const existingFavorite = await FavoriteSalon.findOne({ userId: { $in: userIdAliases(userId) }, salonId });
  
    if (existingFavorite) {
      await existingFavorite.deleteOne();
    } else {
      await FavoriteSalon.create({
        userId,
        salonId,
        salon: req.body,
      });
    }
  
    res.json(await readFavoriteSalons(userId));
  });
};
