const bookingService = require('../services/booking');
const salonService = require('../services/salon');
const {
  bookingDayRange,
  generateBookingId,
  isDuplicateSlotError,
  transactionError,
} = bookingService;

module.exports = (app, ctx) => {
  const {
    MerchantUser,
    mongoose,
    verifyPassword,
    crypto,
    buildMerchantUserPayload,
    amapWebServiceKey,
    fetchJson,
    parseAmapReverseAddress,
    hashPassword,
    Salon,
    SlotOccupancy,
    buildMerchantSalonPayload,
    buildSalonDetail,
    buildMerchantBookingScope,
    buildContentDraft,
    applyDirectSalonContent,
    hasReviewableContentChanges,
    saveBase64Image,
    verifyModeratedImageObjects,
    deleteModeratedImages,
    privateImageUrl,
    createMerchantUploadPolicies,
    verifyMerchantQualificationObjects,
    getStaffById,
    getSalonByStaffId,
    getStaffMapByIds,
    buildStaffPayload,
    generateSlotsForNoPreferenceAndDate,
    generateSlotsForStaffAndDate,
    userIdAliases,
    normalizeBooking,
    normalizeMerchantBooking,
    Booking,
    USER_CANCEL_WINDOW_MS,
    broadcastBookingEvent,
    getApprovedReviewsByStaffIds,
    getUserPolicy,
    getServiceById,
    parseOpeningHours,
    findActiveBookingAtTime,
    findActiveBookingAtTimeExcluding,
    isSalonClosedOnDate,
    isSameDayBookingBlocked,
    isStaffUnavailable,
    findAcceptedBookingAtTimeExcluding,
    incrementNoShowCount,
    normalizeUserId,
    normalizePagination,
    parseMerchantRescheduleTime,
    setPaginationHeaders,
    INPUT_LIMITS,
    rateLimits,
    rotateSession,
    logoutSession,
    sessionTokenFromRequest,
    clearPublicSalonDetailCache,
    UserCoupon,
    couponDiscountForOrder,
  } = ctx;

  const reserveBookingSlot = (...args) => bookingService.reserveBookingSlot(SlotOccupancy, ...args);
  const runBookingTransaction = work => bookingService.runBookingTransaction(mongoose, work);

  app.get('/api/merchant/auth/me', async (req, res) => {
    res.json({ user: buildMerchantUserPayload(req.merchantUser) });
  });

  app.post('/api/merchant/auth/logout', async (req, res) => {
    await logoutSession(MerchantUser, req.merchantUser, req);
    res.json({ ok: true });
  });
  
  app.post('/api/merchant/uploads/sign', ...rateLimits.upload, async (req, res) => {
    try {
      const uploads = createMerchantUploadPolicies({
        type: String(req.body.type || ''),
        userId: req.merchantUser.id,
        files: req.body.files,
      });
      res.json({ uploads });
    } catch (error) {
      res.status(error.httpStatus || 500).json({ message: error.message });
    }
  });
  
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

    if (displayName.length > 100 || currentPassword.length > 128 || newPassword.length > 128) {
      return res.status(400).json({ message: 'Account field is too long' });
    }
  
    if (displayName) user.displayName = displayName;
  
    let session;
    if (newPassword) {
      if (newPassword.length < 6) return res.status(400).json({ message: '新密码至少 6 位' });
      if (!await verifyPassword(currentPassword, user)) {
        return res.status(401).json({ message: '当前密码错误' });
      }
      const nextPassword = await hashPassword(newPassword);
      user.passwordSalt = nextPassword.salt;
      user.passwordHash = nextPassword.hash;
      session = await rotateSession(user);
    }

    if (!session) await user.save();
    res.json({
      token: session?.token || sessionTokenFromRequest(req),
      expiresAt: user.sessionExpiresAt,
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
      legalPersonIdFrontUrl: privateImageUrl(salon.legalPersonIdFrontUrl || ''),
      legalPersonIdBackUrl: privateImageUrl(salon.legalPersonIdBackUrl || ''),
      addressProofUrl: privateImageUrl(salon.addressProofUrl || ''),
      licenseStatus: salon.licenseStatus || 'unsubmitted',
      licenseRejectReason: salon.licenseRejectReason || '',
      licenseSubmittedAt: salon.licenseSubmittedAt,
      licenseReviewedAt: salon.licenseReviewedAt,
    });
  });
  
  app.patch('/api/merchant/qualification', async (req, res) => {
    const salon = await Salon.findOne({ id: req.merchantUser.salonId || '1' });
    if (!salon) return res.status(404).json({ message: 'Merchant salon not found' });

    const directObjects = [
      req.body.licenseUrl,
      req.body.legalPersonIdFrontUrl,
      req.body.legalPersonIdBackUrl,
      req.body.addressProofUrl,
    ].filter(value => typeof value === 'string' && value.startsWith('licenses/'));
    try {
      await verifyMerchantQualificationObjects({ userId: req.merchantUser.id, objectNames: directObjects });
    } catch (error) {
      return res.status(error.httpStatus || 500).json({ message: error.message });
    }
    const directOrCurrent = (candidate, current) => directObjects.includes(candidate) ? candidate : current || '';

    const licenseUrl = directOrCurrent(req.body.licenseUrl, salon.licenseUrl);
    const legalPersonIdFrontUrl = directOrCurrent(req.body.legalPersonIdFrontUrl, salon.legalPersonIdFrontUrl);
    const legalPersonIdBackUrl = directOrCurrent(req.body.legalPersonIdBackUrl, salon.legalPersonIdBackUrl);
    const addressProofUrl = directOrCurrent(req.body.addressProofUrl, salon.addressProofUrl);
    if (!licenseUrl || !legalPersonIdFrontUrl || !legalPersonIdBackUrl || !addressProofUrl) {
      return res.status(400).json({ message: '营业执照、法人身份证正反面和地址证明均为必填项' });
    }
  
    salon.licenseUrl = licenseUrl;
    salon.legalPersonIdFrontUrl = legalPersonIdFrontUrl;
    salon.legalPersonIdBackUrl = legalPersonIdBackUrl;
    salon.addressProofUrl = addressProofUrl;
    salon.licenseStatus = 'pending';
    salon.licenseRejectReason = '';
    salon.licenseSubmittedAt = new Date();
    await salon.save();
  
    res.json({
      salonId: salon.id,
      salonName: salon.name,
      publishStatus: salon.publishStatus || 'offline',
      licenseUrl: privateImageUrl(salon.licenseUrl || ''),
      legalPersonIdFrontUrl: privateImageUrl(salon.legalPersonIdFrontUrl || ''),
      legalPersonIdBackUrl: privateImageUrl(salon.legalPersonIdBackUrl || ''),
      addressProofUrl: privateImageUrl(salon.addressProofUrl || ''),
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
  
    const payload = req.body || {};
    const validationError = validateSalonContent(payload, INPUT_LIMITS);
    if (validationError) return res.status(400).json({ message: validationError });

    const currentContent = salon.pendingContent || await buildSalonDetail(salon);
    const requiresReview = Boolean(salon.pendingContent)
      || hasReviewableContentChanges(currentContent, payload);
    await applyDirectSalonContent(salon, payload);

    if (requiresReview) {
      const draft = await buildContentDraft(salon, payload);
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
    }
    await salon.save();
    res.json(await buildMerchantSalonPayload(req.merchantUser.salonId || '1'));
  });
  
  app.patch('/api/merchant/bookings/:id', ...rateLimits.merchantBooking, async (req, res) => {
    const { action, reason = '', assignedStaffId = '', startTime } = req.body;
    const merchantSalon = await Salon.findOne({ id: req.merchantUser.salonId })
      .select('staffIds openingHours closedDates')
      .lean();
    const merchantScope = buildMerchantBookingScope(req.merchantUser.salonId, merchantSalon?.staffIds || []);
    let booking = await Booking.findOne({
      id: req.params.id,
      ...merchantScope,
    });
    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    if (!['accept', 'cancel', 'complete', 'no_show', 'reject', 'reschedule'].includes(action)) {
      return res.status(400).json({ message: 'action must be accept, cancel, complete, no_show, reject or reschedule' });
    }
    if (['accept', 'reject'].includes(action) && booking.status !== 'pending') {
      return res.status(409).json({ message: 'Only pending bookings can be accepted or rejected' });
    }
    if (['cancel', 'complete', 'no_show'].includes(action) && booking.status !== 'accepted') {
      return res.status(409).json({ message: 'Only accepted bookings can be canceled, completed or marked no-show' });
    }

    let update;
    let changed = false;
    if (action === 'reschedule') {
      const parsed = parseMerchantRescheduleTime(booking.status, startTime);
      if (parsed.error) return res.status(parsed.status).json({ message: parsed.error });
      if (isSalonClosedOnDate(merchantSalon, startTime)) {
        return res.status(409).json({ message: '该日期为店铺休息日' });
      }

      const { start: openingStart, end: openingEnd } = parseOpeningHours(merchantSalon?.openingHours);
      const requestedMinutes = bookingService.localTimeMinutes(parsed.value);
      if (requestedMinutes < openingStart || requestedMinutes > openingEnd) {
        return res.status(409).json({ message: 'This time is outside salon opening hours' });
      }
      if (booking.staffId) {
        if (await findActiveBookingAtTimeExcluding(booking.staffId, startTime, booking.id)) {
          return res.status(409).json({ message: '该理发师在新时间段已有预约' });
        }
        if (await isStaffUnavailable(booking.staffId, startTime)) {
          return res.status(409).json({ message: '该理发师在新时间段不可预约' });
        }
      }

      changed = booking.startTime.getTime() !== parsed.value.getTime();
      update = {
        startTime: parsed.value,
        updatedAt: new Date(),
        merchantMessage: '您已变更预约时间。',
        userMessage: `商家已将预约时间变更为 ${startTime}。`,
      };
    } else {
      let selectedStaffId = booking.staffId;
      let selectedStaffName = booking.staffName;
      if (action === 'accept' && (booking.isNoPreference || booking.staffName === '无需指定')) {
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
  
        selectedStaffName = selectedStaff.name;
      }

      if (action === 'accept') {
        const hasConflict = await findAcceptedBookingAtTimeExcluding(
          selectedStaffId,
          booking.startTime,
          booking.id,
        );
        if (hasConflict) {
          return res.status(409).json({ message: '指定理发师在该时间段已有预约' });
        }
      }

      update = {
        status: {
          accept: 'accepted',
          cancel: 'canceled',
          complete: 'completed',
          no_show: 'no_show',
          reject: 'rejected',
        }[action],
        updatedAt: new Date(),
        merchantMessage: {
          accept: '您已接单。',
          cancel: '您已取消该预约。',
          complete: '订单已完成。',
          no_show: '您已将该预约标记为爽约。',
          reject: '您已拒单。',
        }[action],
        userMessage: {
          accept: '商家已确认，预约成功！',
          cancel: `商家已取消本次预约${reason ? `：${reason}` : '。'}`,
          complete: '本次预约已完成，感谢到店。',
          no_show: '商家已将本次预约标记为爽约。直接爽约3次账号将被拉黑。',
          reject: `商家已拒绝本次预约${reason ? `：${reason}` : '。'}`,
        }[action],
        rejectReason: ['cancel', 'no_show', 'reject'].includes(action) ? reason : '',
        ...(action === 'cancel' ? { canceledBy: 'merchant' } : {}),
        ...(action === 'accept' ? { staffId: selectedStaffId, staffName: selectedStaffName } : {}),
      };
    }

    let userPolicy = null;
    try {
      const result = await runBookingTransaction(async (session) => {
        if (['cancel', 'no_show', 'reject'].includes(action) && booking.couponId) {
          await UserCoupon.updateOne(
            {
              id: booking.couponId,
              $or: [
                { reservedBookingId: booking.id },
                { redeemedBookingId: booking.id },
              ],
            },
            {
              $unset: {
                reservedAt: '',
                reservedBookingId: '',
                redeemedAt: '',
                redeemedBookingId: '',
                redeemedSalonId: '',
                redeemedMerchantId: '',
              },
            },
            { session },
          );
          Object.assign(update, {
            couponId: '',
            couponCode: '',
            couponTitle: '',
            couponDiscountFen: 0,
            payableAmountFen: bookingService.normalizeBookingPayload(booking).originalAmountFen,
            couponRedeemedAt: null,
          });
        }
        if (action === 'complete' && booking.couponId && !booking.couponRedeemedAt) {
          const redeemedAt = new Date();
          const redeemed = await UserCoupon.findOneAndUpdate(
            {
              id: booking.couponId,
              reservedBookingId: booking.id,
              redeemedAt: { $exists: false },
            },
            {
              $set: {
                redeemedAt,
                redeemedBookingId: booking.id,
                redeemedSalonId: booking.salonId,
                redeemedMerchantId: req.merchantUser.id,
              },
              $unset: {
                reservedAt: '',
                reservedBookingId: '',
              },
            },
            { new: true, session },
          );
          if (!redeemed) {
            const legacyRedemption = await UserCoupon.findOne({
              id: booking.couponId,
              redeemedBookingId: booking.id,
            }).session(session);
            if (!legacyRedemption) {
              throw transactionError(409, '优惠券状态异常，请刷新后重试');
            }
          }
          update.couponRedeemedAt = redeemed?.redeemedAt || redeemedAt;
        }
        if (action === 'reschedule' && changed && booking.staffId) {
          await SlotOccupancy.updateOne(
            { bookingId: booking.id },
            { $set: { staffId: booking.staffId, startTime: update.startTime } },
            { upsert: true, session },
          );
        }
        if (action === 'accept') {
          await reserveBookingSlot(booking.id, update.staffId, booking.startTime, session);
        }

        const updated = await Booking.findOneAndUpdate(
          {
            id: booking.id,
            ...merchantScope,
            status: booking.status,
            ...(action === 'reschedule' ? { startTime: booking.startTime } : {}),
          },
          { $set: update },
          { new: true, session },
        );
        if (!updated) throw transactionError(409, '订单状态已变更，请刷新后重试');
        const nextPolicy = action === 'no_show'
          ? await incrementNoShowCount(updated.userId, session)
          : null;
        if (!['accept', 'reschedule'].includes(action)) {
          await SlotOccupancy.deleteOne({ bookingId: updated.id }, { session });
        }
        return { booking: updated, userPolicy: nextPolicy };
      });
      booking = result.booking;
      userPolicy = result.userPolicy;
    } catch (error) {
      if (error.httpStatus) return res.status(error.httpStatus).json({ message: error.message });
      if (isDuplicateSlotError(error)) {
        return res.status(409).json({ message: '该理发师在该时间段刚刚被其他订单占用' });
      }
      throw error;
    }
    broadcastBookingEvent('booking.updated', booking);
  
    res.json({
      message: action === 'reschedule' ? 'Booking rescheduled.' : `Booking ${booking.status}.`,
      booking: normalizeMerchantBooking(booking),
      userPolicy,
    });
  });
  
  app.patch('/api/merchant/bookings/:id/review-reply', ...rateLimits.merchantBooking, async (req, res) => {
    const reply = String(req.body.reply || '').trim();
    if (!reply) return res.status(400).json({ message: 'reply is required' });
    if (reply.length > INPUT_LIMITS.reviewReply) {
      return res.status(400).json({ message: `reply cannot exceed ${INPUT_LIMITS.reviewReply} characters` });
    }
  
    const booking = await Booking.findOne({
      id: req.params.id,
      salonId: req.merchantUser.salonId,
    });
    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    if (!booking.reviewed || !booking.review) {
      return res.status(409).json({ message: 'Booking has no review' });
    }
  
    const replyPayload = {
      content: reply,
      repliedAt: new Date().toISOString(),
      reviewStatus: 'pending',
    };
    booking.review = {
      ...(salonService.normalizeDocument(booking.review) || {}),
      pendingMerchantReply: replyPayload,
    };
    booking.markModified('review');
    booking.updatedAt = new Date().toISOString();

    await booking.save();
    broadcastBookingEvent('booking.updated', booking);
    res.json({ booking: normalizeMerchantBooking(booking) });
  });
  
  app.get('/api/merchant/bookings', async (req, res) => {
    const { status, date } = req.query;
    const day = date ? bookingDayRange(date) : null;
    if (date && !day) return res.status(400).json({ message: 'date must use YYYY-MM-DD format' });
    const merchantSalon = await Salon.findOne({ id: req.merchantUser.salonId }).select('staffIds').lean();
    const scope = buildMerchantBookingScope(req.merchantUser.salonId, merchantSalon?.staffIds || []);
    const filters = [scope];
    if (day) filters.push({ startTime: { $gte: day.start, $lt: day.end } });
    if (status) filters.push({ status });
    const query = { $and: filters };
    const pagination = normalizePagination(req.query);
    const [result, total] = await Promise.all([
      Booking.find(query).select('-_id -__v').sort({ createdAt: -1 }).skip(pagination.skip).limit(pagination.limit).lean(),
      Booking.countDocuments(query),
    ]);
    setPaginationHeaders(res, pagination, total);
    res.json(result.map(normalizeMerchantBooking));
  });
};

function validateSalonContent(payload = {}, limits) {
  if (payload.acceptsSameDayBooking !== undefined && typeof payload.acceptsSameDayBooking !== 'boolean') {
    return 'acceptsSameDayBooking must be a boolean';
  }
  const arrays = [
    ['services', limits.services],
    ['staff', limits.contentStaff],
    ['images', 20],
    ['promoImages', 20],
    ['closedDates', limits.closedDates],
  ];
  for (const [field, max] of arrays) {
    if (Array.isArray(payload[field]) && payload[field].length > max) return `${field} cannot exceed ${max} items`;
  }
  const images = [
    ...(Array.isArray(payload.images) ? payload.images : []),
    ...(Array.isArray(payload.promoImages) ? payload.promoImages : []),
  ];
  for (const image of images) {
    if (typeof image !== 'string' || image.length > 2048) return 'image URL is invalid or too long';
  }
  if (Array.isArray(payload.closedDates) && payload.closedDates.some(
    date => typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date),
  )) {
    return 'closedDates must use YYYY-MM-DD format';
  }

  const strings = {
    name: 100,
    address: 200,
    addressDetail: 200,
    description: 500,
    fullDescription: 5000,
    openingHours: 50,
    phone: 32,
    image: 2048,
  };
  for (const [field, max] of Object.entries(strings)) {
    if (typeof payload[field] === 'string' && payload[field].length > max) return `${field} cannot exceed ${max} characters`;
  }
  if (typeof payload.phone === 'string' && !/^[0-9+()\- ]*$/.test(payload.phone)) {
    return 'phone contains unsupported characters';
  }
  if (payload.location !== undefined && !salonService.getCoordinates(payload.location)) {
    return 'location must contain valid latitude and longitude';
  }

  for (const service of Array.isArray(payload.services) ? payload.services : []) {
    if (
      String(service?.name || '').length > 100
      || String(service?.note || '').length > 500
      || String(service?.price || '').length > 50
      || String(service?.duration || '').length > 50
      || String(service?.imageUrl || '').length > 2048
    ) {
      return 'service field is too long';
    }
    if (service?.priceFen !== undefined
      && (!Number.isSafeInteger(service.priceFen) || service.priceFen < 0)) {
      return 'service priceFen must be a non-negative integer';
    }
    if (service?.priceFen === undefined) {
      const legacyPriceText = String(service?.price ?? '').replace(/[^\d.-]/g, '');
      const legacyPrice = Number(legacyPriceText);
      if (!legacyPriceText || !Number.isFinite(legacyPrice) || legacyPrice < 0) {
        return 'service price is invalid';
      }
    }
    const durationMinutes = service?.durationMinutes === undefined
      ? bookingService.durationMinutes(service?.duration)
      : service.durationMinutes;
    if (!Number.isSafeInteger(durationMinutes) || durationMinutes <= 0) {
      return 'service durationMinutes must be a positive integer';
    }
    if (Array.isArray(service?.tags) && service.tags.length > 6) return 'service tags cannot exceed 6 items';
    if (typeof service?.tags === 'string' && service.tags.length > 200) return 'service tags are too long';
  }
  for (const profile of Array.isArray(payload.staff) ? payload.staff : []) {
    if (
      String(profile?.name || '').length > 100
      || String(profile?.role || '').length > 100
      || String(profile?.experience || '').length > 100
      || String(profile?.imageUrl || '').length > 2048
      || String(profile?.bio || '').length > 1000
    ) {
      return 'staff field is too long';
    }
    if (profile?.extraServiceFeeFen !== undefined
      && (!Number.isSafeInteger(profile.extraServiceFeeFen) || profile.extraServiceFeeFen < 0)) {
      return 'staff extraServiceFeeFen must be a non-negative integer';
    }
    if (Array.isArray(profile?.unavailableSlots) && profile.unavailableSlots.length > limits.unavailableSlots) {
      return `unavailableSlots cannot exceed ${limits.unavailableSlots} items`;
    }
  }
  return '';
}

module.exports.bookingDayRange = bookingDayRange;
module.exports.generateBookingId = generateBookingId;
