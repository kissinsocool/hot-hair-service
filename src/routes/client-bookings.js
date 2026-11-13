const { parseReviewRatings } = require('../services/review-ratings');
const bookingService = require('../services/booking');
const bookingMessages = require('../services/booking-messages');
const { normalizeReviewTags, resolveServiceTagIds } = require('../services/salon');
const { bookingEvent, recordAnalyticsEvent } = require('../services/analytics');
const { maxActiveBookingsPerUser } = require('../config');
const {
  generateBookingId,
  isDuplicateSlotError,
  transactionError,
} = bookingService;

// 与所选时间有关的下单拒绝统一带上这个代码，客户端据此引导用户回到预约页重新选择时间；
// message 是给用户看的中文说明。没有这个代码的旧客户端仍按 409 和 message 处理。
const BOOKING_SLOT_UNAVAILABLE = 'BOOKING_SLOT_UNAVAILABLE';
const slotUnavailable = (res, message) => res.status(409).json({ code: BOOKING_SLOT_UNAVAILABLE, message });

module.exports = (app, ctx) => {
  const {
    mongoose,
    SlotOccupancy,
    Booking,
    BookingMessage,
    UserCoupon,
    Salon,
    crypto,
    normalizeUserId,
    userIdAliases,
    normalizePagination,
    setPaginationHeaders,
    normalizeBooking,
    USER_CANCEL_WINDOW_MS,
    broadcastBookingEvent,
    verifyModeratedImageObjects,
    deleteModeratedImages,
    getStaffById,
    getSalonByStaffId,
    getUserPolicy,
    parseOpeningHours,
    findActiveBookingAtTime,
    isSalonClosedOnDate,
    isSameDayBookingBlocked,
    isStaffUnavailable,
    clearPublicSalonDetailCache,
    refreshStaffRatingSummaries,
    refreshSalonRatingSummaries,
    couponDiscountForOrder,
    INPUT_LIMITS,
    rateLimits,
    AnalyticsEvent,
    publicImageUrl,
  } = ctx;

  const reserveBookingSlot = (...args) => bookingService.reserveBookingSlot(SlotOccupancy, ...args);
  const runBookingTransaction = work => bookingService.runBookingTransaction(mongoose, work);

  app.get('/api/bookings', async (req, res) => {
    const { staffId, status } = req.query;
    if ([staffId, status].some(value => value !== undefined && typeof value !== 'string')) {
      return res.status(400).json({ message: 'staffId and status must be strings' });
    }
    const userId = normalizeUserId(req.clientUser.id);
    const query = { userId: { $in: userIdAliases(userId) } };
    if (staffId) query.staffId = staffId;
    if (status) query.status = status;
    const pagination = normalizePagination(req.query);
    const [result, total] = await Promise.all([
      Booking.find(query).select('-_id -__v').sort({ createdAt: -1 }).skip(pagination.skip).limit(pagination.limit).lean(),
      Booking.countDocuments(query),
    ]);
    const salonIds = [...new Set(result.map(booking => booking.salonId).filter(Boolean))];
    const salons = salonIds.length
      ? await Salon.find({ id: { $in: salonIds } }).select('id description image images services.id services.note').lean()
      : [];
    const salonsById = new Map(salons.map(salon => [salon.id, salon]));
    setPaginationHeaders(res, pagination, total);
    res.json(result.map(booking => {
      const salon = salonsById.get(booking.salonId);
      const service = salon?.services?.find(service => service.id === booking.serviceId);
      return {
        ...normalizeBooking(booking),
        salonImageUrl: publicImageUrl(salon?.image || salon?.images?.[0] || ''),
        salonDescription: salon?.description || '',
        serviceDescription: service?.note || '',
      };
    }));
  });

  app.get('/api/bookings/:id', async (req, res) => {
    const userId = normalizeUserId(req.clientUser.id);
    const booking = await Booking.findOne({
      id: req.params.id,
      userId: { $in: userIdAliases(userId) },
    }).select('-_id -__v').lean();
    if (!booking) return res.status(404).json({ message: 'Booking not found' });

    res.json(normalizeBooking(booking));
  });
  
  app.patch('/api/bookings/:id/cancel', ...rateLimits.booking, async (req, res) => {
    const userId = normalizeUserId(req.clientUser.id);
    let booking;
    try {
      booking = await runBookingTransaction(async (session) => {
        const ownerFilter = { id: req.params.id, userId: { $in: userIdAliases(userId) } };
        const current = await Booking.findOne(ownerFilter).session(session);
        if (!current) throw transactionError(404, 'Booking not found');
        if (!['pending', 'accepted'].includes(current.status)) {
          throw transactionError(409, 'Only pending or accepted bookings can be canceled by user');
        }
        if (
          current.status === 'accepted' &&
          new Date(current.startTime).getTime() - Date.now() < USER_CANCEL_WINDOW_MS
        ) {
          throw transactionError(409, '预约开始前3小时内不能直接取消，请电话联系商家协商取消。直接爽约3次账号将被拉黑。');
        }

        const couponReset = current.couponId ? {
          couponId: '',
          couponCode: '',
          couponTitle: '',
          couponDiscountFen: 0,
          payableAmountFen: bookingService.normalizeBookingPayload(current).originalAmountFen,
          couponRedeemedAt: null,
        } : {};
        if (current.couponId) {
          await UserCoupon.updateOne(
            {
              id: current.couponId,
              $or: [
                { reservedBookingId: current.id },
                { redeemedBookingId: current.id },
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
        }
        const updated = await Booking.findOneAndUpdate(
          { ...ownerFilter, status: current.status },
          { $set: {
            status: 'canceled',
            updatedAt: new Date(),
            merchantMessage: '用户已取消该预约。',
            userMessage: '您已取消本次预约。',
            rejectReason: '',
            canceledBy: 'user',
            ...couponReset,
          } },
          { new: true, session },
        );
        if (!updated) throw transactionError(409, '订单状态已变更，请刷新后重试');
        await SlotOccupancy.deleteOne({ bookingId: updated.id }, { session });
        await bookingMessages.appendBookingMessage(BookingMessage, updated, 'canceled', session);
        return updated;
      });
    } catch (error) {
      if (error.httpStatus) return res.status(error.httpStatus).json({ message: error.message });
      throw error;
    }
    broadcastBookingEvent('booking.updated', booking);
  
    res.json({
      message: 'Booking canceled.',
      booking: normalizeBooking(booking),
    });
  });
  
  app.post('/api/bookings/:id/review', ...rateLimits.booking, async (req, res) => {
    const booking = await Booking.findOne({ id: req.params.id });
    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    const userId = normalizeUserId(req.clientUser.id);
    if (!userIdAliases(userId).includes(normalizeUserId(booking.userId))) {
      return res.status(403).json({ message: 'Cannot review another user booking' });
    }
    if (booking.status !== 'completed') {
      return res.status(409).json({ message: 'Only completed bookings can be reviewed' });
    }
    if (booking.reviewed) {
      return res.status(409).json({ message: 'Booking already reviewed' });
    }
  
    const { rating, ratings, error: ratingsError } = parseReviewRatings(req.body);
    const comment = String(req.body.comment || '').trim();
    const tags = normalizeReviewTags(req.body.tags);
    const imageObjects = Array.isArray(req.body.imageObjects) ? req.body.imageObjects : [];
    if (Array.isArray(req.body.images) && req.body.images.length) {
      return res.status(400).json({ message: '请升级客户端后重新上传图片' });
    }
  
    if (ratingsError) return res.status(400).json({ message: ratingsError });
    if (!comment) {
      return res.status(400).json({ message: 'comment is required' });
    }
    if (comment.length > INPUT_LIMITS.review) {
      return res.status(400).json({ message: `comment cannot exceed ${INPUT_LIMITS.review} characters` });
    }
    if (req.body.tags !== undefined && (!Array.isArray(req.body.tags) || tags.length !== req.body.tags.length)) {
      return res.status(400).json({ message: 'tags contain unsupported or duplicate values' });
    }
  
    let imageUrls;
    try {
      imageUrls = await verifyModeratedImageObjects({ type: 'review', userId, objectNames: imageObjects });
    } catch (error) {
      return res.status(error.httpStatus || 500).json({ message: error.message });
    }
  
    const review = {
      id: 'RV' + Date.now(),
      bookingId: booking.id,
      userName: booking.userName,
      user: booking.userName,
      rating,
      ratings,
      comment,
      tags,
      date: new Date().toISOString().slice(0, 10),
      createdAt: new Date().toISOString(),
      serviceName: booking.serviceName,
      imageUrls,
      reviewStatus: 'pending',
    };
  
    const staffMember = await getStaffById(booking.staffId);
    if (!staffMember) return res.status(404).json({ message: 'Staff not found' });
  
    const updatedBooking = await Booking.findOneAndUpdate(
      { _id: booking._id, status: 'completed', reviewed: { $ne: true } },
      { $set: { reviewed: true, review, updatedAt: new Date() } },
      { new: true },
    );
    if (!updatedBooking) {
      await deleteModeratedImages(imageUrls);
      return res.status(409).json({ message: 'Booking already reviewed' });
    }
  
    broadcastBookingEvent('booking.updated', updatedBooking);
    await recordAnalyticsEvent(AnalyticsEvent, bookingEvent('review_submitted', updatedBooking))
      .catch(error => console.error('Review analytics failed:', error.message));
    res.status(201).json({ review, booking: normalizeBooking(updatedBooking) });
  });

  app.patch('/api/bookings/:id/review', ...rateLimits.booking, async (req, res) => {
    const booking = await Booking.findOne({ id: req.params.id });
    if (!booking?.review) return res.status(404).json({ message: 'Review not found' });
    const userId = normalizeUserId(req.clientUser.id);
    if (!userIdAliases(userId).includes(normalizeUserId(booking.userId))) {
      return res.status(403).json({ message: 'Cannot edit another user review' });
    }
    if (booking.review.reviewStatus === 'pending' || booking.review.pendingEdit?.reviewStatus === 'pending') {
      return res.status(409).json({ message: '评价正在审核中，请等待审核完成后再修改' });
    }

    const { rating, ratings, error: ratingsError } = parseReviewRatings(req.body);
    const comment = String(req.body.comment || '').trim();
    const requestedTags = req.body.tags;
    const normalizedTags = normalizeReviewTags(requestedTags);
    const retainedImageUrls = Array.isArray(req.body.retainedImageUrls)
      ? req.body.retainedImageUrls.map(String)
      : [];
    const imageObjects = Array.isArray(req.body.imageObjects) ? req.body.imageObjects : [];
    if (ratingsError) return res.status(400).json({ message: ratingsError });
    if (!comment) return res.status(400).json({ message: 'comment is required' });
    if (comment.length > INPUT_LIMITS.review) {
      return res.status(400).json({ message: `comment cannot exceed ${INPUT_LIMITS.review} characters` });
    }
    if (requestedTags !== undefined && (!Array.isArray(requestedTags) || normalizedTags.length !== requestedTags.length)) {
      return res.status(400).json({ message: 'tags contain unsupported or duplicate values' });
    }

    const previousReview = booking.review.toObject
      ? booking.review.toObject()
      : { ...booking.review };
    const previousPendingEdit = previousReview.pendingEdit;
    delete previousReview.pendingEdit;
    const previousImages = Array.isArray(previousReview.imageUrls) ? previousReview.imageUrls : [];
    if (
      new Set(retainedImageUrls).size !== retainedImageUrls.length
      || retainedImageUrls.some(url => !previousImages.includes(url))
      || retainedImageUrls.length + imageObjects.length > 5
    ) {
      return res.status(400).json({ message: 'Invalid retained review images' });
    }

    let uploadedImages;
    try {
      uploadedImages = await verifyModeratedImageObjects({ type: 'review', userId, objectNames: imageObjects });
    } catch (error) {
      return res.status(error.httpStatus || 500).json({ message: error.message });
    }

    const now = new Date().toISOString();
    const pendingEdit = {
      ...previousReview,
      rating,
      ratings,
      comment,
      tags: requestedTags === undefined ? previousReview.tags || [] : normalizedTags,
      date: now.slice(0, 10),
      updatedAt: now,
      imageUrls: [...retainedImageUrls, ...uploadedImages],
      reviewStatus: 'pending',
    };
    delete pendingEdit.merchantReply;
    delete pendingEdit.pendingMerchantReply;

    const updatedBooking = await Booking.findOneAndUpdate(
      { _id: booking._id, 'review.id': previousReview.id },
      { $set: { reviewed: true, 'review.pendingEdit': pendingEdit, updatedAt: new Date() } },
      { new: true },
    );
    if (!updatedBooking) {
      await deleteModeratedImages(uploadedImages);
      return res.status(409).json({ message: 'Review has changed, please refresh and try again' });
    }

    res.json({ review: previousReview, editStatus: 'pending' });
    Promise.allSettled([
      deleteModeratedImages(previousPendingEdit?.imageUrls || []),
    ]).then(results => logReviewCleanupFailures('edit', booking.id, results));
    try {
      broadcastBookingEvent('booking.updated', updatedBooking);
    } catch (error) {
      console.error(`Review edit broadcast failed for ${booking.id}:`, error.message);
    }
  });

  app.delete('/api/bookings/:id/review', ...rateLimits.booking, async (req, res) => {
    const booking = await Booking.findOne({ id: req.params.id });
    if (!booking?.review) return res.status(404).json({ message: 'Review not found' });
    const userId = normalizeUserId(req.clientUser.id);
    if (!userIdAliases(userId).includes(normalizeUserId(booking.userId))) {
      return res.status(403).json({ message: 'Cannot delete another user review' });
    }

    const review = booking.review.toObject
      ? booking.review.toObject()
      : { ...booking.review };
    const updatedBooking = await Booking.findOneAndUpdate(
      { _id: booking._id, 'review.id': review.id },
      { $unset: { review: '' }, $set: { reviewed: false, updatedAt: new Date() } },
      { new: true },
    );
    if (!updatedBooking) {
      return res.status(409).json({ message: 'Review has changed, please refresh and try again' });
    }

    // Refresh before responding so the next read shows the stylist's and the salon's rating without this review.
    for (const refresh of [
      () => refreshStaffRatingSummaries([booking.staffId]),
      () => refreshSalonRatingSummaries([booking.salonId]),
    ]) {
      try {
        await refresh();
      } catch (error) {
        console.error(`Rating refresh failed after review delete for ${booking.id}:`, error.message);
      }
    }
    clearPublicSalonDetailCache?.();
    res.json({ ok: true });
    Promise.allSettled([
      deleteModeratedImages([
        ...(review.imageUrls || []),
        ...(review.pendingEdit?.imageUrls || []),
      ]),
    ]).then(results => logReviewCleanupFailures('delete', booking.id, results));
    try {
      broadcastBookingEvent('booking.updated', updatedBooking);
    } catch (error) {
      console.error(`Review delete broadcast failed for ${booking.id}:`, error.message);
    }
  });
  
  app.post('/api/bookings/:id/complaint', ...rateLimits.booking, async (req, res) => {
    const booking = await Booking.findOne({ id: req.params.id });
    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    const userId = normalizeUserId(req.clientUser.id);
    if (!userIdAliases(userId).includes(normalizeUserId(booking.userId))) {
      return res.status(403).json({ message: 'Cannot complain another user booking' });
    }
    const noShowDispute = booking.status === 'no_show';
    if (booking.status !== 'completed' && !noShowDispute) {
      return res.status(409).json({ message: '仅已完成或被标记为未到店的订单可反馈' });
    }
    if (booking.complained || booking.complaint?.status === 'handled' || (noShowDispute && booking.complaint)) {
      return res.status(409).json({ message: 'Booking already complained' });
    }
  
    const description = String(req.body.description || '').trim();
    const reason = req.body.reason === undefined ? 'other' : req.body.reason;
    const allowedReasons = noShowDispute ? ['no_show_dispute'] : ['not_arrived', 'service_incomplete', 'other'];
    if (!allowedReasons.includes(reason)) {
      return res.status(400).json({ message: '请选择有效的问题类型' });
    }
    const imageObjects = Array.isArray(req.body.imageObjects) ? req.body.imageObjects : [];
    if (Array.isArray(req.body.images) && req.body.images.length) {
      return res.status(400).json({ message: '请升级客户端后重新上传图片' });
    }
  
    if (!description) {
      return res.status(400).json({ message: 'description is required' });
    }
    if (description.length > INPUT_LIMITS.complaint) {
      return res.status(400).json({ message: `description cannot exceed ${INPUT_LIMITS.complaint} characters` });
    }
  
    let imageUrls;
    try {
      imageUrls = await verifyModeratedImageObjects({ type: 'complaint', userId, objectNames: imageObjects });
    } catch (error) {
      return res.status(error.httpStatus || 500).json({ message: error.message });
    }
  
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
      reason,
      imageUrls,
      reviewStatus: 'pending',
      date: new Date().toISOString().slice(0, 10),
      createdAt: new Date().toISOString(),
      status: 'submitted',
    };
  
    const updatedBooking = await Booking.findOneAndUpdate(
      {
        _id: booking._id,
        status: booking.status,
        complained: { $ne: true },
        ...(noShowDispute ? { complaint: null } : { 'complaint.status': { $ne: 'handled' } }),
      },
      { $set: { complained: true, complaint, ...(!noShowDispute ? { updatedAt: new Date() } : {}) } },
      { new: true },
    );
    if (!updatedBooking) {
      if (imageUrls.length) {
        const current = await Booking.findById(booking._id).select('complaint.imageUrls').lean();
        const savedImages = new Set(current?.complaint?.imageUrls || []);
        await deleteModeratedImages(imageUrls.filter(url => !savedImages.has(url)));
      }
      return res.status(409).json({ message: 'Booking already complained' });
    }
  
    broadcastBookingEvent('booking.updated', updatedBooking);
    res.status(201).json({ complaint, booking: normalizeBooking(updatedBooking) });
  });
  
  app.post('/api/bookings', ...rateLimits.booking, async (req, res) => {
    const {
      staffId,
      salonId = '',
      serviceId,
      startTime,
      note = '',
      couponId = '',
    } = req.body;
    const userId = normalizeUserId(req.clientUser.id);
    const userName = req.clientUser.displayName || req.clientUser.account;
    const bookingServiceId = String(serviceId || '').trim();
  
    if (!staffId || !bookingServiceId || !startTime) {
      return res.status(400).json({ message: 'staffId, serviceId and startTime are required' });
    }
    if (typeof note !== 'string' || note.length > INPUT_LIMITS.note) {
      return res.status(400).json({ message: `note cannot exceed ${INPUT_LIMITS.note} characters` });
    }
  
    const hasExpectedPrice = req.body.expectedOriginalAmountFen !== undefined
      || req.body.expectedPayableAmountFen !== undefined;
    if (hasExpectedPrice && ['expectedOriginalAmountFen', 'expectedPayableAmountFen'].some(
      key => !Number.isSafeInteger(req.body[key]) || req.body[key] < 0,
    )) return res.status(400).json({ message: 'Expected booking amounts must be non-negative integer fen' });

    const requestedStartTime = bookingService.parseBookingTime(startTime);
    if (!requestedStartTime) {
      return res.status(400).json({ message: 'startTime must be a valid date time' });
    }
    if (!bookingService.isHalfHourStart(requestedStartTime)) {
      return res.status(400).json({ message: 'startTime must use a 30-minute interval' });
    }
    if (requestedStartTime.getTime() <= Date.now()) {
      return slotUnavailable(res, '该时间已过，请重新选择预约时间');
    }
  
    const isNoPreference = staffId === '__no_preference__';
    const bookingStaffId = isNoPreference ? '' : String(staffId).trim();
    if (isNoPreference && !String(salonId).trim()) {
      return res.status(400).json({ message: 'salonId is required when staff is not specified' });
    }
  
    const staffMember = isNoPreference ? null : await getStaffById(bookingStaffId).lean();
    const salon = isNoPreference
      ? await Salon.findOne({ id: String(salonId).trim() }).lean()
      : await getSalonByStaffId(bookingStaffId).lean();
    const service = salon?.services?.find(item => String(item.id).trim() === bookingServiceId);
  
    if ((!isNoPreference && !staffMember) || !service || !salon) {
      return res.status(404).json({ message: 'Staff, service or salon not found' });
    }
    if ((service.staffSelectionRestricted === true || service.staffSelectionDisabled === true) && !isNoPreference
      && !(service.selectableStaffIds || []).includes(bookingStaffId)) {
      return res.status(409).json({ message: '该理发师不可指定此套餐，请重新选择' });
    }
    if (salon.publishStatus !== 'online') {
      return res.status(409).json({ message: '该店铺已下架，暂不可预约' });
    }
    if (isSalonClosedOnDate(salon, startTime)) {
      return slotUnavailable(res, '该日期为店铺休息日');
    }
    if (isSameDayBookingBlocked(salon, startTime)) {
      return slotUnavailable(res, '该店铺不接受当天预约');
    }
    if (isNoPreference && !(salon.staffIds || []).length) {
      return res.status(409).json({ message: 'This salon has no staff available for assignment' });
    }
    const { start: openingStart, end: openingEnd } = parseOpeningHours(salon.openingHours);
    const requestedMinutes = bookingService.localTimeMinutes(requestedStartTime);
    if (requestedMinutes < openingStart || requestedMinutes > openingEnd) {
      return slotUnavailable(res, '该时间不在店铺营业时间内，请重新选择');
    }
  
    if (!isNoPreference) {
      const hasConflict = await findActiveBookingAtTime(bookingStaffId, requestedStartTime);
      if (hasConflict) {
        return slotUnavailable(res, '该时间段已被预约，请重新选择');
      }
      if (await isStaffUnavailable(bookingStaffId, startTime, service.durationMinutes)) {
        return slotUnavailable(res, '该理发师在所选时间不可预约，请重新选择');
      }
    }
  
    const now = new Date().toISOString();
    const servicePriceFen = service.priceFen;
    const serviceDurationMinutes = service.durationMinutes;
    // Color, perm and care packages include the stylist's service fee.
    const isPackagePricedService = resolveServiceTagIds(service)
      .some(id => ['color', 'perm', 'scalp_care', 'care', 'nutrition'].includes(id));
    const staffExtraServiceFeeFen = isNoPreference || isPackagePricedService
      ? 0
      : staffMember.extraServiceFeeFen;
    const originalAmountFen = servicePriceFen + staffExtraServiceFeeFen;
    const priceChangedError = couponDiscountFen => Object.assign(
      transactionError(409, '套餐价格或优惠已更新，请确认新金额后重新提交'),
      { code: 'BOOKING_PRICE_CHANGED', quote: {
        servicePriceFen, extraServiceFeeFen: staffExtraServiceFeeFen,
        originalAmountFen, couponDiscountFen, payableAmountFen: originalAmountFen - couponDiscountFen,
      } },
    );
    let bookingId = '';
    for (let attempts = 0; attempts < 10 && !bookingId; attempts += 1) {
      const candidate = generateBookingId(crypto.randomInt);
      if (!await Booking.exists({ id: candidate })) bookingId = candidate;
    }
    if (!bookingId) {
      return res.status(503).json({ message: '订单号生成失败，请重试' });
    }
    let booking;
    try {
      booking = await runBookingTransaction(async (session) => {
        // Writing the salon serializes booking creation with an admin unpublish.
        const onlineSalon = await Salon.updateOne(
          { id: salon.id, publishStatus: 'online' },
          { $inc: { bookingCreationFence: 1 } },
          { session, timestamps: false },
        );
        if (!onlineSalon.matchedCount) throw transactionError(409, '该店铺已下架，暂不可预约');
        const userPolicy = await getUserPolicy(userId, session);
        if (userPolicy.isBlacklisted) {
          throw transactionError(403, '该账号已因爽约次数过多被拉黑，无法继续预约。');
        }
        // getUserPolicy wrote this client's fence above, so parallel submissions cannot both pass this count.
        const activeBookings = await Booking.countDocuments({
          userId: { $in: userIdAliases(userId) },
          status: { $in: ['pending', 'accepted'] },
        }).session(session);
        if (activeBookings >= maxActiveBookingsPerUser) {
          throw transactionError(
            409,
            `您已有${activeBookings}个进行中的预约，最多同时保留${maxActiveBookingsPerUser}个，请先完成或取消后再预约`,
          );
        }
        if (!isNoPreference) {
          try {
            await reserveBookingSlot(bookingId, bookingStaffId, requestedStartTime, serviceDurationMinutes, session);
          } catch (error) {
            if (!isDuplicateSlotError(error)) throw error;
            throw Object.assign(transactionError(409, '该时间段刚刚被其他用户预约，请重新选择'), {
              code: BOOKING_SLOT_UNAVAILABLE,
            });
          }
        }
        let reservedCoupon = null;
        let couponDiscountFen = 0;
        const requestedCouponId = String(couponId || '').trim();
        if (requestedCouponId) {
          const couponNow = new Date();
          reservedCoupon = await UserCoupon.findOneAndUpdate(
            {
              id: requestedCouponId,
              userId: { $in: userIdAliases(userId) },
              claimedAt: { $exists: true },
              redeemedAt: { $exists: false },
              validFrom: { $lte: couponNow },
              validUntil: { $gt: couponNow },
              $or: [
                { reservedBookingId: { $exists: false } },
                { reservedBookingId: '' },
              ],
            },
            {
              $set: {
                reservedAt: couponNow,
                reservedBookingId: bookingId,
              },
            },
            { new: true, session },
          );
          if (!reservedCoupon) {
            throw transactionError(409, '优惠券无效、已被占用或不可使用');
          }
          couponDiscountFen = couponDiscountForOrder(originalAmountFen, reservedCoupon);
          if (couponDiscountFen === null) {
            if (hasExpectedPrice && req.body.expectedOriginalAmountFen !== originalAmountFen) {
              throw priceChangedError(0);
            }
            throw transactionError(
              409,
              `订单金额未满${(reservedCoupon.minimumSpendFen / 100).toFixed(0)}元`,
            );
          }
        }
        const payableAmountFen = originalAmountFen - couponDiscountFen;
        if (hasExpectedPrice && (
          req.body.expectedOriginalAmountFen !== originalAmountFen
          || req.body.expectedPayableAmountFen !== payableAmountFen
        )) {
          throw priceChangedError(couponDiscountFen);
        }
        const created = new Booking({
          id: bookingId,
          userId,
          userName,
          salonId: salon.id,
          salonName: salon.name,
          staffId: bookingStaffId,
          staffName: isNoPreference ? '无需指定' : staffMember.name,
          isNoPreference,
          serviceId: bookingServiceId,
          serviceName: service.name,
          servicePriceFen,
          serviceDurationMinutes,
          staffExtraServiceFeeFen,
          originalAmountFen,
          couponId: reservedCoupon?.id || '',
          couponCode: reservedCoupon?.code || '',
          couponTitle: reservedCoupon?.title || '',
          couponDiscountFen,
          payableAmountFen: originalAmountFen - couponDiscountFen,
          startTime: requestedStartTime,
          timeZone: bookingService.businessTimeZone,
          note,
          status: 'pending',
          merchantMessage: '您有一条新的预约申请，请及时处理。',
          userMessage: '预约申请已提交，正在等待商家确认。',
          createdAt: now,
          updatedAt: now,
        });
        await created.save({ session });
        await bookingMessages.appendBookingMessage(BookingMessage, created, 'created', session);
        return created;
      });
    } catch (error) {
      if (error.code === BOOKING_SLOT_UNAVAILABLE) return slotUnavailable(res, error.message);
      if (error.httpStatus) return res.status(error.httpStatus).json({
        message: error.message,
        ...(error.code === 'BOOKING_PRICE_CHANGED' ? { code: error.code, quote: error.quote } : {}),
      });
      throw error;
    }
  
    broadcastBookingEvent('booking.created', booking);
    await recordAnalyticsEvent(AnalyticsEvent, bookingEvent('booking_submitted', booking))
      .catch(error => console.error('Booking analytics failed:', error.message));
    res.status(201).json({
      message: 'Booking request submitted and waiting for merchant confirmation.',
      booking: normalizeBooking(booking),
    });
  });

};

function logReviewCleanupFailures(action, bookingId, results) {
  for (const result of results) {
    if (result.status === 'rejected') {
      console.error(
        `Review ${action} cleanup failed for ${bookingId}:`,
        result.reason?.message || result.reason,
      );
    }
  }
}
