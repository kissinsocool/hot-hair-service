module.exports = (app, ctx) => {
  const {
    AdminUser,
    AdConfig,
    verifyPassword,
    crypto,
    buildAdminUserPayload,
    buildClientUserPayload,
    buildMerchantUserPayload,
    requireAdminAuth,
    MerchantUser,
    ClientUser,
    Salon,
    Booking,
    buildAdminMerchantPayload,
    normalizeDeposit,
    ensureSalonForMerchant,
    hashPassword,
    applyPendingContent,
    normalizeBooking,
    getStaffById,
    calculateStaffRating,
    buildAdPayload,
    normalizeAdLink,
    saveBase64Image,
    privateImageUrl,
    publishModeratedImage,
    deleteModeratedImages,
    normalizePagination,
    setPaginationHeaders,
    rateLimits,
    rotateSession,
    logoutSession,
    revokeSessionHash,
  } = ctx;

  app.post('/api/admin/auth/login', ...rateLimits.login, async (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
  
    if (!username || !password) {
      return res.status(400).json({ message: 'username and password are required' });
    }
    if (username.length > 100 || password.length > 128) {
      return res.status(400).json({ message: 'username or password is too long' });
    }
  
    const user = await AdminUser.findOne({ username });
    if (!user) return res.status(401).json({ message: '账号或密码错误' });
  
    if (!await verifyPassword(password, user)) {
      return res.status(401).json({ message: '账号或密码错误' });
    }
  
    const session = await rotateSession(user);

    res.json({
      token: session.token,
      expiresAt: session.expiresAt,
      user: buildAdminUserPayload(user),
    });
  });
  
  app.get('/api/admin/auth/me', requireAdminAuth, async (req, res) => {
    res.json({ user: buildAdminUserPayload(req.adminUser) });
  });

  app.post('/api/admin/auth/logout', requireAdminAuth, async (req, res) => {
    await logoutSession(AdminUser, req.adminUser, req);
    res.json({ ok: true });
  });
  
  app.get('/api/admin/overview', requireAdminAuth, async (req, res) => {
    const [merchantCount, clientCount, salonCount, bookingCount, pendingCount, acceptedCount] = await Promise.all([
      MerchantUser.countDocuments(),
      ClientUser.countDocuments(),
      Salon.countDocuments(),
      Booking.countDocuments(),
      Booking.countDocuments({ status: 'pending' }),
      Booking.countDocuments({ status: 'accepted' }),
    ]);
  
    res.json({
      merchantCount,
      clientCount,
      salonCount,
      bookingCount,
      pendingCount,
      acceptedCount,
    });
  });

  app.get('/api/admin/ad', requireAdminAuth, async (_req, res) => {
    res.json(buildAdPayload(await AdConfig.findOne({ key: 'main' }).lean()));
  });

  app.patch('/api/admin/ad', requireAdminAuth, ...rateLimits.upload, async (req, res) => {
    const link = normalizeAdLink(req.body.link);
    if (!link) return res.status(400).json({ message: '跳转链接必须是 /pages/... 小程序页面路径' });
    if (typeof req.body.enabled !== 'boolean') return res.status(400).json({ message: '是否显示必须是布尔值' });

    let imageUrl = String(req.body.imageUrl || '').trim();
    if (req.body.data) {
      imageUrl = await saveBase64Image('ad', req.body.fileName || 'ad.jpeg', req.body.data);
      if (!imageUrl) return res.status(400).json({ message: '图片无效或超过 5MB' });
    }
    if (req.body.enabled && !imageUrl) return res.status(400).json({ message: '请上传广告图片' });

    const config = await AdConfig.findOneAndUpdate(
      { key: 'main' },
      { imageUrl, link, enabled: req.body.enabled },
      { upsert: true, new: true },
    ).lean();
    res.json(buildAdPayload(config));
  });
  
  app.get('/api/admin/merchants', requireAdminAuth, async (req, res) => {
    const pagination = normalizePagination(req.query);
    const [merchants, total] = await Promise.all([
      MerchantUser.find({})
        .select('id username displayName salonId deposit role createdAt updatedAt lastLoginAt')
        .sort({ createdAt: -1 })
        .skip(pagination.skip)
        .limit(pagination.limit)
        .lean(),
      MerchantUser.countDocuments(),
    ]);
    setPaginationHeaders(res, pagination, total);
    const salonsById = Object.fromEntries(
      (await Salon.find({ id: { $in: merchants.map(user => user.salonId) } }).lean())
        .map(salon => [salon.id, salon]),
    );
  
    res.json(await Promise.all(
      merchants.map(user => buildAdminMerchantPayload(user, salonsById[user.salonId]))
    ));
  });
  
  app.post('/api/admin/merchants', requireAdminAuth, async (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const displayName = String(req.body.displayName || '').trim();
    const salonId = String(req.body.salonId || '1').trim();
    const deposit = normalizeDeposit(req.body.deposit);
  
    if (!username || !password || !displayName) {
      return res.status(400).json({ message: 'username, password and displayName are required' });
    }
    if (username.length > 100 || password.length > 128 || displayName.length > 100 || salonId.length > 100) {
      return res.status(400).json({ message: 'Merchant field is too long' });
    }
    if (deposit === null) return res.status(400).json({ message: '保证金必须是非负数字' });
    if (password.length < 6) return res.status(400).json({ message: '密码至少 6 位' });
    if (await MerchantUser.findOne({ username })) {
      return res.status(409).json({ message: '该商家账号已存在' });
    }
  
    const salon = await ensureSalonForMerchant({ salonId, displayName });
    const { salt, hash } = await hashPassword(password);
    const user = await MerchantUser.create({
      id: `merchant-${Date.now()}`,
      username,
      displayName,
      salonId: salon.id,
      deposit,
      role: 'merchant',
      passwordSalt: salt,
      passwordHash: hash,
    });
  
    res.status(201).json({ user: buildMerchantUserPayload(user) });
  });
  
  app.patch('/api/admin/merchants/:id', requireAdminAuth, async (req, res) => {
    const user = await MerchantUser.findOne({ id: req.params.id });
    if (!user) return res.status(404).json({ message: 'Merchant user not found' });
  
    const username = String(req.body.username || '').trim();
    const displayName = String(req.body.displayName || '').trim();
    const salonId = String(req.body.salonId || '').trim();
    const password = String(req.body.password || '');
    const deposit = req.body.deposit === undefined ? undefined : normalizeDeposit(req.body.deposit);

    if (username.length > 100 || displayName.length > 100 || salonId.length > 100 || password.length > 128) {
      return res.status(400).json({ message: 'Merchant field is too long' });
    }
  
    if (deposit === null) return res.status(400).json({ message: '保证金必须是非负数字' });
  
    if (username && username !== user.username) {
      if (await MerchantUser.findOne({ username })) {
        return res.status(409).json({ message: '该商家账号已存在' });
      }
      user.username = username;
    }
    if (displayName) user.displayName = displayName;
    if (salonId) {
      const salon = await ensureSalonForMerchant({
        salonId,
        displayName: displayName || user.displayName,
      });
      user.salonId = salon.id;
    }
    let revokedSessionHash = '';
    if (password) {
      if (password.length < 6) return res.status(400).json({ message: '密码至少 6 位' });
      const { salt, hash } = await hashPassword(password);
      user.passwordSalt = salt;
      user.passwordHash = hash;
      revokedSessionHash = user.sessionTokenHash;
      user.sessionTokenHash = '';
      user.sessionExpiresAt = null;
    }
    if (deposit !== undefined) user.deposit = deposit;

    await user.save();
    if (revokedSessionHash) await revokeSessionHash(revokedSessionHash);
    res.json({ user: buildMerchantUserPayload(user) });
  });
  
  app.patch('/api/admin/merchants/:id/license', requireAdminAuth, async (req, res) => {
    const action = String(req.body.action || '').trim();
    const reason = String(req.body.reason || '').trim();
    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ message: 'action must be approve or reject' });
    }
  
    const user = await MerchantUser.findOne({ id: req.params.id }).lean();
    if (!user) return res.status(404).json({ message: 'Merchant user not found' });
    const salon = await Salon.findOne({ id: user.salonId });
    if (!salon) return res.status(404).json({ message: 'Merchant salon not found' });
    if (
      !salon.licenseUrl
      || !salon.legalPersonIdFrontUrl
      || !salon.legalPersonIdBackUrl
      || !salon.addressProofUrl
    ) {
      return res.status(409).json({ message: '商家资质材料尚未提交完整' });
    }
  
    salon.licenseStatus = action === 'approve' ? 'approved' : 'rejected';
    salon.licenseRejectReason = action === 'reject' ? reason : '';
    salon.licenseReviewedAt = new Date();
    await salon.save();
  
    res.json({ merchant: await buildAdminMerchantPayload(user, salon) });
  });
  
  app.patch('/api/admin/merchants/:id/content', requireAdminAuth, async (req, res) => {
    const action = String(req.body.action || '').trim();
    const reason = String(req.body.reason || '').trim();
    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ message: 'action must be approve or reject' });
    }
  
    const user = await MerchantUser.findOne({ id: req.params.id }).lean();
    if (!user) return res.status(404).json({ message: 'Merchant user not found' });
    const salon = await Salon.findOne({ id: user.salonId });
    if (!salon) return res.status(404).json({ message: 'Merchant salon not found' });
  
    if (action === 'approve') {
      await applyPendingContent(salon);
    }
    salon.contentReviewStatus = action === 'approve' ? 'approved' : 'rejected';
    salon.contentRejectReason = action === 'reject' ? reason : '';
    salon.contentReviewedAt = new Date();
    await salon.save();
    res.json({ merchant: await buildAdminMerchantPayload(user, salon) });
  });
  
  app.patch('/api/admin/merchants/:id/publish', requireAdminAuth, async (req, res) => {
    const action = String(req.body.action || '').trim();
    if (!['online', 'offline'].includes(action)) {
      return res.status(400).json({ message: 'action must be online or offline' });
    }
  
    const user = await MerchantUser.findOne({ id: req.params.id }).lean();
    if (!user) return res.status(404).json({ message: 'Merchant user not found' });
    const salon = await Salon.findOne({ id: user.salonId });
    if (!salon) return res.status(404).json({ message: 'Merchant salon not found' });
    if (action === 'online' && salon.licenseStatus !== 'approved') {
      return res.status(409).json({ message: '营业执照审核通过后才能上架' });
    }
    if (action === 'online' && salon.contentReviewStatus !== 'approved') {
      return res.status(409).json({ message: '店铺内容审核通过后才能上架' });
    }
  
    salon.publishStatus = action;
    await salon.save();
  
    res.json({ merchant: await buildAdminMerchantPayload(user, salon) });
  });
  
  app.get('/api/admin/users', requireAdminAuth, async (req, res) => {
    const pagination = normalizePagination(req.query);
    const [users, total] = await Promise.all([
      ClientUser.find({})
        .select('id account displayName gender avatarUrl phone createdAt updatedAt lastLoginAt')
        .sort({ createdAt: -1 })
        .skip(pagination.skip)
        .limit(pagination.limit)
        .lean(),
      ClientUser.countDocuments(),
    ]);
    setPaginationHeaders(res, pagination, total);
  
    res.json(users.map(user => ({
      ...buildClientUserPayload(user),
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      lastLoginAt: user.lastLoginAt,
    })));
  });
  
  app.get('/api/admin/bookings', requireAdminAuth, async (req, res) => {
    const pagination = normalizePagination(req.query);
    const [bookings, total] = await Promise.all([
      Booking.find({}).select('-_id -__v').sort({ createdAt: -1 }).skip(pagination.skip).limit(pagination.limit).lean(),
      Booking.countDocuments(),
    ]);
    setPaginationHeaders(res, pagination, total);
    res.json(bookings.map(normalizeBooking));
  });

  app.get('/api/admin/user-images', requireAdminAuth, async (_req, res) => {
    const query = {
      $or: [
        { review: { $exists: true, $ne: null } },
        { 'complaint.reviewStatus': 'pending' },
      ],
    };
    const pagination = normalizePagination(_req.query);
    const [bookings, total] = await Promise.all([
      Booking.find(query).select('id userId userName salonName staffName serviceName review complaint updatedAt createdAt')
        .sort({ updatedAt: -1 }).skip(pagination.skip).limit(pagination.limit).lean(),
      Booking.countDocuments(query),
    ]);
    setPaginationHeaders(res, pagination, total);

    res.json(bookings.flatMap(booking => userImageReviewItems(booking, privateImageUrl)));
  });

  app.patch('/api/admin/user-images', requireAdminAuth, async (req, res) => {
    const bookingId = String(req.body.bookingId || '').trim();
    const type = String(req.body.type || '').trim();
    const action = String(req.body.action || '').trim();
    if (!bookingId || !['review', 'reviewReply', 'complaint'].includes(type) || !['approve', 'reject', 'delete'].includes(action)) {
      return res.status(400).json({ message: 'bookingId, type and action are required' });
    }

    const booking = await Booking.findOne({ id: bookingId });
    if (!booking) return res.status(404).json({ message: 'Image review item not found' });
    if (type === 'reviewReply') {
      const moderated = await moderateReviewReply(booking, action, getStaffById);
      if (!moderated) return res.status(404).json({ message: 'Review reply item not found' });
      return res.json({ ok: true });
    }
    if (!booking[type]) return res.status(404).json({ message: 'Image review item not found' });

    const payload = booking[type] || {};
    if (type === 'review' && action === 'approve') {
      payload.imageUrls = (await Promise.all(
        (payload.imageUrls || []).map(publishModeratedImage),
      )).filter(Boolean);
    }
    if (action === 'delete') {
      await deleteModeratedImages(payload.imageUrls || []);
    }

    if (type === 'review' && action !== 'approve') {
      await unpublishStaffReview(booking, payload, getStaffById, calculateStaffRating);
    }

    if (action === 'delete') {
      booking[type] = undefined;
      if (type === 'review') booking.reviewed = false;
      if (type === 'complaint') booking.complained = false;
    } else {
      payload.reviewStatus = action === 'approve' ? 'approved' : 'rejected';
      booking[type] = payload;
      if (type === 'review') booking.reviewed = action === 'approve';
      if (type === 'complaint') booking.complained = action === 'approve';
    }

    booking.markModified(type);
    booking.updatedAt = new Date().toISOString();
    await booking.save();

    if (type === 'review' && action === 'approve') {
      await publishStaffReview(booking, payload, getStaffById, calculateStaffRating);
    }

    res.json({ ok: true });
  });
};

