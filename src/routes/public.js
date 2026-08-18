module.exports = (app, ctx) => {
  const {
    getNearbySalons,
    normalizeLimit,
    normalizeRadiusKm,
    buildPublicSalonDetail,
    getCoordinates,
    salonCoverImage,
    existingSalonImages,
    Salon,
    calculateDistanceKm,
    stripSensitiveSalonFields,
    AdConfig,
    buildAdPayload,
    CouponCampaign,
    rateLimits,
    getStaffById,
    getSalonByStaffId,
    getStaffMapByIds,
    getApprovedReviewsByStaffIds,
    getApprovedRatingSummariesByStaffIds,
    addApprovedSalonRatings,
    buildStaffPayload,
    generateSlotsForNoPreferenceAndDate,
    generateSlotsForStaffAndDate,
    servicePayload,
    publicImageUrl,
  } = ctx;

  app.get('/api/ad', async (_req, res) => {
    res.json(buildAdPayload(await AdConfig.findOne({ key: 'main' }).lean()));
  });

  app.get('/api/coupon-campaign', ...rateLimits.publicRead, async (_req, res) => {
    const now = new Date();
    const campaign = await CouponCampaign.findOne({
      key: 'new-user-registration',
      enabled: true,
      registrationStartAt: { $lte: now },
      registrationEndAt: { $gt: now },
    }).select('promotionImageUrl').lean();
    const promotionImageUrl = publicImageUrl(campaign?.promotionImageUrl || '');
    res.set('Cache-Control', 'public, max-age=15, stale-while-revalidate=30');
    res.json({ enabled: Boolean(promotionImageUrl), promotionImageUrl });
  });

  app.get('/api/salons', ...rateLimits.publicRead, async (req, res) => {
    res.set('Cache-Control', 'public, max-age=15, stale-while-revalidate=30');
    const userLocation = getCoordinates(req.query);
    if (!userLocation) return res.status(400).json({ message: 'latitude and longitude are required' });
    const radiusKm = normalizeRadiusKm(req.query.radiusKm, 10, 50);
    const limit = normalizeLimit(req.query.limit);
    const minResults = normalizeLimit(req.query.minResults, 10, limit);
    const maxRadiusKm = normalizeRadiusKm(req.query.maxRadiusKm, 50, 100, radiusKm);
    const salonList = await addApprovedSalonRatings(
      await getNearbySalons(userLocation, radiusKm, limit, minResults, maxRadiusKm),
    );
    res.json(await Promise.all(salonList.map(async (s) => {
      const { fullDescription, openingHours, phone, staffIds, services, staff, reviews, geoLocation, _id, __v, createdAt, updatedAt, ...basic } = stripSensitiveSalonFields(s);
      const images = await existingSalonImages(s);
      return {
        ...basic,
        image: await salonCoverImage(s),
        images,
        promoImages: images,
      };
    })));
  });
  
  app.get('/api/salons/suggestions', ...rateLimits.publicRead, async (req, res) => {
    const keyword = String(req.query.keyword || '').trim();
    if (!keyword) return res.json([]);
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const salons = await Salon
      .find({ publishStatus: 'online', name: { $regex: escaped, $options: 'i' } })
      .select('id name address location geoLocation staffIds image images promoImages description tags publishStatus')
      .limit(8)
      .lean();
    const userLocation = getCoordinates(req.query);
    const ratedSalons = await addApprovedSalonRatings(salons);
    res.json(await Promise.all(ratedSalons.map(async (salon) => {
      const coordinates = getCoordinates(salon.location || salon.geoLocation);
      const distanceKm = userLocation && coordinates
        ? Number(calculateDistanceKm(userLocation, coordinates).toFixed(2))
        : undefined;
      const { fullDescription, openingHours, phone, staffIds, services, staff, reviews, geoLocation, _id, __v, createdAt, updatedAt, ...basic } = stripSensitiveSalonFields(salon);
      const images = await existingSalonImages(salon);
      return {
        ...basic,
        image: await salonCoverImage(salon),
        images,
        promoImages: images,
        ...(distanceKm === undefined ? {} : { distanceKm }),
      };
    })));
  });
  
  app.get('/api/salons/:id', ...rateLimits.publicRead, async (req, res) => {
    const salon = await Salon.findOne({ id: req.params.id, publishStatus: 'online' })
      .select('-licenseUrl -legalPersonIdFrontUrl -legalPersonIdBackUrl -addressProofUrl -licenseStatus -licenseRejectReason -licenseSubmittedAt -licenseReviewedAt -pendingContent -contentReviewStatus -contentRejectReason -contentReviewedAt');
    if (!salon) return res.status(404).json({ message: 'Salon not found' });
  
    res.set('Cache-Control', 'public, max-age=15, stale-while-revalidate=30');
    res.json(await buildPublicSalonDetail(salon));
  });

  app.get('/api/staff/:id', ...rateLimits.publicRead, async (req, res) => {
    const person = await getStaffById(req.params.id).lean();
    if (!person) return res.status(404).json({ message: 'Staff not found' });
    const salon = await getSalonByStaffId(req.params.id).lean();
    const staffMap = salon ? await getStaffMapByIds(salon.staffIds) : {};
    const [reviews, salonReviews, ratingSummaries] = await Promise.all([
      getApprovedReviewsByStaffIds([req.params.id], 50),
      salon ? getApprovedReviewsByStaffIds(salon.staffIds, 150) : [],
      getApprovedRatingSummariesByStaffIds(salon?.staffIds || [req.params.id]),
    ]);
    const reviewsByStaff = salonReviews.reduce((grouped, review) => {
      (grouped[review.staffId] ||= []).push(review);
      return grouped;
    }, {});
    res.json({
      ...buildStaffPayload(person, reviews, ratingSummaries[req.params.id]),
      salonId: salon?.id || '',
      salonServices: (salon?.services || []).map(servicePayload),
      salonStaff: salon ? salon.staffIds.map(id => staffMap[id]).filter(Boolean)
        .map(profile => buildStaffPayload(
          profile,
          reviewsByStaff[profile.id] || [],
          ratingSummaries[profile.id],
        )) : [],
      salonClosedDates: salon?.closedDates || [],
      salonAcceptsSameDayBooking: salon?.acceptsSameDayBooking !== false,
    });
  });

  app.get('/api/staff/:id/slots', ...rateLimits.publicRead, async (req, res) => {
    const staffId = req.params.id;
    const date = req.query.date || '2026-06-01';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ message: 'date must use YYYY-MM-DD format' });
    }
    if (staffId === '__no_preference__') {
      const salon = await Salon.findOne({ id: String(req.query.salonId || '').trim() }).lean();
      if (!salon) return res.status(404).json({ message: 'Salon not found' });
      return res.json(await generateSlotsForNoPreferenceAndDate(salon, date));
    }
    res.json(await generateSlotsForStaffAndDate(staffId, date));
  });
};
