module.exports = (app, ctx) => {
  const {
    normalizePhone,
    isValidPhone,
    hashSmsCode,
    SmsVerification,
    maskPhone,
    loginClientByPhone,
    wechatAppId,
    wechatAppSecret,
    getWechatPhoneNumber,
    decryptWechatPhoneNumber,
    normalizeClientAccount,
    ClientUser,
    CouponCampaign,
    UserCoupon,
    hashPassword,
    newClientUserId,
    verifyPassword,
    buildClientUserPayload,
    requireClientAuth,
    crypto,
    rateLimits,
    createSession,
    rotateSession,
    logoutSession,
    createModeratedUploadPolicies,
    createMerchantUploadPolicies,
    sessionTokenFromRequest,
    Booking,
    normalizeBooking,
    normalizePagination,
    setPaginationHeaders,
    userIdAliases,
    privateImageUrl,
    SupportMessage,
    resolveRequestUser,
    couponPayload,
    createClientUserWithSignupCoupons,
  } = ctx;

  app.post('/api/support-messages', ...(rateLimits.support || []), async (req, res) => {
    const problem = String(req.body.problem || '').trim();
    const contact = String(req.body.contact || '').trim();
    if (!problem || !contact) {
      return res.status(400).json({ message: '问题描述和联系方式不能为空' });
    }
    if (problem.length > 500 || contact.length > 100) {
      return res.status(400).json({ message: '问题描述或联系方式过长' });
    }

    const user = await resolveRequestUser(req);
    const message = await SupportMessage.create({
      id: `support-${crypto.randomUUID()}`,
      userId: user.userId,
      userName: user.userName,
      problem,
      contact,
    });
    res.status(201).json({ id: message.id });
  });

  app.post('/api/uploads/moderation/sign', requireClientAuth, ...rateLimits.upload, async (req, res) => {
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

  app.post('/api/uploads/avatar/sign', requireClientAuth, ...rateLimits.upload, async (req, res) => {
    try {
      const uploads = createMerchantUploadPolicies({
        type: 'public',
        userId: req.clientUser.id,
        files: req.body.files,
      });
      if (uploads.length !== 1) {
        return res.status(400).json({ message: '请选择一张头像图片' });
      }
      res.json({ upload: uploads[0] });
    } catch (error) {
      res.status(error.httpStatus || 500).json({ message: error.message });
    }
  });

  app.post('/api/auth/sms/request', ...rateLimits.smsRequest, async (req, res) => {
    const phone = normalizePhone(req.body.phone);
    if (!isValidPhone(phone)) {
      return res.status(400).json({ message: '请输入有效的手机号' });
    }
  
    const code = String(Math.floor(100000 + Math.random() * 900000));
    await SmsVerification.create({
      phone,
      codeHash: hashSmsCode(phone, code),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });
  
    const payload = {
      message: '验证码已发送',
      expiresInSeconds: 300,
    };
    if (process.env.NODE_ENV !== 'production') payload.debugCode = code;
    res.json(payload);
  });
  
  app.post('/api/auth/sms/verify', ...rateLimits.smsVerify, async (req, res) => {
    const phone = normalizePhone(req.body.phone);
    const code = String(req.body.code || '').trim();
    if (!isValidPhone(phone) || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ message: '手机号或验证码格式不正确' });
    }
  
    const verification = await SmsVerification.findOne({
      phone,
      codeHash: hashSmsCode(phone, code),
      consumedAt: { $exists: false },
      expiresAt: { $gt: new Date() },
    }).sort({ createdAt: -1 });
  
    if (!verification) {
      return res.status(401).json({ message: '验证码错误或已过期' });
    }
  
    verification.consumedAt = new Date();
    await verification.save();
  
    res.json(await loginClientByPhone(phone));
  });
  
  app.post('/api/auth/wechat/phone', ...rateLimits.login, async (req, res) => {
    const code = String(req.body.code || '').trim();
    const encryptedData = String(req.body.encryptedData || '').trim();
    const iv = String(req.body.iv || '').trim();
    const loginCode = String(req.body.loginCode || '').trim();
    if (!code && (!encryptedData || !iv || !loginCode)) {
      return res.status(400).json({ message: '微信手机号授权参数不完整' });
    }
    if (!wechatAppId || !wechatAppSecret) {
      return res.status(503).json({ message: 'WECHAT_APP_ID and WECHAT_APP_SECRET are missing' });
    }
  
    try {
      const phone = code
        ? await getWechatPhoneNumber(code)
        : await decryptWechatPhoneNumber({ encryptedData, iv, loginCode });
      res.json(await loginClientByPhone(phone));
    } catch (err) {
      res.status(401).json({ message: err.message || '微信手机号授权失败' });
    }
  });
  
  app.post('/api/auth/register', ...rateLimits.login, async (req, res) => {
    const account = normalizeClientAccount(req.body.account);
    const password = String(req.body.password || '');
    const displayName = String(req.body.displayName || '').trim();
  
    if (!account || !password || !displayName) {
      return res.status(400).json({ message: 'account, password and displayName are required' });
    }
    if (account.length > 100 || password.length > 128 || displayName.length > 50) {
      return res.status(400).json({ message: '账号、密码或昵称过长' });
    }
    if (password.length < 6) {
      return res.status(400).json({ message: '密码至少 6 位' });
    }
  
    const existingUser = isValidPhone(account)
      ? await ClientUser.findOne({ $or: [{ account }, { phone: account }] })
      : await ClientUser.findOne({ account });
    if (existingUser) return res.status(409).json({ message: '该账号已注册' });
  
    const { salt, hash } = await hashPassword(password);
    const session = createSession();
    const user = await createClientUserWithSignupCoupons({
      id: newClientUserId(),
      account,
      displayName,
      passwordSalt: salt,
      passwordHash: hash,
      sessionTokenHash: session.tokenHash,
      sessionExpiresAt: session.expiresAt,
      lastLoginAt: new Date(),
    });
  
    res.status(201).json({
      token: session.token,
      expiresAt: user.sessionExpiresAt,
      user: buildClientUserPayload(user),
    });
  });

  app.get('/api/auth/coupons', requireClientAuth, async (req, res) => {
    const coupons = await UserCoupon.find({
      userId: { $in: userIdAliases(req.clientUser.id) },
      claimedAt: { $exists: true },
    })
      .sort({ validUntil: 1, discountFen: -1 })
      .lean();
    const now = new Date();
    res.json(coupons.map(coupon => couponPayload(coupon, now)));
  });

  app.get('/api/auth/coupon-campaign', requireClientAuth, async (req, res) => {
    const now = new Date();
    const [campaign, claimableCoupon] = await Promise.all([
      CouponCampaign.exists({
        key: 'new-user-registration',
        enabled: true,
        registrationStartAt: { $lte: now },
        registrationEndAt: { $gt: now },
      }),
      UserCoupon.exists({
        campaignKey: 'new-user-registration',
        userId: { $in: userIdAliases(req.clientUser.id) },
        claimedAt: { $exists: false },
        validUntil: { $gt: now },
      }),
    ]);
    res.json({ enabled: Boolean(campaign && claimableCoupon) });
  });

  app.post('/api/auth/coupon-campaign/claim', requireClientAuth, ...(rateLimits.booking || []), async (req, res) => {
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
  
  app.post('/api/auth/login', ...rateLimits.login, async (req, res) => {
    const account = normalizeClientAccount(req.body.account);
    const password = String(req.body.password || '');
  
    if (!account || !password) {
      return res.status(400).json({ message: 'account and password are required' });
    }
    if (account.length > 100 || password.length > 128) {
      return res.status(400).json({ message: '账号或密码过长' });
    }
  
    const user = isValidPhone(account)
      ? await ClientUser.findOne({ $or: [{ account }, { phone: account }] })
      : await ClientUser.findOne({ account });
    if (!user) return res.status(401).json({ message: '账号或密码错误' });
  
    if (!await verifyPassword(password, user)) {
      return res.status(401).json({ message: '账号或密码错误' });
    }
  
    const session = await rotateSession(user);

    res.json({
      token: session.token,
      expiresAt: session.expiresAt,
      user: buildClientUserPayload(user),
    });
  });
  
  app.get('/api/auth/me', requireClientAuth, async (req, res) => {
    res.json({ user: buildClientUserPayload(req.clientUser) });
  });

  app.get('/api/auth/reviews', requireClientAuth, async (req, res) => {
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

  app.post('/api/auth/logout', requireClientAuth, async (req, res) => {
    await logoutSession(ClientUser, req.clientUser, req);
    res.json({ ok: true });
  });
  
  app.patch('/api/auth/profile', requireClientAuth, async (req, res) => {
    const displayName = String(req.body.displayName || '').trim();
    const gender = String(req.body.gender || '保密').trim();
    const phone = normalizePhone(req.body.phone || req.clientUser.phone || req.clientUser.account);
    const avatarUrl = String(req.body.avatarUrl || '').trim();
    const allowedGenders = new Set(['男', '女', '其他', '保密']);
  
    if (!displayName) {
      return res.status(400).json({ message: '请输入昵称' });
    }
    if (displayName.length > 50 || avatarUrl.length > 2048) {
      return res.status(400).json({ message: '昵称或头像地址过长' });
    }
    if (!isValidPhone(phone)) {
      return res.status(400).json({ message: '请输入有效的手机号' });
    }
  
    const existingUser = await ClientUser.findOne({
      $or: [{ account: phone }, { phone }],
      id: { $ne: req.clientUser.id },
    });
    if (existingUser) {
      return res.status(409).json({ message: '该手机号已被使用' });
    }
  
    const user = await ClientUser.findOne({ id: req.clientUser.id });
    if (!user) {
      return res.status(404).json({ message: '用户不存在' });
    }
  
    user.displayName = displayName;
    user.gender = allowedGenders.has(gender) ? gender : '保密';
    user.phone = phone;
    user.account = phone;
    user.avatarUrl = avatarUrl;
    await user.save();
  
    res.json({
      token: sessionTokenFromRequest(req),
      user: buildClientUserPayload(user),
    });
  });
};
