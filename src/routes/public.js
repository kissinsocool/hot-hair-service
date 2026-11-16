const { createPublicResponseCaches } = require('../ttl-cache');
const { BOOKING_SALON_PROJECTION } = require('../services/salon');
const { SALON_RATING_STATS_SELECTION } = require('../services/salon-ratings');

const PROMOTION_CATEGORY_TAG_IDS = Object.freeze({
  'men-cut': 'men',
  'women-cut': 'women',
  color: 'color',
  curly: 'curly',
  straight: 'straight',
  care: 'care',
});

// 首页「套餐推荐」只在离用户最近的这些在线店铺里选动态，每家店最多出一条。
const RECOMMENDED_POST_SALON_CANDIDATES = 50;

// 店铺详情随详情一起返回的最新动态条数（小程序「作品集」横向列表）；超过这个数时 hasMorePosts 为 true，客户端显示「全部动态」入口。
const SALON_DETAIL_POST_LIMIT = 10;

module.exports = (app, ctx) => {
  const {
    getCutPriceFromFenBySalonIds,
    getNearbySalons,
    getSalonReviewsPage,
    addReviewHelpfulState,
    sessionTokenFromRequest,
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
    getApprovedRatingSummariesByStaffIds,
    addApprovedSalonRatings,
    buildPublicStaffSummary,
    generateSlotsForNoPreferenceAndDate,
    generateSlotsForStaffAndDate,
    expandedSalonClosedDates,
    servicePayload,
    publicImageUrl,
    setPaginationHeaders,
    SalonPost,
    salonPostPayload,
    salonPostWithSalonPayload,
    countStaffFavorites,
  } = ctx;

  // These responses are the same for every caller, and the mini-program does not cache requests itself, so the
  // server reuses them instead of querying on every home view. The app shares one set with the admin and
  // merchant routes, which clear a cache when they change what it holds; a registration without one (tests)
  // gets its own empty set.
  const {
    ad: adCache,
    couponCampaign: couponCampaignCache,
    promotedServices: promotedServicesCache,
  } = ctx.publicResponseCaches || createPublicResponseCaches();

  // Older mini-program builds still use this endpoint before loading shops.
  app.get('/api/service-area', ...rateLimits.publicRead, (_req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.json({ status: 'open' });
  });

  app.get('/api/ad', async (_req, res) => {
    res.json(await adCache.get('main', async () =>
      buildAdPayload(await AdConfig.findOne({ key: 'main' }).lean())));
  });

  app.get('/api/coupon-campaign', ...rateLimits.publicRead, async (_req, res) => {
    const payload = await couponCampaignCache.get('new-user-registration', async () => {
      const now = new Date();
      const campaign = await CouponCampaign.findOne({
        key: 'new-user-registration',
        enabled: true,
        registrationStartAt: { $lte: now },
        registrationEndAt: { $gt: now },
      }).select('promotionImageUrl').lean();
      const promotionImageUrl = publicImageUrl(campaign?.promotionImageUrl || '');
      return { enabled: Boolean(promotionImageUrl), promotionImageUrl };
    });
    res.set('Cache-Control', 'public, max-age=15, stale-while-revalidate=30');
    res.json(payload);
  });

  app.get('/api/salons/promoted-services', ...rateLimits.publicRead, async (req, res) => {
    const { category } = req.query;
    if (typeof category !== 'string' || !Object.hasOwn(PROMOTION_CATEGORY_TAG_IDS, category)) {
      return res.status(400).json({ message: '分类不存在' });
    }
    const tagId = PROMOTION_CATEGORY_TAG_IDS[category];
    const tagFilter = category === 'women-cut'
      ? { $all: ['wash_cut_blow', 'women'], $nin: ['perm', 'color', 'curly', 'straight'] }
      : tagId;

    const pagination = normalizePagination(req.query);
    const sort = req.query.sort === 'distance' ? 'distance' : 'latest';
    const userLocation = sort === 'distance' ? getCoordinates(req.query) : null;
    if (sort === 'distance' && !userLocation) {
      return res.status(400).json({ message: 'latitude and longitude are required' });
    }
    const pipeline = [
      { $match: {
        publishStatus: 'online',
        services: { $elemMatch: { promotionEnabled: true, promotionReviewStatus: 'approved', tagIds: tagFilter } },
      } },
      { $unwind: '$services' },
      { $match: {
        'services.promotionEnabled': true,
        'services.promotionReviewStatus': 'approved',
        'services.tagIds': tagFilter,
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
    const loadGallery = async () => {
      const [gallery] = await Salon.aggregate(pipeline).option({ maxTimeMS: 5000, allowDiskUse: true });
      return {
        images: (gallery?.items || []).map(image => ({
          id: `${image.salonId}:${image.serviceId}:${image.imageIndex}`,
          salonId: image.salonId,
          serviceId: image.serviceId,
          imageUrl: publicImageUrl(image.imageUrl),
        })),
        total: gallery?.total?.[0]?.count || 0,
      };
    };
    // Distance order depends on the caller's coordinates; only the shared latest order is cached.
    const { images, total } = sort === 'latest'
      ? await promotedServicesCache.get(`${category}:${pagination.page}:${pagination.limit}`, loadGallery)
      : await loadGallery();
    setPaginationHeaders(res, pagination, total);
    res.set('Cache-Control', 'public, max-age=15, stale-while-revalidate=30');
    res.json(images);
  });

  // 小程序首页「套餐推荐」：按距离由近到远，每家在线店铺取一条最新的已审核动态，且动态关联的套餐仍在该店在售。
  // 返回结构与 /api/favorites/posts 的条目相同（动态 + 店铺名称、简介、封面、标签 + relatedService），另带 distanceKm。
  app.get('/api/salons/recommended-posts', ...rateLimits.publicRead, async (req, res) => {
    const userLocation = getCoordinates(req.query);
    if (!userLocation) return res.status(400).json({ message: 'latitude and longitude are required' });
    const limit = normalizeLimit(req.query.limit, 10, 20);
    res.set('Cache-Control', 'public, max-age=15, stale-while-revalidate=30');
    const salons = await Salon.find({
      publishStatus: 'online',
      'services.0': { $exists: true },
      geoLocation: { $nearSphere: { $geometry: {
        type: 'Point',
        coordinates: [userLocation.longitude, userLocation.latitude],
      } } },
    })
      .select('id name description tags image images promoImages services location geoLocation')
      .limit(RECOMMENDED_POST_SALON_CANDIDATES)
      .lean();
    // 每家店只匹配关联了本店现有套餐的动态，套餐已下架的动态不参与推荐。
    const salonFilters = salons
      .map(salon => ({
        salonId: salon.id,
        serviceId: { $in: (salon.services || []).map(service => service.id).filter(Boolean) },
      }))
      .filter(filter => filter.serviceId.$in.length);
    if (!salonFilters.length) return res.json([]);
    const latestPosts = await SalonPost.aggregate([
      { $match: { reviewStatus: 'approved', $or: salonFilters } },
      { $sort: { createdAt: -1, _id: -1 } },
      { $group: { _id: '$salonId', post: { $first: '$$ROOT' } } },
    ]).option({ maxTimeMS: 5000 });
    const postBySalonId = new Map(latestPosts.map(entry => [entry._id, entry.post]));
    res.json(salons
      .filter(salon => postBySalonId.has(salon.id))
      .slice(0, limit)
      .map((salon) => {
        const coordinates = getCoordinates(salon.location || salon.geoLocation);
        return {
          ...salonPostWithSalonPayload(postBySalonId.get(salon.id), salon, publicImageUrl),
          ...(coordinates
            ? { distanceKm: Number(calculateDistanceKm(userLocation, coordinates).toFixed(2)) }
            : {}),
        };
      }));
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
    const cutPrices = await getCutPriceFromFenBySalonIds(salonList.map(s => s.id));
    res.json(await Promise.all(salonList.map(async (s) => {
      const { fullDescription, openingHours, weeklyClosedDays, phone, staffIds, services, staff, reviews, geoLocation, _id, __v, createdAt, updatedAt, ...basic } = stripSensitiveSalonFields(s);
      const images = await existingSalonImages(s);
      const cutPriceFromFen = cutPrices.get(s.id);
      return {
        ...basic,
        image: await salonCoverImage(s),
        images,
        promoImages: images,
        // Optional: absent for a salon without a haircut service.
        ...(cutPriceFromFen === undefined ? {} : { cutPriceFromFen }),
      };
    })));
  });
  
  app.get('/api/salons/suggestions', ...rateLimits.publicRead, async (req, res) => {
    const keyword = String(req.query.keyword || '').trim();
    if (!keyword) return res.json([]);
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const query = { publishStatus: 'online', name: { $regex: escaped, $options: 'i' } };
    if (req.query.view === 'compact') {
      const salons = await Salon.find(query).select('id name address -_id').limit(5).lean();
      return res.json(salons);
    }
    const salons = await Salon
      .find(query)
      .select(`id name address location geoLocation image images promoImages description tags businessDistrict publishStatus ${SALON_RATING_STATS_SELECTION}`)
      .limit(8)
      .lean();
    const userLocation = getCoordinates(req.query);
    const ratedSalons = await addApprovedSalonRatings(salons);
    res.json(await Promise.all(ratedSalons.map(async (salon) => {
      const coordinates = getCoordinates(salon.location || salon.geoLocation);
      const distanceKm = userLocation && coordinates
        ? Number(calculateDistanceKm(userLocation, coordinates).toFixed(2))
        : undefined;
      const { fullDescription, openingHours, weeklyClosedDays, afterSalesPolicyIds, phone, staffIds, services, staff, reviews, geoLocation, _id, __v, createdAt, updatedAt, ...basic } = stripSensitiveSalonFields(salon);
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
    // Only the cache key is read here; the full salon is loaded when the cached detail is missing or stale.
    const current = await Salon.findOne({ id: req.params.id, publishStatus: 'online' }).select('id updatedAt').lean();
    if (!current) return res.status(404).json({ message: 'Salon not found' });
  
    const [detail, latestPosts] = await Promise.all([
      buildPublicSalonDetail(current),
      SalonPost.find({ salonId: current.id, reviewStatus: 'approved' })
        .sort({ createdAt: -1, _id: -1 }).limit(SALON_DETAIL_POST_LIMIT + 1).lean(),
    ]);
    if (!detail) return res.status(404).json({ message: 'Salon not found' });
    const reviews = await addReviewHelpfulState(detail.reviews || [], sessionTokenFromRequest(req));
    res.set('Cache-Control', 'private, no-store');
    res.json({
      ...detail,
      reviews,
      latestPosts: latestPosts.slice(0, SALON_DETAIL_POST_LIMIT).map(post => salonPostPayload(post, publicImageUrl)),
      hasMorePosts: latestPosts.length > SALON_DETAIL_POST_LIMIT,
    });
  });

  app.get('/api/salons/:id/reviews', ...rateLimits.publicRead, async (req, res) => {
    const filter = req.query.filter === undefined ? 'latest' : req.query.filter;
    if (!['latest', 'negative', 'neutral', 'photos'].includes(filter)) {
      return res.status(400).json({ message: '评价筛选类型无效' });
    }
    const salon = await Salon.findOne({ id: req.params.id, publishStatus: 'online' })
      .select(`id ${SALON_RATING_STATS_SELECTION}`).lean();
    if (!salon) return res.status(404).json({ message: 'Salon not found' });
    const pagination = normalizePagination(req.query, 10, 50);
    const result = await getSalonReviewsPage(salon, pagination, filter);
    const items = await addReviewHelpfulState(result.items, sessionTokenFromRequest(req));
    res.set('Cache-Control', 'private, no-store');
    res.json({ ...result, items });
  });

  app.get('/api/salons/:id/posts', ...rateLimits.publicRead, async (req, res) => {
    const salon = await Salon.findOne({ id: req.params.id, publishStatus: 'online' }).select('id').lean();
    if (!salon) return res.status(404).json({ message: 'Salon not found' });
    const pagination = normalizePagination(req.query);
    const filter = { salonId: salon.id, reviewStatus: 'approved' };
    if (typeof req.query.authorStaffId === 'string' && req.query.authorStaffId) {
      filter.authorStaffId = req.query.authorStaffId;
    }
    const [posts, total] = await Promise.all([
      SalonPost.find(filter).sort({ createdAt: -1, _id: -1 })
        .skip(pagination.skip).limit(pagination.limit).lean(),
      SalonPost.countDocuments(filter),
    ]);
    setPaginationHeaders(res, pagination, total);
    res.set('Cache-Control', 'public, max-age=15, stale-while-revalidate=30');
    res.json(posts.map(post => salonPostPayload(post, publicImageUrl)));
  });

  // 单条动态：小程序动态详情页（含从分享卡片直接打开）使用，可见范围与列表一致。
  app.get('/api/salons/:id/posts/:postId', ...rateLimits.publicRead, async (req, res) => {
    const salon = await Salon.findOne({ id: req.params.id, publishStatus: 'online' }).select('id').lean();
    if (!salon) return res.status(404).json({ message: 'Salon not found' });
    const post = await SalonPost.findOne({
      id: req.params.postId, salonId: salon.id, reviewStatus: 'approved',
    }).lean();
    if (!post) return res.status(404).json({ message: 'Post not found' });
    res.set('Cache-Control', 'public, max-age=15, stale-while-revalidate=30');
    res.json(salonPostPayload(post, publicImageUrl));
  });

  // Review text is served by /api/staff/:id/reviews so this payload stays small as reviews accumulate.
  app.get('/api/staff/:id', ...rateLimits.publicRead, async (req, res) => {
    const person = await getStaffById(req.params.id).lean();
    if (!person) return res.status(404).json({ message: 'Staff not found' });
    const [salon, ratingSummaries, favoriteCount] = await Promise.all([
      getSalonByStaffId(req.params.id).lean(),
      getApprovedRatingSummariesByStaffIds([person.id]),
      countStaffFavorites(person.id),
    ]);
    res.json({
      ...buildPublicStaffSummary(person, ratingSummaries[person.id]),
      salonId: salon?.id || '',
      salonName: salon?.name || '',
      salonServices: (salon?.services || []).map(servicePayload),
      salonClosedDates: expandedSalonClosedDates(salon),
      salonAcceptsSameDayBooking: salon?.acceptsSameDayBooking !== false,
      favoriteCount,
    });
  });

  app.get('/api/staff/:id/reviews', ...rateLimits.publicRead, async (req, res) => {
    const person = await getStaffById(req.params.id).lean();
    if (!person) return res.status(404).json({ message: 'Staff not found' });
    const pagination = normalizePagination(req.query, 10, 50);
    const filter = req.query.filter === 'positive' ? 'positive' : 'latest';
    const result = await getSalonReviewsPage({ staffIds: [person.id] }, pagination, filter);
    const items = await addReviewHelpfulState(result.items, sessionTokenFromRequest(req));
    res.set('Cache-Control', 'private, no-store');
    res.json({ ...result, items });
  });

  app.get('/api/staff/:id/slots', ...rateLimits.publicRead, async (req, res) => {
    const staffId = req.params.id;
    const date = req.query.date || '2026-06-01';
    const serviceId = String(req.query.serviceId || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ message: 'date must use YYYY-MM-DD format' });
    }
    if (staffId === '__no_preference__') {
      const salon = await Salon.findOne({ id: String(req.query.salonId || '').trim() })
        .select(BOOKING_SALON_PROJECTION).lean();
      if (!salon) return res.status(404).json({ message: 'Salon not found' });
      const service = serviceId && salon.services?.find(item => item.id === serviceId);
      if (serviceId && !service) return res.status(404).json({ message: 'Service not found' });
      return res.json(await generateSlotsForNoPreferenceAndDate(salon, date, service?.durationMinutes || 30));
    }
    if (!serviceId) return res.json(await generateSlotsForStaffAndDate(staffId, date));
    const salon = await getSalonByStaffId(staffId).lean();
    const service = salon?.services?.find(item => item.id === serviceId);
    if (!service) return res.status(404).json({ message: 'Service not found' });
    if ((service.staffSelectionRestricted === true || service.staffSelectionDisabled === true)
      && !(service.selectableStaffIds || []).includes(staffId)) {
      return res.status(409).json({ message: '该理发师不可指定此套餐，请重新选择' });
    }
    res.json(await generateSlotsForStaffAndDate(staffId, date, service.durationMinutes, salon));
  });
};