function userImageReviewItems(booking, privateImageUrl) {
  const items = ['review', 'complaint'].flatMap(type => {
    const payload = booking[type] || {};
    if (!Object.keys(payload).length) return [];
    if (type === 'complaint' && payload.reviewStatus !== 'pending') return [];
    const imageUrls = (Array.isArray(payload.imageUrls) ? payload.imageUrls : [])
      .map(url => privateImageUrl(url))
      .filter(Boolean);
    return [{
      id: `${booking.id}:${type}`,
      bookingId: booking.id,
      type,
      url: imageUrls[0] || '',
      imageUrls,
      userId: payload.userId || booking.userId || '',
      userName: booking.userName || '',
      salonName: booking.salonName || '',
      staffName: booking.staffName || '',
      serviceName: booking.serviceName || '',
      content: type === 'review' ? payload.comment || '' : payload.description || '',
      rating: payload.rating || null,
      status: payload.reviewStatus || 'pending',
      createdAt: payload.createdAt || payload.date || booking.updatedAt || booking.createdAt || '',
    }];
  });

  const reply = booking.review?.pendingMerchantReply || booking.review?.merchantReply;
  if (reply) {
    items.push({
      id: `${booking.id}:reviewReply`,
      bookingId: booking.id,
      type: 'reviewReply',
      url: '',
      imageUrls: [],
      userId: booking.userId || '',
      userName: booking.userName || '',
      salonName: booking.salonName || '',
      staffName: booking.staffName || '',
      serviceName: booking.serviceName || '',
      content: reply.content || '',
      rating: null,
      status: reply.reviewStatus || 'approved',
      createdAt: reply.repliedAt || booking.updatedAt || booking.createdAt || '',
    });
  }
  return items;
}

