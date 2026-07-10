module.exports = (app, ctx) => {
  const {
    AdminUser,
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
    refreshFavoriteSalonSnapshots,
    normalizeBooking,
  } = ctx;

  app.post('/api/admin/auth/login', async (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
  
    if (!username || !password) {
      return res.status(400).json({ message: 'username and password are required' });
    }
  
    const user = await AdminUser.findOne({ username });
    if (!user) return res.status(401).json({ message: '账号或密码错误' });
  
    if (!verifyPassword(password, user)) {
      return res.status(401).json({ message: '账号或密码错误' });
    }
  
    user.sessionToken = crypto.randomBytes(32).toString('hex');
    user.lastLoginAt = new Date();
    await user.save();
  
    res.json({
      token: user.sessionToken,
      user: buildAdminUserPayload(user),
    });
  });
  
  app.get('/api/admin/auth/me', requireAdminAuth, async (req, res) => {
    res.json({ user: buildAdminUserPayload(req.adminUser) });
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
  
  app.get('/api/admin/merchants', requireAdminAuth, async (req, res) => {
    const merchants = await MerchantUser
      .find({})
      .sort({ createdAt: -1 })
      .lean();
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
    if (deposit === null) return res.status(400).json({ message: '保证金必须是非负数字' });
    if (password.length < 6) return res.status(400).json({ message: '密码至少 6 位' });
    if (await MerchantUser.findOne({ username })) {
      return res.status(409).json({ message: '该商家账号已存在' });
    }
  
    const salon = await ensureSalonForMerchant({ salonId, displayName });
    const { salt, hash } = hashPassword(password);
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
    if (password) {
      if (password.length < 6) return res.status(400).json({ message: '密码至少 6 位' });
      const { salt, hash } = hashPassword(password);
      user.passwordSalt = salt;
      user.passwordHash = hash;
      user.sessionToken = '';
    }
    if (deposit !== undefined) user.deposit = deposit;
  
    await user.save();
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
    if (!salon.licenseUrl) return res.status(409).json({ message: '营业执照尚未提交' });
  
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
    if (action === 'approve') await refreshFavoriteSalonSnapshots(salon);
  
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
    const users = await ClientUser
      .find({})
      .sort({ createdAt: -1 })
      .lean();
  
    res.json(users.map(user => ({
      ...buildClientUserPayload(user),
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      lastLoginAt: user.lastLoginAt,
    })));
  });
  
  app.get('/api/admin/bookings', requireAdminAuth, async (req, res) => {
    const bookings = await Booking.find({}).sort({ createdAt: -1 }).limit(100);
    res.json(bookings.map(normalizeBooking));
  });
};
