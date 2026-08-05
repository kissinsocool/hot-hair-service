module.exports = (app, ctx) => {
  const {
    ClientUser,
    CouponCampaign,
    UserCoupon,
    buildClientUserPayload,
    crypto,
    rateLimits,
    logoutSession,
    createModeratedUploadPolicies,
    verifyModeratedImageObjects,
    deleteModeratedImages,
    sessionTokenFromRequest,
    Booking,
    normalizeBooking,
    normalizePagination,
    setPaginationHeaders,
    userIdAliases,
    privateImageUrl,
    SupportMessage,
    normalizeUserId,
    couponPayload,
    readFavoriteSalons,
    FavoriteSalon,
    publicImageUrl,
  } = ctx;

  app.get('/api/favorites', async (req, res) => {
    const userId = normalizeUserId(req.clientUser.id);
    res.json(await readFavoriteSalons(userId));
  });

  app.put('/api/favorites/:id', async (req, res) => {
    const userId = normalizeUserId(req.clientUser.id);
    const salonId = String(req.params.id || '').trim();
    if (!salonId) return res.status(400).json({ message: 'Salon id is required' });
    try {
      await FavoriteSalon.updateOne(
        { userId, salonId },
        { $setOnInsert: { userId, salonId } },
        { upsert: true },
      );
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
    res.json(await readFavoriteSalons(userId));
  });

  app.delete('/api/favorites/:id', async (req, res) => {
    const userId = normalizeUserId(req.clientUser.id);
    const salonId = String(req.params.id || '').trim();
    if (!salonId) return res.status(400).json({ message: 'Salon id is required' });
    await FavoriteSalon.deleteMany({ userId: { $in: userIdAliases(userId) }, salonId });
    res.json(await readFavoriteSalons(userId));
  });

  app.post('/api/support-messages', ...(rateLimits.support || []), async (req, res) => {
    const problem = String(req.body.problem || '').trim();
    const contact = String(req.body.contact || '').trim();
    if (!problem || !contact) {
      return res.status(400).json({ message: '问题描述和联系方式不能为空' });
    }
    if (problem.length > 500 || contact.length > 100) {
      return res.status(400).json({ message: '问题描述或联系方式过长' });
    }

    const message = await SupportMessage.create({
      id: `support-${crypto.randomUUID()}`,
      userId: normalizeUserId(req.clientUser.id),
      userName: req.clientUser.displayName || req.clientUser.account,
      problem,
      contact,
    });
    res.status(201).json({ id: message.id });
  });

  app.post('/api/uploads/moderation/sign', ...rateLimits.upload, async (req, res) => {
    try {
      const uploads = createModeratedUploadPolicies({
        type: String(req.body.type || ''),
        userId: req.clientUser.id,
        files: req.body.files,
      });
      res.json({ uploads });
    } catch (error) {
      res.status(error.httpStatus || 500).json({ message: error.message });
    }
  });

  app.post('/api/uploads/avatar/sign', ...rateLimits.upload, async (req, res) => {
    try {
      const uploads = createModeratedUploadPolicies({
        type: 'avatar',
        userId: req.clientUser.id,
        files: req.body.files,
      });
      if (uploads.length !== 1) {
        return res.status(400).json({ message: '请选择一张头像图片' });
      }
      res.json({ upload: { ...uploads[0], url: uploads[0].objectName } });
    } catch (error) {
      res.status(error.httpStatus || 500).json({ message: error.message });
    }
  });

  app.get('/api/auth/coupons', async (req, res) => {
    const coupons = await UserCoupon.find({
      userId: { $in: userIdAliases(req.clientUser.id) },
      claimedAt: { $exists: true },
    })
      .sort({ validUntil: 1, discountFen: -1 })
      .lean();
    const now = new Date();
    res.json(coupons.map(coupon => couponPayload(coupon, now)));
  });

  app.get('/api/auth/coupon-campaign', async (req, res) => {
    const now = new Date();
    const [campaign, claimableCoupon] = await Promise.all([
      CouponCampaign.findOne({
        key: 'new-user-registration',
        enabled: true,
        registrationStartAt: { $lte: now },
        registrationEndAt: { $gt: now },
      }).select('promotionImageUrl').lean(),
      UserCoupon.exists({
        campaignKey: 'new-user-registration',
        userId: { $in: userIdAliases(req.clientUser.id) },
        claimedAt: { $exists: false },
        validUntil: { $gt: now },
      }),
    ]);
    const promotionImageUrl = publicImageUrl(campaign?.promotionImageUrl || '');
    res.json({
      enabled: Boolean(promotionImageUrl && claimableCoupon),
      promotionImageUrl,
    });
  });

  app.post('/api/auth/coupon-campaign/claim', ...(rateLimits.booking || []), async (req, res) => {
    const now = new Date();
    const campaign = await CouponCampaign.exists({
      key: 'new-user-registration',
      enabled: true,
      registrationStartAt: { $lte: now },
      registrationEndAt: { $gt: now },
    });
    if (!campaign) return res.status(409).json({ message: '新人礼包活动未开启或已结束' });

    const ownerFilter = {
      campaignKey: 'new-user-registration',
      userId: { $in: userIdAliases(req.clientUser.id) },
      claimedAt: { $exists: false },
      validUntil: { $gt: now },
    };
    const result = await UserCoupon.updateMany(
      ownerFilter,
      { $set: { claimedAt: now } },
    );
    if (!result.modifiedCount) {
      return res.status(409).json({ message: '新人礼包已领取或不可领取' });
    }

    const coupons = await UserCoupon.find({
      campaignKey: 'new-user-registration',
      userId: { $in: userIdAliases(req.clientUser.id) },
      claimedAt: { $exists: true },
    })
      .sort({ discountFen: -1 })
      .lean();
    res.json({ coupons: coupons.map(coupon => couponPayload(coupon, now)) });
  });
  
  app.get('/api/auth/me', async (req, res) => {
    res.json({ user: buildClientUserPayload(req.clientUser) });
  });

  app.get('/api/auth/reviews', async (req, res) => {
    const query = {
      userId: { $in: userIdAliases(req.clientUser.id) },
      review: { $exists: true, $ne: null },
    };
    const pagination = normalizePagination(req.query);
    const [bookings, total] = await Promise.all([
      Booking.find(query)
        .select('id salonId salonName staffId staffName serviceId serviceName review createdAt updatedAt')
        .sort({ updatedAt: -1 })
        .skip(pagination.skip)
        .limit(pagination.limit)
        .lean(),
      Booking.countDocuments(query),
    ]);
    setPaginationHeaders(res, pagination, total);
    res.json(bookings.map(booking => {
      const editStatus = booking.review?.pendingEdit?.reviewStatus || '';
      const review = normalizeBooking(booking).review || {};
      return {
        ...review,
        editStatus,
        imageKeys: review.imageUrls || [],
        imageUrls: (review.imageUrls || []).map(privateImageUrl).filter(Boolean),
        bookingId: booking.id,
        salonId: booking.salonId || '',
        salonName: booking.salonName || '',
        staffId: booking.staffId || '',
        staffName: booking.staffName || '',
        serviceId: booking.serviceId || '',
        serviceName: review.serviceName || booking.serviceName || '',
      };
    }));
  });

  app.post('/api/auth/logout', async (req, res) => {
    await logoutSession(ClientUser, req.clientUser, req);
    res.json({ ok: true });
  });
  
  app.patch('/api/auth/profile', async (req, res) => {
    if (req.body.phone !== undefined || req.body.account !== undefined) {
      return res.status(400).json({ message: '手机号只能通过微信授权绑定，不能在资料中修改' });
    }

    const displayName = String(req.body.displayName || '').trim();
    const gender = String(req.body.gender || '保密').trim();
    const avatarUrl = String(req.body.avatarUrl || '').trim();
    const allowedGenders = new Set(['男', '女', '其他', '保密']);
  
    if (!displayName) {
      return res.status(400).json({ message: '请输入昵称' });
    }
    if (displayName.length > 50 || avatarUrl.length > 2048) {
      return res.status(400).json({ message: '昵称或头像地址过长' });
    }
    const user = await ClientUser.findOne({ id: req.clientUser.id });
    if (!user) {
      return res.status(404).json({ message: '用户不存在' });
    }
  
    const avatarChanged = avatarUrl !== String(user.avatarUrl || '')
      && avatarUrl !== String(user.pendingAvatarUrl || '');
    if (avatarChanged && avatarUrl) {
      try {
        await verifyModeratedImageObjects({
          type: 'avatar',
          userId: req.clientUser.id,
          objectNames: [avatarUrl],
        });
      } catch (error) {
        return res.status(error.httpStatus || 500).json({ message: error.message });
      }
    }

    const replacedPendingAvatar = avatarChanged ? String(user.pendingAvatarUrl || '') : '';
    user.displayName = displayName;
    user.gender = allowedGenders.has(gender) ? gender : '保密';
    if (avatarChanged) {
      if (avatarUrl) {
        user.pendingAvatarUrl = avatarUrl;
        user.avatarReviewStatus = 'pending';
        user.avatarRejectReason = '';
        user.avatarSubmittedAt = new Date();
      } else {
        user.avatarUrl = '';
        user.pendingAvatarUrl = '';
        user.avatarReviewStatus = 'none';
        user.avatarRejectReason = '';
        user.avatarSubmittedAt = undefined;
        user.avatarReviewedAt = undefined;
      }
    }
    await user.save();
    if (replacedPendingAvatar) {
      await deleteModeratedImages([replacedPendingAvatar]).catch(() => {});
    }
  
    res.json({
      token: sessionTokenFromRequest(req),
      user: buildClientUserPayload(user),
    });
  });
};