async function moderateReviewReply(booking, action, getStaffById) {
  const review = booking.review || {};
  const pendingReply = review.pendingMerchantReply;
  const publicReply = review.merchantReply;
  const approvableReply = pendingReply || (publicReply?.reviewStatus === 'rejected' ? publicReply : null);
  if (action === 'approve' && !approvableReply) return false;
  if (action === 'reject' && !pendingReply && !publicReply) return false;
  if (action === 'delete' && !pendingReply && !publicReply) return false;

  const reviewedAt = new Date().toISOString();
  let nextPublicReply = publicReply;
  if (action === 'approve') {
    nextPublicReply = { ...approvableReply, reviewStatus: 'approved', reviewedAt };
    booking.review = { ...review, merchantReply: nextPublicReply };
    delete booking.review.pendingMerchantReply;
  } else if (action === 'reject') {
    if (pendingReply) {
      booking.review = {
        ...review,
        pendingMerchantReply: { ...pendingReply, reviewStatus: 'rejected', reviewedAt },
      };
    } else {
      nextPublicReply = { ...publicReply, reviewStatus: 'rejected', reviewedAt };
      booking.review = { ...review, merchantReply: nextPublicReply };
    }
  } else if (pendingReply) {
    booking.review = { ...review };
    delete booking.review.pendingMerchantReply;
  } else {
    nextPublicReply = undefined;
    booking.review = { ...review };
    delete booking.review.merchantReply;
  }

  booking.markModified('review');
  booking.updatedAt = reviewedAt;
  await booking.save();
  if (action === 'approve' || (action === 'reject' && !pendingReply) || (action === 'delete' && !pendingReply)) {
    await syncStaffReviewReply(booking, nextPublicReply, getStaffById);
  }
  return true;
}

