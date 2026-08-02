const bookingService = require('../services/booking');
const {
  generateBookingId,
  isDuplicateSlotError,
  transactionError,
} = bookingService;

module.exports = (app, ctx) => {
  const {
    mongoose,
    SlotOccupancy,
    Booking,
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
    couponDiscountForOrder,
    INPUT_LIMITS,
    rateLimits,
  } = ctx;

  const reserveBookingSlot = (...args) => bookingService.reserveBookingSlot(SlotOccupancy, ...args);
  const runBookingTransaction = work => bookingService.runBookingTransaction(mongoose, work);

  app.get('/api/bookings', async (req, res) => {
    const { staffId, status } = req.query;
    const userId = normalizeUserId(req.clientUser.id);
    const query = { userId: { $in: userIdAliases(userId) } };
    if (staffId) query.staffId = staffId;
    if (status) query.status = status;
    const pagination = normalizePagination(req.query);
    const [result, total] = await Promise.all([
      Booking.find(query).select('-_id -__v').sort({ createdAt: -1 }).skip(pagination.skip).limit(pagination.limit).lean(),
      Booking.countDocuments(query),
    ]);
    setPaginationHeaders(res, pagination, total);
    res.json(result.map(normalizeBooking));
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
  
    const rating = Number(req.body.rating);
    const comment = String(req.body.comment || '').trim();
    const imageObjects = Array.isArray(req.body.imageObjects) ? req.body.imageObjects : [];
    if (Array.isArray(req.body.images) && req.body.images.length) {
      return res.status(400).json({ message: '请升级客户端后重新上传图片' });
    }
  
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ message: 'rating must be an integer from 1 to 5' });
    }
    if (!comment) {
      return res.status(400).json({ message: 'comment is required' });
    }
    if (comment.length > INPUT_LIMITS.review) {
      return res.status(400).json({ message: `comment cannot exceed ${INPUT_LIMITS.review} characters` });
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
      comment,
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

    const rating = Number(req.body.rating);
    const comment = String(req.body.comment || '').trim();
    const retainedImageUrls = Array.isArray(req.body.retainedImageUrls)
      ? req.body.retainedImageUrls.map(String)
      : [];
    const imageObjects = Array.isArray(req.body.imageObjects) ? req.body.imageObjects : [];
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ message: 'rating must be an integer from 1 to 5' });
    }
    if (!comment) return res.status(400).json({ message: 'comment is required' });
    if (comment.length > INPUT_LIMITS.review) {
      return res.status(400).json({ message: `comment cannot exceed ${INPUT_LIMITS.review} characters` });
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
      comment,
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
    if (booking.status !== 'completed') {
      return res.status(409).json({ message: 'Only completed bookings can be complained' });
    }
    if (booking.complained) {
      return res.status(409).json({ message: 'Booking already complained' });
    }
  
    const description = String(req.body.description || '').trim();
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
      imageUrls,
      reviewStatus: 'pending',
      date: new Date().toISOString().slice(0, 10),
      createdAt: new Date().toISOString(),
      status: 'submitted',
    };
  
    const updatedBooking = await Booking.findOneAndUpdate(
      { _id: booking._id, status: 'completed', complained: { $ne: true } },
      { $set: { complained: true, complaint, updatedAt: new Date() } },
      { new: true },
    );
    if (!updatedBooking) {
      await deleteModeratedImages(imageUrls);
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
  
    const requestedStartTime = bookingService.parseBookingTime(startTime);
    if (!requestedStartTime) {
      return res.status(400).json({ message: 'startTime must be a valid date time' });
    }
    if (requestedStartTime.getTime() <= Date.now()) {
      return res.status(409).json({ message: 'Only future time slots can be booked' });
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
    if (isSalonClosedOnDate(salon, startTime)) {
      return res.status(409).json({ message: '该日期为店铺休息日' });
    }
    if (isSameDayBookingBlocked(salon, startTime)) {
      return res.status(409).json({ message: '该店铺不接受当天预约' });
    }
    if (isNoPreference && !(salon.staffIds || []).length) {
      return res.status(409).json({ message: 'This salon has no staff available for assignment' });
    }
    const { start: openingStart, end: openingEnd } = parseOpeningHours(salon.openingHours);
    const requestedMinutes = bookingService.localTimeMinutes(requestedStartTime);
    if (requestedMinutes < openingStart || requestedMinutes > openingEnd) {
      return res.status(409).json({ message: 'This time is outside salon opening hours' });
    }
  
    if (!isNoPreference) {
      const hasConflict = await findActiveBookingAtTime(bookingStaffId, requestedStartTime);
      if (hasConflict) {
        return res.status(409).json({ message: 'This slot already has a pending or accepted booking' });
      }
      if (await isStaffUnavailable(bookingStaffId, startTime)) {
        return res.status(409).json({ message: 'This staff member is unavailable at the selected time' });
      }
    }
  
    const now = new Date().toISOString();
    const servicePriceFen = Number.isSafeInteger(service.priceFen)
      ? service.priceFen
      : bookingService.priceFen(String(service.price || 0));
    const serviceDurationMinutes = Number.isSafeInteger(service.durationMinutes)
      ? service.durationMinutes
      : bookingService.durationMinutes(service.duration);
    const staffExtraServiceFeeFen = isNoPreference
      ? 0
      : Number.isSafeInteger(staffMember.extraServiceFeeFen)
        ? staffMember.extraServiceFeeFen
        : bookingService.priceFen(String(staffMember.extraServiceFee || 0));
    const originalAmountFen = servicePriceFen + staffExtraServiceFeeFen;
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
        const userPolicy = await getUserPolicy(userId, session);
        if (userPolicy.isBlacklisted) {
          throw transactionError(403, '该账号已因爽约次数过多被拉黑，无法继续预约。');
        }
        if (!isNoPreference) {
          await reserveBookingSlot(bookingId, bookingStaffId, requestedStartTime, session);
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
            throw transactionError(
              409,
              `订单金额未满${(reservedCoupon.minimumSpendFen / 100).toFixed(0)}元`,
            );
          }
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
        return created;
      });
    } catch (error) {
      if (error.httpStatus) return res.status(error.httpStatus).json({ message: error.message });
      if (isDuplicateSlotError(error)) {
        return res.status(409).json({ message: 'This time slot was just booked by another user' });
      }
      throw error;
    }
  
    broadcastBookingEvent('booking.created', booking);
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
