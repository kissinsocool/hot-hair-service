const PROMOTION_CATEGORY_TAG_IDS = Object.freeze({
  'men-cut': 'men',
  'women-cut': 'women',
  color: 'color',
  curly: 'curly',
  straight: 'straight',
  care: 'care',
});

module.exports = (app, ctx) => {
  const {
    getNearbySalons,
    normalizeLimit,
    normalizePagination,
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
    expandedSalonClosedDates,
    servicePayload,
    publicImageUrl,
    setPaginationHeaders,
    SalonPost,
    salonPostPayload,
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

  app.get('/api/salons/promoted-services', ...rateLimits.publicRead, async (req, res) => {
    const tagId = PROMOTION_CATEGORY_TAG_IDS[String(req.query.category || '')];
    if (!tagId) return res.status(400).json({ message: '分类不存在' });

    const pagination = normalizePagination(req.query);
    const sort = req.query.sort === 'distance' ? 'distance' : 'latest';
    const userLocation = sort === 'distance' ? getCoordinates(req.query) : null;
    if (sort === 'distance' && !userLocation) {
      return res.status(400).json({ message: 'latitude and longitude are required' });
    }
    const pipeline = [
      { $match: {
        publishStatus: 'online',
        services: { $elemMatch: { promotionEnabled: true, promotionReviewStatus: 'approved', tagIds: tagId } },
      } },
      { $unwind: '$services' },
      { $match: {
        'services.promotionEnabled': true,
        'services.promotionReviewStatus': 'approved',
        'services.tagIds': tagId,
      } },
      { $project: {
        salonId: '$id',
        serviceId: '$services.id',
        imageUrls: { $cond: [
          { $gt: [{ $size: { $ifNull: ['$services.imageUrls', []] } }, 0] },
          '$services.imageUrls',
          ['$services.imageUrl'],
        ] },
        publishedAt: { $ifNull: ['$services.promotionReviewedAt', { $ifNull: ['$updatedAt', new Date(0)] }] },
        location: 1,
        geoLocation: 1,
      } },
      { $unwind: { path: '$imageUrls', includeArrayIndex: 'imageIndex' } },
      { $match: { imageUrls: { $nin: ['', null] } } },
    ];
    if (sort === 'distance') {
      const lat = { $ifNull: ['$location.latitude', { $arrayElemAt: ['$geoLocation.coordinates', 1] }] };
      const lon = { $ifNull: ['$location.longitude', { $arrayElemAt: ['$geoLocation.coordinates', 0] }] };
      const radians = value => ({ $degreesToRadians: value });
      const cosine = { $add: [
        { $multiply: [{ $sin: radians(userLocation.latitude) }, { $sin: radians(lat) }] },
        { $multiply: [{ $cos: radians(userLocation.latitude) }, { $cos: radians(lat) },
          { $cos: radians({ $subtract: [lon, userLocation.longitude] }) }] },
      ] };
      pipeline.push({ $set: { distanceKm: { $cond: [
        { $and: [{ $ne: [lat, null] }, { $ne: [lon, null] }] },
        { $multiply: [6371, { $acos: { $min: [1, { $max: [-1, cosine] }] } }] },
        1e12,
      ] } } });
    }
    pipeline.push(
      { $sort: { ...(sort === 'distance' ? { distanceKm: 1 } : {}), publishedAt: -1,
        salonId: 1, serviceId: 1, imageIndex: 1 } },
      { $facet: {
        items: [
          { $skip: pagination.skip },
          { $limit: pagination.limit },
          { $project: { _id: 0, salonId: 1, serviceId: 1, imageUrl: '$imageUrls', imageIndex: 1 } },
        ],
        total: [{ $count: 'count' }],
      } },
    );
    const [gallery] = await Salon.aggregate(pipeline).option({ maxTimeMS: 5000, allowDiskUse: true });
    const images = (gallery?.items || []).map(image => ({
      id: `${image.salonId}:${image.serviceId}:${image.imageIndex}`,
      salonId: image.salonId,
      serviceId: image.serviceId,
      imageUrl: publicImageUrl(image.imageUrl),
    }));
    setPaginationHeaders(res, pagination, gallery?.total?.[0]?.count || 0);
    res.set('Cache-Control', 'public, max-age=15, stale-while-revalidate=30');
    res.json(images);
  });

  app.get('/api/salons', ...rateLimits.publicRead, async (req, res) => {
    res.set('Cache-Control', 'public, max-age=15, stale-while-revalidate=30');
    const userLocation = getCoordinates(req.query);
    if (!userLocation) return res.status(400).json({ message: 'latitude and longitude are required' });
    const radiusKm = normalizeRadiusKm(req.query.radiusKm, 10, 50);
    const pagination = normalizePagination(req.query, 10);
    const minResults = normalizeLimit(req.query.minResults, 10, pagination.limit);
    const maxRadiusKm = normalizeRadiusKm(req.query.maxRadiusKm, 50, 100, radiusKm);
    const keyword = String(req.query.keyword || '').trim().slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const sort = req.query.sort === 'rating' ? 'rating' : 'distance';
    const salons = await getNearbySalons(
      userLocation,
      radiusKm,
      pagination.limit + 1,
      minResults,
      maxRadiusKm,
      pagination.skip,
      keyword,
      sort,
    );
    const hasMore = salons.length > pagination.limit;
    const salonList = sort === 'rating'
      ? salons.slice(0, pagination.limit)
      : await addApprovedSalonRatings(salons.slice(0, pagination.limit));
    res.set({
      'X-Page': String(pagination.page),
      'X-Page-Size': String(pagination.limit),
      'X-Has-More': String(hasMore),
    });
    res.json(await Promise.all(salonList.map(async (s) => {
      const { fullDescription, openingHours, weeklyClosedDays, phone, staffIds, services, staff, reviews, geoLocation, _id, __v, createdAt, updatedAt, ...basic } = stripSensitiveSalonFields(s);
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
      const { fullDescription, openingHours, weeklyClosedDays, phone, staffIds, services, staff, reviews, geoLocation, _id, __v, createdAt, updatedAt, ...basic } = stripSensitiveSalonFields(salon);
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
  
    const [detail, latestPosts] = await Promise.all([
      buildPublicSalonDetail(salon),
      SalonPost.find({ salonId: salon.id, reviewStatus: 'approved' })
        .sort({ createdAt: -1, _id: -1 }).limit(4).lean(),
    ]);
    res.set('Cache-Control', 'public, max-age=15, stale-while-revalidate=30');
    res.json({
      ...detail,
      latestPosts: latestPosts.slice(0, 3).map(post => salonPostPayload(post, publicImageUrl)),
      hasMorePosts: latestPosts.length > 3,
    });
  });

  app.get('/api/salons/:id/posts', ...rateLimits.publicRead, async (req, res) => {
    const salon = await Salon.findOne({ id: req.params.id, publishStatus: 'online' }).select('id').lean();
    if (!salon) return res.status(404).json({ message: 'Salon not found' });
    const pagination = normalizePagination(req.query);
    const [posts, total] = await Promise.all([
      SalonPost.find({ salonId: salon.id, reviewStatus: 'approved' }).sort({ createdAt: -1, _id: -1 })
        .skip(pagination.skip).limit(pagination.limit).lean(),
      SalonPost.countDocuments({ salonId: salon.id, reviewStatus: 'approved' }),
    ]);
    setPaginationHeaders(res, pagination, total);
    res.set('Cache-Control', 'public, max-age=15, stale-while-revalidate=30');
    res.json(posts.map(post => salonPostPayload(post, publicImageUrl)));
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
      salonClosedDates: expandedSalonClosedDates(salon),
      salonAcceptsSameDayBooking: salon?.acceptsSameDayBooking !== false,
    });
  });

  app.get('/api/staff/:id/slots', ...rateLimits.publicRead, async (req, res) => {
    const staffId = req.params.id;
    const date = req.query.date || '2026-06-01';
    const serviceId = String(req.query.serviceId || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ message: 'date must use YYYY-MM-DD format' });
    }
    if (staffId === '__no_preference__') {
      const salon = await Salon.findOne({ id: String(req.query.salonId || '').trim() }).lean();
      if (!salon) return res.status(404).json({ message: 'Salon not found' });
      const service = serviceId && salon.services?.find(item => item.id === serviceId);
      if (serviceId && !service) return res.status(404).json({ message: 'Service not found' });
      return res.json(await generateSlotsForNoPreferenceAndDate(salon, date, service?.durationMinutes || 30));
    }
    if (!serviceId) return res.json(await generateSlotsForStaffAndDate(staffId, date));
    const salon = await getSalonByStaffId(staffId).lean();
    const service = salon?.services?.find(item => item.id === serviceId);
    if (!service) return res.status(404).json({ message: 'Service not found' });
    res.json(await generateSlotsForStaffAndDate(staffId, date, service.durationMinutes, salon));
  });
};
