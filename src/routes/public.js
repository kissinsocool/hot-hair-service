const { createPublicResponseCaches } = require('../ttl-cache');
const { BOOKING_SALON_PROJECTION } = require('../services/salon');
const { SALON_RATING_STATS_SELECTION } = require('../services/salon-ratings');

const { readRecommendedPosts: defaultReadRecommendedPosts } = require('../services/recommended-posts');
const {
  PROMOTION_CATEGORY_TAG_IDS,
  parseViewedSalonIds,
  readRecommendedServices: defaultReadRecommendedServices,
} = require('../services/recommended-services');
const { readCategoryPosts: defaultReadCategoryPosts } = require('../services/category-posts');

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
    HomeRecommendationConfig,
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
    ClientUser,
    activeSessionQuery,
    normalizeUserId,
    readRecommendedPosts = defaultReadRecommendedPosts,
    readRecommendedServices = defaultReadRecommendedServices,
    readCategoryPosts = defaultReadCategoryPosts,
    countStaffFavorites,
    countPostFavorites,
  } = ctx;

  // These responses are the same for every caller, and the mini-program does not cache requests itself, so the
  // server reuses them instead of querying on every home view. The app shares one set with the admin and
  // merchant routes, which clear a cache when they change what it holds; a registration without one (tests)
  // gets its own empty set.
  const {
    ad: adCache,
    homeRecommendationConfig: homeRecommendationConfigCache,
    couponCampaign: couponCampaignCache,
    promotedServices: promotedServicesCache,
    recommendedPosts: recommendedPostsCache,
    recommendedServices: recommendedServicesCache,
    categoryPosts: categoryPostsCache,
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

  // 小程序「按分类查找」：该分类下店铺动态的图片（每条动态第一张），点击进入动态详情。
  // 动态按商家发布时选的推广分类归类，规则见 services/category-posts.js。
  app.get('/api/salons/category-posts', ...rateLimits.publicRead, async (req, res) => {
    const { category } = req.query;
    if (typeof category !== 'string' || !Object.hasOwn(PROMOTION_CATEGORY_TAG_IDS, category)) {
      return res.status(400).json({ message: '分类不存在' });
    }
    const pagination = normalizePagination(req.query);
    const sort = req.query.sort === 'distance' ? 'distance' : 'latest';
    const userLocation = sort === 'distance' ? getCoordinates(req.query) : null;
    if (sort === 'distance' && !userLocation) {
      return res.status(400).json({ message: 'latitude and longitude are required' });
    }
    const load = () => readCategoryPosts({ categoryId: category, sort, userLocation, pagination });
    // Distance order depends on the caller's coordinates; only the shared latest order is cached.
    const { images, total } = sort === 'latest'
      ? await categoryPostsCache.get(`${category}:${pagination.page}:${pagination.limit}`, load)
      : await load();
    setPaginationHeaders(res, pagination, total);
    res.set('Cache-Control', 'public, max-age=15, stale-while-revalidate=30');
    res.json(images);
  });

  // 「按分类查找」的第一版数据（推广套餐的图片，点击进入店铺）：已发布的小程序仍在使用，
  // 新版小程序改用上面的 /api/salons/category-posts。线上不再有旧版本后删除。
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

  // 后台「动态审核」页的开关：关闭后两个推荐接口都返回空，小程序首页不显示推荐模块。没有记录时按显示处理。
  const homeRecommendationsEnabled = () => homeRecommendationConfigCache.get('main', async () => {
    const config = await HomeRecommendationConfig.findOne({ key: 'main' }).select('enabled').lean();
    return config?.enabled !== false;
  });

  // 已登录的小程序用户（登录态无效时按未登录处理）。
  const viewerIdFromRequest = async (req) => {
    const token = sessionTokenFromRequest(req);
    const viewer = token
      ? await ClientUser.findOne({ ...activeSessionQuery(token), authProvider: 'wechat' }).select('id').lean()
      : null;
    return viewer ? normalizeUserId(viewer.id) : '';
  };

  // 小程序首页推荐（「你可能喜欢」）：附近店铺开了推广且已审核通过的套餐。已登录时按最近完成的预约选分类、
  // 标出去过的店；viewedSalonIds 是客户端记录的最近看过的店铺。规则见 services/recommended-services.js。
  // 附近店铺这部分与用户无关，按位置缓存一分钟；因人而异的部分每次现算。
  app.get('/api/salons/recommended-services', ...rateLimits.publicRead, async (req, res) => {
    const userLocation = getCoordinates(req.query);
    if (!userLocation) return res.status(400).json({ message: 'latitude and longitude are required' });
    // 结果因人而异，不允许共享缓存。
    res.set('Cache-Control', 'private, no-store');
    if (!await homeRecommendationsEnabled()) return res.json({ categoryId: '', items: [] });
    const viewerId = await viewerIdFromRequest(req);
    res.json(await readRecommendedServices({
      userLocation,
      limit: normalizeLimit(req.query.limit, 10, 20),
      viewerId,
      viewedSalonIds: parseViewedSalonIds(req.query.viewedSalonIds),
    }, { cache: recommendedServicesCache }));
  });

  // 首页推荐的第一版（数据来自店铺动态）：只为已经对接它的客户端保留，见 services/recommended-posts.js。
  // 小程序首页「套餐推荐」：附近店铺各自最新的、关联了在售套餐的已审核动态。已登录时按最近完成的预约
  // 选分类、标出去过的店；viewedSalonIds 是客户端记录的最近看过的店铺。规则见 services/recommended-posts.js。
  // 附近店铺和动态这部分与用户无关，按位置缓存一分钟；因人而异的部分每次现算。
  app.get('/api/salons/recommended-posts', ...rateLimits.publicRead, async (req, res) => {
    const userLocation = getCoordinates(req.query);
    if (!userLocation) return res.status(400).json({ message: 'latitude and longitude are required' });
    const personalized = req.query.version === '2';
    if (!await homeRecommendationsEnabled()) {
      res.set('Cache-Control', 'private, no-store');
      return res.json(personalized ? { categoryId: '', items: [] } : []);
    }
    const viewerId = personalized ? await viewerIdFromRequest(req) : '';
    // 结果可能因人而异，不允许共享缓存。
    res.set('Cache-Control', 'private, no-store');
    const result = await readRecommendedPosts({
      userLocation,
      limit: normalizeLimit(req.query.limit, 10, 20),
      viewerId,
      viewedSalonIds: personalized ? parseViewedSalonIds(req.query.viewedSalonIds) : [],
    }, { cache: recommendedPostsCache });
    res.json(personalized ? result : result.items.map(({ reasons, ...item }) => item));
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
    res.set('Cache-Control', 'no-store');
    const favoriteCount = await countPostFavorites(post.id);
    res.json({ ...salonPostPayload(post, publicImageUrl), favoriteCount });
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
