const { normalizeDocument } = require('../services/salon');
const { funnelMetrics } = require('../services/analytics');
const { bookingDayRange } = require('../services/booking');

module.exports = (app, ctx) => {
  const {
    AdminUser,
    AdConfig,
    crypto,
    buildAdminUserPayload,
    buildClientUserPayload,
    buildMerchantUserPayload,
    MerchantUser,
    ClientUser,
    Salon,
    Booking,
    buildAdminMerchantPayload,
    normalizeDeposit,
    normalizeSalonTags,
    ensureSalonForMerchant,
    hashPassword,
    applyPendingContent,
    normalizeBooking,
    buildAdPayload,
    normalizeAdLink,
    saveBase64Image,
    privateImageUrl,
    publishModeratedImage,
    deleteModeratedImages,
    normalizePagination,
    setPaginationHeaders,
    rateLimits,
    logoutSession,
    revokeSessionHash,
    clearPublicSalonDetailCache,
    SupportMessage,
    CouponCampaign,
    UserCoupon,
    campaignPayload,
    validateCampaignInput,
    AnalyticsEvent,
    requireQualificationForPublishing = false,
  } = ctx;

  const buildCampaignResponse = async (campaign) => {
    const [grantedCouponCount, claimedCouponCount, typeStats] = await Promise.all([
      UserCoupon.countDocuments({ campaignKey: 'new-user-registration' }),
      UserCoupon.countDocuments({
        campaignKey: 'new-user-registration',
        claimedAt: { $exists: true },
      }),
      UserCoupon.aggregate([
        { $match: { campaignKey: 'new-user-registration' } },
        {
          $group: {
            _id: '$couponType',
            grantedCount: { $sum: 1 },
            claimedCount: {
              $sum: { $cond: [{ $eq: [{ $type: '$claimedAt' }, 'date'] }, 1, 0] },
            },
          },
        },
      ]),
    ]);
    const statsByType = Object.fromEntries(typeStats.map(item => [item._id, item]));
    return {
      campaign: campaignPayload(campaign),
      stats: {
        eligibleUserCount: Math.floor(grantedCouponCount / 2),
        grantedCouponCount,
        claimedCouponCount,
        coupons: ['99-20', '199-30'].map(type => ({
          type,
          grantedCount: statsByType[type]?.grantedCount || 0,
          claimedCount: statsByType[type]?.claimedCount || 0,
        })),
      },
    };
  };

  app.get('/api/admin/auth/me', async (req, res) => {
    res.json({ user: buildAdminUserPayload(req.adminUser) });
  });

  app.post('/api/admin/auth/logout', async (req, res) => {
    await logoutSession(AdminUser, req.adminUser, req);
    res.json({ ok: true });
  });
  
  app.get('/api/admin/overview', async (req, res) => {
    const today = bookingDayRange();
    const yesterday = {
      start: new Date(today.start.getTime() - 24 * 60 * 60 * 1000),
      end: today.start,
    };
    const [merchantCount, clientCount, yesterdayNewClientCount, salonCount, bookingCount, pendingCount, acceptedCount, funnelRows] = await Promise.all([
      MerchantUser.countDocuments(),
      ClientUser.countDocuments(),
      ClientUser.countDocuments({ createdAt: { $gte: yesterday.start, $lt: yesterday.end } }),
      Salon.countDocuments(),
      Booking.countDocuments(),
      Booking.countDocuments({ status: 'pending' }),
      Booking.countDocuments({ status: 'accepted' }),
      AnalyticsEvent.aggregate([
        { $match: { createdAt: { $gte: yesterday.start, $lt: yesterday.end } } },
        { $group: { _id: '$name', count: { $sum: 1 } } },
      ]),
    ]);
  
    res.json({
      merchantCount,
      clientCount,
      yesterdayNewClientCount,
      salonCount,
      bookingCount,
      pendingCount,
      acceptedCount,
      funnel: funnelMetrics(funnelRows),
    });
  });

  app.get('/api/admin/support-messages', async (req, res) => {
    const pagination = normalizePagination(req.query);
    const [messages, total] = await Promise.all([
      SupportMessage.find({})
        .select('-_id -__v')
        .sort({ createdAt: -1 })
        .skip(pagination.skip)
        .limit(pagination.limit)
        .lean(),
      SupportMessage.countDocuments(),
    ]);
    setPaginationHeaders(res, pagination, total);
    res.json(messages);
  });

  app.get('/api/admin/ad', async (_req, res) => {
    res.json(buildAdPayload(await AdConfig.findOne({ key: 'main' }).lean()));
  });

  app.get('/api/admin/campaigns/new-user-registration', async (_req, res) => {
    res.json(await buildCampaignResponse(
      await CouponCampaign.findOne({ key: 'new-user-registration' }).lean(),
    ));
  });

  app.patch('/api/admin/campaigns/new-user-registration', ...rateLimits.upload, async (req, res) => {
    const hasNewImage = Boolean(req.body.promotionImageData);
    const parsed = validateCampaignInput({
      ...req.body,
      promotionImageUrl: req.body.promotionImageUrl || (hasNewImage ? 'pending-upload' : ''),
    });
    if (parsed.error) return res.status(400).json({ message: parsed.error });
    if (hasNewImage) {
      const imageUrl = await saveBase64Image(
        'coupon-promotion',
        req.body.promotionImageFileName || 'coupon-promotion.jpeg',
        req.body.promotionImageData,
      );
      if (!imageUrl) return res.status(400).json({ message: '图片无效或超过 5MB' });
      parsed.value.promotionImageUrl = imageUrl;
    }
    const campaign = await CouponCampaign.findOneAndUpdate(
      { key: 'new-user-registration' },
      { ...parsed.value, updatedBy: req.adminUser.id },
      { upsert: true, new: true, runValidators: true },
    ).lean();
    res.json(await buildCampaignResponse(campaign));
  });

  app.patch('/api/admin/ad', ...rateLimits.upload, async (req, res) => {
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
  
  app.get('/api/admin/merchants', async (req, res) => {
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
  
  app.post('/api/admin/merchants', async (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const displayName = String(req.body.displayName || '').trim();
    const salonId = String(req.body.salonId || '1').trim();
    const deposit = normalizeDeposit(req.body.deposit);
    const tagsError = validateSalonTags(req.body.tags);
  
    if (!username || !password || !displayName) {
      return res.status(400).json({ message: 'username, password and displayName are required' });
    }
    if (username.length > 100 || password.length > 128 || displayName.length > 100 || salonId.length > 100) {
      return res.status(400).json({ message: 'Merchant field is too long' });
    }
    if (deposit === null) return res.status(400).json({ message: '保证金必须是非负数字' });
    if (tagsError) return res.status(400).json({ message: tagsError });
    if (password.length < 6) return res.status(400).json({ message: '密码至少 6 位' });
    if (await MerchantUser.findOne({ username })) {
      return res.status(409).json({ message: '该商家账号已存在' });
    }
  
    const salon = await ensureSalonForMerchant({ salonId, displayName });
    if (req.body.tags !== undefined) {
      salon.tags = normalizeSalonTags(req.body.tags);
      await salon.save();
      clearPublicSalonDetailCache();
    }
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
  
  app.patch('/api/admin/merchants/:id', async (req, res) => {
    const user = await MerchantUser.findOne({ id: req.params.id });
    if (!user) return res.status(404).json({ message: 'Merchant user not found' });
  
    const username = String(req.body.username || '').trim();
    const displayName = String(req.body.displayName || '').trim();
    const salonId = String(req.body.salonId || '').trim();
    const password = String(req.body.password || '');
    const deposit = req.body.deposit === undefined ? undefined : normalizeDeposit(req.body.deposit);
    const tagsError = validateSalonTags(req.body.tags);

    if (username.length > 100 || displayName.length > 100 || salonId.length > 100 || password.length > 128) {
      return res.status(400).json({ message: 'Merchant field is too long' });
    }
  
    if (deposit === null) return res.status(400).json({ message: '保证金必须是非负数字' });
    if (tagsError) return res.status(400).json({ message: tagsError });
    if (password && password.length < 6) return res.status(400).json({ message: '密码至少 6 位' });
  
    if (username && username !== user.username) {
      if (await MerchantUser.findOne({ username })) {
        return res.status(409).json({ message: '该商家账号已存在' });
      }
      user.username = username;
    }
    if (displayName) user.displayName = displayName;
    let salon;
    if (salonId) {
      salon = await ensureSalonForMerchant({
        salonId,
        displayName: displayName || user.displayName,
      });
      user.salonId = salon.id;
    }
    if (req.body.tags !== undefined) {
      salon ||= await Salon.findOne({ id: user.salonId });
      if (!salon) return res.status(404).json({ message: 'Merchant salon not found' });
      salon.tags = normalizeSalonTags(req.body.tags);
      await salon.save();
      clearPublicSalonDetailCache();
    }
    let revokedSessionHash = '';
    if (password) {
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
  
  app.patch('/api/admin/merchants/:id/license', async (req, res) => {
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
  
  app.patch('/api/admin/merchants/:id/content', async (req, res) => {
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
  
  app.patch('/api/admin/merchants/:id/publish', async (req, res) => {
    const action = String(req.body.action || '').trim();
    if (!['online', 'offline'].includes(action)) {
      return res.status(400).json({ message: 'action must be online or offline' });
    }
  
    const user = await MerchantUser.findOne({ id: req.params.id }).lean();
    if (!user) return res.status(404).json({ message: 'Merchant user not found' });
    const salon = await Salon.findOne({ id: user.salonId });
    if (!salon) return res.status(404).json({ message: 'Merchant salon not found' });
    if (
      requireQualificationForPublishing
      && action === 'online'
      && salon.licenseStatus !== 'approved'
    ) {
      return res.status(409).json({ message: '营业执照审核通过后才能上架' });
    }
    if (action === 'online' && salon.contentReviewStatus !== 'approved') {
      return res.status(409).json({ message: '店铺内容审核通过后才能上架' });
    }
  
    salon.publishStatus = action;
    await salon.save();
  
    res.json({ merchant: await buildAdminMerchantPayload(user, salon) });
  });
  
  app.get('/api/admin/users', async (req, res) => {
    const pagination = normalizePagination(req.query);
    const avatarReviewStatus = String(req.query.avatarReviewStatus || '').trim();
    if (avatarReviewStatus && !['none', 'pending', 'approved', 'rejected'].includes(avatarReviewStatus)) {
      return res.status(400).json({ message: 'Invalid avatar review status' });
    }
    const query = avatarReviewStatus
      ? { avatarReviewStatus: avatarReviewStatus === 'none' ? { $in: ['none', null] } : avatarReviewStatus }
      : {};
    const [users, total] = await Promise.all([
      ClientUser.find(query)
        .select('id account displayName gender avatarUrl pendingAvatarUrl avatarReviewStatus avatarRejectReason avatarSubmittedAt avatarReviewedAt phone createdAt updatedAt lastLoginAt')
        .sort({ createdAt: -1 })
        .skip(pagination.skip)
        .limit(pagination.limit)
        .lean(),
      ClientUser.countDocuments(query),
    ]);
    setPaginationHeaders(res, pagination, total);
  
    res.json(users.map(user => ({
      ...buildClientUserPayload(user),
      pendingAvatarUrl: privateImageUrl(user.pendingAvatarUrl || ''),
      avatarSubmittedAt: user.avatarSubmittedAt,
      avatarReviewedAt: user.avatarReviewedAt,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      lastLoginAt: user.lastLoginAt,
    })));
  });

  app.patch('/api/admin/users/:id/avatar', async (req, res) => {
    const action = String(req.body.action || '').trim();
    const reason = String(req.body.reason || '').trim();
    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ message: 'action must be approve or reject' });
    }
    if (reason.length > 500) {
      return res.status(400).json({ message: '驳回原因不能超过 500 个字符' });
    }

    const user = await ClientUser.findOne({ id: req.params.id });
    if (!user) return res.status(404).json({ message: '用户不存在' });
    const pendingAvatarUrl = String(user.pendingAvatarUrl || '');
    if (!pendingAvatarUrl || user.avatarReviewStatus !== 'pending') {
      return res.status(409).json({ message: '用户没有待审核头像' });
    }

    let approvedAvatarUrl = '';
    if (action === 'approve') {
      approvedAvatarUrl = await publishModeratedImage(pendingAvatarUrl);
      if (!approvedAvatarUrl) {
        return res.status(500).json({ message: '头像发布失败' });
      }
    } else {
      await deleteModeratedImages([pendingAvatarUrl]);
    }

    const reviewedAt = new Date();
    const update = action === 'approve'
      ? {
          $set: {
            avatarUrl: approvedAvatarUrl,
            pendingAvatarUrl: '',
            avatarReviewStatus: 'approved',
            avatarRejectReason: '',
            avatarReviewedAt: reviewedAt,
          },
        }
      : {
          $set: {
            pendingAvatarUrl: '',
            avatarReviewStatus: 'rejected',
            avatarRejectReason: reason,
            avatarReviewedAt: reviewedAt,
          },
        };
    const updatedUser = await ClientUser.findOneAndUpdate(
      { _id: user._id, pendingAvatarUrl, avatarReviewStatus: 'pending' },
      update,
      { new: true },
    );
    if (!updatedUser) {
      return res.status(409).json({ message: '头像审核状态已变更' });
    }
    res.json({ user: buildClientUserPayload(updatedUser) });
  });
  
  app.get('/api/admin/bookings', async (req, res) => {
    const pagination = normalizePagination(req.query);
    const [bookings, total] = await Promise.all([
      Booking.find({}).select('-_id -__v').sort({ createdAt: -1 }).skip(pagination.skip).limit(pagination.limit).lean(),
      Booking.countDocuments(),
    ]);
    setPaginationHeaders(res, pagination, total);
    res.json(bookings.map(normalizeBooking));
  });

  app.get('/api/admin/user-images', async (_req, res) => {
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

  app.patch('/api/admin/user-images', async (req, res) => {
    const bookingId = String(req.body.bookingId || '').trim();
    const type = String(req.body.type || '').trim();
    const action = String(req.body.action || '').trim();
    if (!bookingId || !['review', 'reviewEdit', 'reviewReply', 'complaint'].includes(type) || !['approve', 'reject', 'delete'].includes(action)) {
      return res.status(400).json({ message: 'bookingId, type and action are required' });
    }

    const booking = await Booking.findOne({ id: bookingId });
    if (!booking) return res.status(404).json({ message: 'Image review item not found' });
    if (type === 'reviewReply') {
      const moderated = await moderateReviewReply(booking, action);
      if (!moderated) return res.status(404).json({ message: 'Review reply item not found' });
      clearPublicSalonDetailCache?.();
      return res.json({ ok: true });
    }
    if (type === 'reviewEdit') {
      const moderated = await moderateReviewEdit(
        booking,
        action,
        publishModeratedImage,
        deleteModeratedImages,
      );
      if (!moderated) return res.status(404).json({ message: 'Review edit item not found' });
      clearPublicSalonDetailCache?.();
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
    clearPublicSalonDetailCache?.();

    res.json({ ok: true });
  });
};

function validateSalonTags(tags) {
  if (tags === undefined) return '';
  if (!Array.isArray(tags)) return '店铺标签必须是数组';
  if (tags.length > 5) return '店铺标签最多 5 个';
  if (tags.some(tag => typeof tag !== 'string' || [...tag.trim()].length > 20)) {
    return '每个店铺标签不能超过 20 个字';
  }
  return '';
}

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
  const edit = booking.review?.pendingEdit;
  if (edit) {
    const imageUrls = (edit.imageUrls || []).map(privateImageUrl).filter(Boolean);
    items.push({
      id: `${booking.id}:reviewEdit`,
      bookingId: booking.id,
      type: 'reviewEdit',
      url: imageUrls[0] || '',
      imageUrls,
      userId: booking.userId || '',
      userName: booking.userName || '',
      salonName: booking.salonName || '',
      staffName: booking.staffName || '',
      serviceName: booking.serviceName || '',
      content: edit.comment || '',
      rating: edit.rating || null,
      status: edit.reviewStatus || 'pending',
      createdAt: edit.updatedAt || booking.updatedAt || '',
    });
  }
  return items;
}

async function moderateReviewEdit(
  booking,
  action,
  publishModeratedImage,
  deleteModeratedImages,
) {
  const edit = normalizeDocument(booking.review?.pendingEdit);
  if (!edit) return false;

  if (action === 'approve') {
    const approved = {
      ...edit,
      imageUrls: (await Promise.all((edit.imageUrls || []).map(publishModeratedImage))).filter(Boolean),
      reviewStatus: 'approved',
    };
    delete approved.pendingEdit;
    booking.review = approved;
    booking.reviewed = true;
    booking.markModified('review');
    booking.updatedAt = new Date().toISOString();
    await booking.save();
    return true;
  }

  await deleteModeratedImages(edit.imageUrls || []);
  if (action === 'reject') {
    booking.review.pendingEdit = { ...edit, imageUrls: [], reviewStatus: 'rejected' };
  } else {
    delete booking.review.pendingEdit;
  }
  booking.markModified('review');
  booking.updatedAt = new Date().toISOString();
  await booking.save();
  return true;
}

async function moderateReviewReply(booking, action) {
  const review = normalizeDocument(booking.review) || {};
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
  return true;
}