async function syncStaffReviewReply(booking, reply, getStaffById) {
  const staffMember = await getStaffById(booking.staffId);
  if (!staffMember || !Array.isArray(staffMember.reviews)) return;
  staffMember.reviews = staffMember.reviews.map(review => {
    if (review?.bookingId !== booking.id && review?.id !== booking.review?.id) return review;
    const updated = { ...review };
    if (reply) updated.merchantReply = reply;
    else delete updated.merchantReply;
    return updated;
  });
  staffMember.markModified('reviews');
  await staffMember.save();
}

async function publishStaffReview(booking, review, getStaffById, calculateStaffRating) {
  const staffMember = await getStaffById(booking.staffId);
  if (!staffMember) return;

  const publicReview = {
    ...review,
    reviewStatus: 'approved',
  };
  staffMember.reviews = [
    publicReview,
    ...(staffMember.reviews || []).filter(item => item?.bookingId !== booking.id && item?.id !== review.id),
  ];
  staffMember.rating = calculateStaffRating(staffMember);
  staffMember.markModified('reviews');
  await staffMember.save();
}

async function unpublishStaffReview(booking, review, getStaffById, calculateStaffRating) {
  const staffMember = await getStaffById(booking.staffId);
  if (!staffMember) return;
  staffMember.reviews = (staffMember.reviews || [])
    .filter(item => item?.bookingId !== booking.id && item?.id !== review.id);
  staffMember.rating = calculateStaffRating(staffMember);
  staffMember.markModified('reviews');
  await staffMember.save();
}
