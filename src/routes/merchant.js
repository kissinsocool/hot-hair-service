module.exports = (app, ctx) => {
  const {
    MerchantUser,
    verifyPassword,
    crypto,
    buildMerchantUserPayload,
    requireMerchantAuth,
    amapWebServiceKey,
    fetchJson,
    parseAmapReverseAddress,
    hashPassword,
    Salon,
    buildMerchantSalonPayload,
    buildContentDraft,
    saveBase64Image,
    savePrivateBase64Image,
    privateImageUrl,
    getStaffById,
    getSalonByStaffId,
    getStaffMapByIds,
    buildStaffPayload,
    generateSlotsForNoPreferenceAndDate,
    generateSlotsForStaffAndDate,
    resolveRequestUser,
    DEMO_USER_ID,
    userIdAliases,
    normalizeBooking,
    Booking,
    USER_CANCEL_WINDOW_MS,
    broadcastBookingEvent,
    calculateStaffRating,
    getUserPolicy,
    getServiceById,
    parseOpeningHours,
    parsePriceValue,
    findActiveBookingAtTime,
    isStaffUnavailable,
    findAcceptedBookingAtTimeExcluding,
    incrementNoShowCount,
    normalizeUserId,
  } = ctx;

  app.post('/api/merchant/auth/login', async (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
  
    if (!username || !password) {
      return res.status(400).json({ message: 'username and password are required' });
    }
  
    const user = await MerchantUser.findOne({ username });
    if (!user) return res.status(401).json({ message: '账号或密码错误' });
  
    if (!verifyPassword(password, user)) {
      return res.status(401).json({ message: '账号或密码错误' });
    }
  
    user.sessionToken = crypto.randomBytes(32).toString('hex');
    user.lastLoginAt = new Date();
    await user.save();
  
    res.json({
      token: user.sessionToken,
      user: buildMerchantUserPayload(user),
    });
  });
  
  app.get('/api/merchant/auth/me', requireMerchantAuth, async (req, res) => {
    res.json({ user: buildMerchantUserPayload(req.merchantUser) });
  });
  
  app.use('/api/merchant', requireMerchantAuth);
  
  app.post('/api/merchant/geocode', async (req, res) => {
    if (!amapWebServiceKey) return res.status(503).json({ message: 'AMAP_WEB_SERVICE_KEY is missing' });
    const address = String(req.body.address || '').trim();
    if (!address) return res.status(400).json({ message: 'address is required' });
    const url = new URL('https://restapi.amap.com/v3/geocode/geo');
    url.searchParams.set('key', amapWebServiceKey);
    url.searchParams.set('address', address);
    url.searchParams.set('output', 'json');
    const data = await fetchJson(url);
    const result = Array.isArray(data?.geocodes) ? data.geocodes[0] : null;
    const location = String(result?.location || '').split(',');
    res.json({
      latitude: location[1] ? Number(location[1]) : null,
      longitude: location[0] ? Number(location[0]) : null,
      address: result?.formatted_address || address,
    });
  });
  
  app.post('/api/merchant/reverse-geocode', async (req, res) => {
    if (!amapWebServiceKey) return res.status(503).json({ message: 'AMAP_WEB_SERVICE_KEY is missing' });
    const latitude = Number(req.body.latitude);
    const longitude = Number(req.body.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return res.status(400).json({ message: 'latitude and longitude are required' });
    }
    const url = new URL('https://restapi.amap.com/v3/geocode/regeo');
    url.searchParams.set('key', amapWebServiceKey);
    url.searchParams.set('location', `${longitude},${latitude}`);
    url.searchParams.set('extensions', 'base');
    url.searchParams.set('output', 'json');
    const data = await fetchJson(url);
    res.json({ latitude, longitude, address: parseAmapReverseAddress(data) });
  });
  
  app.get('/api/merchant/account', async (req, res) => {
    res.json({ user: buildMerchantUserPayload(req.merchantUser) });
  });
  
  app.patch('/api/merchant/account', async (req, res) => {
    const user = await MerchantUser.findOne({ id: req.merchantUser.id });
    if (!user) return res.status(404).json({ message: 'Merchant user not found' });
  
    const displayName = String(req.body.displayName || '').trim();
    const currentPassword = String(req.body.currentPassword || '');
    const newPassword = String(req.body.newPassword || '');
  
    if (displayName) user.displayName = displayName;
  
    if (newPassword) {
      if (newPassword.length < 6) return res.status(400).json({ message: '新密码至少 6 位' });
      if (!verifyPassword(currentPassword, user)) {
        return res.status(401).json({ message: '当前密码错误' });
      }
      const nextPassword = hashPassword(newPassword);
      user.passwordSalt = nextPassword.salt;
      user.passwordHash = nextPassword.hash;
      user.sessionToken = crypto.randomBytes(32).toString('hex');
    }
  
    await user.save();
    res.json({
      token: user.sessionToken,
      user: buildMerchantUserPayload(user),
    });
  });
  
  app.get('/api/merchant/qualification', async (req, res) => {
    const salon = await Salon.findOne({ id: req.merchantUser.salonId || '1' }).lean();
    if (!salon) return res.status(404).json({ message: 'Merchant salon not found' });
  
    res.json({
      salonId: salon.id,
      salonName: salon.name,
      publishStatus: salon.publishStatus || 'offline',
      licenseUrl: privateImageUrl(salon.licenseUrl || ''),
      licenseStatus: salon.licenseStatus || 'unsubmitted',
      licenseRejectReason: salon.licenseRejectReason || '',
      licenseSubmittedAt: salon.licenseSubmittedAt,
      licenseReviewedAt: salon.licenseReviewedAt,
    });
  });
  
  app.patch('/api/merchant/qualification', async (req, res) => {
    const licenseUrl = req.body.data
      ? await savePrivateBase64Image('license', req.body.fileName || 'license.png', req.body.data)
      : String(req.body.licenseUrl || '').trim();
    if (!licenseUrl) return res.status(400).json({ message: 'licenseUrl is required' });
  
    const salon = await Salon.findOne({ id: req.merchantUser.salonId || '1' });
    if (!salon) return res.status(404).json({ message: 'Merchant salon not found' });
  
    salon.licenseUrl = licenseUrl;
    salon.licenseStatus = 'pending';
    salon.licenseRejectReason = '';
    salon.licenseSubmittedAt = new Date();
    await salon.save();
  
    res.json({
      salonId: salon.id,
      salonName: salon.name,
      publishStatus: salon.publishStatus || 'offline',
      licenseUrl: privateImageUrl(salon.licenseUrl || ''),
      licenseStatus: salon.licenseStatus || 'pending',
      licenseRejectReason: salon.licenseRejectReason || '',
      licenseSubmittedAt: salon.licenseSubmittedAt,
      licenseReviewedAt: salon.licenseReviewedAt,
    });
  });
  
  app.get('/api/merchant/salon', async (req, res) => {
    res.json(await buildMerchantSalonPayload(req.merchantUser.salonId || '1'));
  });
  
  app.patch('/api/merchant/salon', async (req, res) => {
    const salon = await Salon.findOne({ id: req.merchantUser.salonId || '1' });
    if (!salon) return res.status(404).json({ message: 'Merchant salon not found' });
  
    const draft = await buildContentDraft(salon, req.body);
    if (typeof draft.name === 'string' && draft.name) {
      const existingSalon = await Salon.findOne({
        id: { $ne: salon.id },
        name: draft.name,
      }).lean();
      if (existingSalon) return res.status(409).json({ message: '店名已存在' });
    }
  
    salon.pendingContent = draft;
    salon.markModified('pendingContent');
    salon.contentReviewStatus = 'pending';
    salon.contentRejectReason = '';
    salon.contentReviewedAt = null;
    await salon.save();
    res.json(await buildMerchantSalonPayload(req.merchantUser.salonId || '1'));
  });
  
  app.post('/api/merchant/uploads', async (req, res) => {
    const { data, fileName = 'avatar.png' } = req.body;
    const url = await saveBase64Image('staff', fileName, data);
    if (!url) return res.status(400).json({ message: 'Valid image data under 5MB is required' });
    res.status(201).json({ url });
  });
  
  app.get('/api/staff/:id', async (req, res) => {
    const person = await getStaffById(req.params.id).lean();
    if (!person) return res.status(404).json({ message: 'Staff not found' });
    const salon = await getSalonByStaffId(req.params.id).lean();
    const staffMap = salon ? await getStaffMapByIds(salon.staffIds) : {};
    res.json({
      ...buildStaffPayload(person),
      salonServices: salon?.services || [],
      salonStaff: salon ? salon.staffIds.map(id => staffMap[id]).filter(Boolean).map(buildStaffPayload) : [],
    });
  });
  
  app.get('/api/staff/:id/slots', async (req, res) => {
    const staffId = req.params.id;
    const date = req.query.date || '2026-06-01';
    const candidateStaffIds = String(req.query.candidateStaffIds || '')
      .split(',')
      .map(id => id.trim())
      .filter(Boolean);
    const slots = staffId === '__no_preference__' && candidateStaffIds.length > 0
      ? await generateSlotsForNoPreferenceAndDate(candidateStaffIds, date)
      : await generateSlotsForStaffAndDate(staffId, date);
    res.json(slots);
  });
  
  app.get('/api/bookings', async (req, res) => {
    const { userId, staffId, status } = req.query;
    const requestUser = await resolveRequestUser(req);
    const query = {};
    if (userId) {
      query.userId = { $in: userIdAliases(userId) };
    } else if (requestUser.userId !== DEMO_USER_ID) {
      query.userId = { $in: userIdAliases(requestUser.userId) };
    }
    if (staffId) query.staffId = staffId;
    if (status) query.status = status;
    const result = await Booking.find(query).sort({ createdAt: -1 });
    res.json(result.map(normalizeBooking));
  });
  
  app.patch('/api/bookings/:id/cancel', async (req, res) => {
    const { userId } = await resolveRequestUser(req);
    const booking = await Booking.findOne({ id: req.params.id, userId: { $in: userIdAliases(userId) } });
    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    if (!['pending', 'accepted'].includes(booking.status)) {
      return res.status(409).json({ message: 'Only pending or accepted bookings can be canceled by user' });
    }
    if (
      booking.status === 'accepted' &&
      new Date(booking.startTime).getTime() - Date.now() < USER_CANCEL_WINDOW_MS
    ) {
      return res.status(409).json({
        message: '预约开始前3小时内不能直接取消，请电话联系商家协商取消。直接爽约3次账号将被拉黑。',
      });
    }
  
    booking.status = 'canceled';
    booking.updatedAt = new Date().toISOString();
    booking.merchantMessage = '用户已取消该预约。';
    booking.userMessage = '您已取消本次预约。';
    booking.rejectReason = '';
    await booking.save();
    broadcastBookingEvent('booking.updated', booking);
  
    res.json({
      message: 'Booking canceled.',
      booking: normalizeBooking(booking),
    });
  });
  
  app.post('/api/bookings/:id/review', async (req, res) => {
    const booking = await Booking.findOne({ id: req.params.id });
    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    const { userId } = await resolveRequestUser(req);
    if (!userIdAliases(userId).includes(normalizeUserId(booking.userId))) {
      return res.status(403).json({ message: 'Cannot review another user booking' });
    }
    if (booking.status !== 'completed') {
      return res.status(409).json({ message: 'Only completed bookings can be reviewed' });
    }
    if (booking.reviewed) {
      return res.status(409).json({ message: 'Booking already reviewed' });
    }
  
    const rating = Number(req.body.rating);
    const comment = String(req.body.comment || '').trim();
    const images = Array.isArray(req.body.images) ? req.body.images.slice(0, 5) : [];
  
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ message: 'rating must be an integer from 1 to 5' });
    }
    if (!comment) {
      return res.status(400).json({ message: 'comment is required' });
    }
  
    const imageUrls = (await Promise.all(
      images.map((image, index) => saveBase64Image('review', image?.fileName, image?.data, index)),
    ))
      .filter(Boolean);
  
    const review = {
      id: 'RV' + Date.now(),
      bookingId: booking.id,
      userName: booking.userName,
      user: booking.userName,
      rating,
      comment,
      date: new Date().toISOString().slice(0, 10),
      serviceName: booking.serviceName,
      imageUrls,
    };
  
    const staffMember = await getStaffById(booking.staffId);
    if (!staffMember) return res.status(404).json({ message: 'Staff not found' });
  
    staffMember.reviews = [review, ...(staffMember.reviews || [])];
    staffMember.rating = calculateStaffRating(staffMember);
    await staffMember.save();
    booking.reviewed = true;
    booking.review = review;
    booking.updatedAt = new Date().toISOString();
    await booking.save();
  
    broadcastBookingEvent('booking.updated', booking);
    res.status(201).json({ review, booking: normalizeBooking(booking) });
  });
  
  app.post('/api/bookings/:id/complaint', async (req, res) => {
    const booking = await Booking.findOne({ id: req.params.id });
    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    const { userId } = await resolveRequestUser(req);
    if (!userIdAliases(userId).includes(normalizeUserId(booking.userId))) {
      return res.status(403).json({ message: 'Cannot complain another user booking' });
    }
    if (booking.status !== 'completed') {
      return res.status(409).json({ message: 'Only completed bookings can be complained' });
    }
    if (booking.complained) {
      return res.status(409).json({ message: 'Booking already complained' });
    }
  
    const description = String(req.body.description || '').trim();
    const images = Array.isArray(req.body.images) ? req.body.images.slice(0, 5) : [];
  
    if (!description) {
      return res.status(400).json({ message: 'description is required' });
    }
  
    const imageUrls = (await Promise.all(
      images.map((image, index) => saveBase64Image('complaint', image?.fileName, image?.data, index)),
    ))
      .filter(Boolean);
  
    const complaint = {
      id: 'CP' + Date.now(),
      bookingId: booking.id,
      userId: booking.userId,
      userName: booking.userName,
      salonId: booking.salonId,
      salonName: booking.salonName,
      staffId: booking.staffId,
      staffName: booking.staffName,
      serviceName: booking.serviceName,
      description,
      imageUrls,
      date: new Date().toISOString().slice(0, 10),
      createdAt: new Date().toISOString(),
      status: 'submitted',
    };
  
    booking.complained = true;
    booking.complaint = complaint;
    booking.updatedAt = new Date().toISOString();
    await booking.save();
  
    broadcastBookingEvent('booking.updated', booking);
    res.status(201).json({ complaint, booking: normalizeBooking(booking) });
  });
  
  app.post('/api/bookings', async (req, res) => {
    const {
      staffId,
      serviceId,
      startTime,
      candidateStaffIds = [],
      note = '',
    } = req.body;
    const { userId, userName } = await resolveRequestUser(req);
  
    if (!staffId || !serviceId || !startTime) {
      return res.status(400).json({ message: 'staffId, serviceId and startTime are required' });
    }
  
    const requestedStartTime = new Date(startTime);
    if (Number.isNaN(requestedStartTime.getTime())) {
      return res.status(400).json({ message: 'startTime must be a valid date time' });
    }
    if (requestedStartTime.getTime() <= Date.now()) {
      return res.status(409).json({ message: 'Only future time slots can be booked' });
    }
  
    const userPolicy = await getUserPolicy(userId);
    if (userPolicy.isBlacklisted) {
      return res.status(403).json({ message: '该账号已因爽约次数过多被拉黑，无法继续预约。' });
    }
  
    const isNoPreference = staffId === '__no_preference__';
    const requestedCandidateStaffIds = Array.isArray(candidateStaffIds)
      ? candidateStaffIds.map(id => String(id || '').trim()).filter(Boolean)
      : [];
    const bookingStaffId = isNoPreference ? requestedCandidateStaffIds[0] : staffId;
    if (!bookingStaffId) {
      return res.status(400).json({ message: 'candidateStaffIds are required when staff is not specified' });
    }
  
    let staffMember = await getStaffById(bookingStaffId).lean();
    const service = await getServiceById(serviceId);
    const salon = await getSalonByStaffId(bookingStaffId).lean();
  
    if (!staffMember || !service || !salon) {
      return res.status(404).json({ message: 'Staff, service or salon not found' });
    }
  
    const { start: openingStart, end: openingEnd } = parseOpeningHours(salon.openingHours);
    const requestedMinutes = requestedStartTime.getHours() * 60 + requestedStartTime.getMinutes();
    if (requestedMinutes < openingStart || requestedMinutes > openingEnd) {
      return res.status(409).json({ message: 'This time is outside salon opening hours' });
    }
  
    let assignedStaffId = bookingStaffId;
    if (isNoPreference) {
      assignedStaffId = null;
      for (const candidateStaffId of requestedCandidateStaffIds) {
        const hasCandidateConflict = await findActiveBookingAtTime(candidateStaffId, startTime);
        const isCandidateUnavailable = await isStaffUnavailable(candidateStaffId, startTime);
        if (!hasCandidateConflict && !isCandidateUnavailable) {
          assignedStaffId = candidateStaffId;
          staffMember = await getStaffById(candidateStaffId).lean();
          break;
        }
      }
      if (!assignedStaffId || !staffMember) {
        return res.status(409).json({ message: 'No staff member is available at the selected time' });
      }
    }
  
    const hasConflict = await findActiveBookingAtTime(assignedStaffId, startTime);
  
    if (hasConflict) {
      return res.status(409).json({ message: 'This slot already has a pending or accepted booking' });
    }
  
    if (await isStaffUnavailable(assignedStaffId, startTime)) {
      return res.status(409).json({ message: 'This staff member is unavailable at the selected time' });
    }
  
    const now = new Date().toISOString();
    const serviceBasePrice = parsePriceValue(service.price);
    const staffExtraServiceFee = isNoPreference ? 0 : Number(staffMember.extraServiceFee || 0);
    const totalPrice = serviceBasePrice + staffExtraServiceFee;
    const booking = await Booking.create({
      id: 'BK' + Date.now(),
      userId,
      userName,
      salonId: salon.id,
      salonName: salon.name,
      staffId: assignedStaffId,
      staffName: isNoPreference ? '无需指定' : staffMember.name,
      isNoPreference,
      serviceId,
      serviceName: service.name,
      servicePrice: service.price,
      serviceDuration: service.duration,
      serviceBasePrice,
      staffExtraServiceFee,
      totalPrice,
      startTime,
      note,
      status: 'pending',
      merchantMessage: '您有一条新的预约申请，请及时处理。',
      userMessage: '预约申请已提交，正在等待商家确认。',
      createdAt: now,
      updatedAt: now,
    });
  
    broadcastBookingEvent('booking.created', booking);
    res.status(201).json({
      message: 'Booking request submitted and waiting for merchant confirmation.',
      booking: normalizeBooking(booking),
    });
  });
  
  app.patch('/api/merchant/bookings/:id', async (req, res) => {
    const { action, reason = '', assignedStaffId = '' } = req.body;
    const booking = await Booking.findOne({ id: req.params.id, salonId: req.merchantUser.salonId });
    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    if (!['accept', 'cancel', 'complete', 'no_show', 'reject'].includes(action)) {
      return res.status(400).json({ message: 'action must be accept, cancel, complete, no_show or reject' });
    }
    if (['accept', 'reject'].includes(action) && booking.status !== 'pending') {
      return res.status(409).json({ message: 'Only pending bookings can be accepted or rejected' });
    }
    if (['cancel', 'complete', 'no_show'].includes(action) && booking.status !== 'accepted') {
      return res.status(409).json({ message: 'Only accepted bookings can be canceled, completed or marked no-show' });
    }
  
    if (action === 'accept') {
      let selectedStaffId = booking.staffId;
      if (booking.isNoPreference || booking.staffName === '无需指定') {
        booking.isNoPreference = true;
        selectedStaffId = String(assignedStaffId || '').trim();
        if (!selectedStaffId) {
          return res.status(400).json({ message: '无需指定理发师的订单接单前必须指定一位理发师' });
        }
  
        const selectedStaff = await getStaffById(selectedStaffId).lean();
        const selectedSalon = selectedStaff ? await getSalonByStaffId(selectedStaffId).lean() : null;
        if (!selectedStaff || !selectedSalon || selectedSalon.id !== booking.salonId) {
          return res.status(404).json({ message: '指定的理发师不属于该店铺' });
        }
        if (await isStaffUnavailable(selectedStaffId, booking.startTime.toISOString())) {
          return res.status(409).json({ message: '指定理发师在该时间段不可预约' });
        }
  
        booking.staffId = selectedStaffId;
        booking.staffName = selectedStaff.name;
      }
  
      const hasConflict = await findAcceptedBookingAtTimeExcluding(
        selectedStaffId,
        booking.startTime,
        booking.id,
      );
      if (hasConflict) {
        return res.status(409).json({ message: '指定理发师在该时间段已有预约' });
      }
    }
  
    booking.status = {
      accept: 'accepted',
      cancel: 'canceled',
      complete: 'completed',
      no_show: 'no_show',
      reject: 'rejected',
    }[action];
    booking.updatedAt = new Date().toISOString();
    booking.merchantMessage = {
      accept: '您已接单。',
      cancel: '您已取消该预约。',
      complete: '订单已完成。',
      no_show: '您已将该预约标记为爽约。',
      reject: '您已拒单。',
    }[action];
    booking.userMessage = {
      accept: '商家已确认，预约成功！',
      cancel: `商家已取消本次预约${reason ? `：${reason}` : '。'}`,
      complete: '本次预约已完成，感谢到店。',
      no_show: '商家已将本次预约标记为爽约。直接爽约3次账号将被拉黑。',
      reject: `商家已拒绝本次预约${reason ? `：${reason}` : '。'}`,
    }[action];
    booking.rejectReason = ['cancel', 'no_show', 'reject'].includes(action) ? reason : '';
    const userPolicy = action === 'no_show' ? await incrementNoShowCount(booking.userId) : null;
    await booking.save();
    broadcastBookingEvent('booking.updated', booking);
  
    res.json({
      message: `Booking ${booking.status}.`,
      booking: normalizeBooking(booking),
      userPolicy,
    });
  });
  
  app.patch('/api/merchant/bookings/:id/review-reply', async (req, res) => {
    const reply = String(req.body.reply || '').trim();
    if (!reply) return res.status(400).json({ message: 'reply is required' });
  
    const booking = await Booking.findOne({ id: req.params.id });
    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    if (!booking.reviewed || !booking.review) {
      return res.status(409).json({ message: 'Booking has no review' });
    }
  
    const replyPayload = {
      content: reply,
      repliedAt: new Date().toISOString(),
    };
    booking.review = {
      ...(booking.review || {}),
      merchantReply: replyPayload,
    };
    booking.markModified('review');
    booking.updatedAt = new Date().toISOString();
  
    const staffMember = await getStaffById(booking.staffId);
    if (staffMember && Array.isArray(staffMember.reviews)) {
      staffMember.reviews = staffMember.reviews.map(review => {
        if (review?.bookingId !== booking.id && review?.id !== booking.review?.id) return review;
        return {
          ...review,
          merchantReply: replyPayload,
        };
      });
      staffMember.markModified('reviews');
      await staffMember.save();
    }
  
    await booking.save();
    broadcastBookingEvent('booking.updated', booking);
    res.json({ booking: normalizeBooking(booking) });
  });
  
  app.get('/api/merchant/bookings', async (req, res) => {
    const { status } = req.query;
    const query = { salonId: req.merchantUser.salonId };
    if (status) query.status = status;
    const result = await Booking.find(query).sort({ createdAt: -1 });
    res.json(result.map(normalizeBooking));
  });
};
