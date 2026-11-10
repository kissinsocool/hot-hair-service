const bookingService = require('./booking');
const bookingMessages = require('./booking-messages');
const { bookingEvent, recordAnalyticsEvent } = require('./analytics');

const DAY_MS = 24 * 60 * 60 * 1000;

const completeDueBookings = async ({
  mongoose, Booking, BookingMessage, SlotOccupancy, UserCoupon,
  AnalyticsEvent, broadcastBookingEvent,
}, now = new Date()) => {
  let lastId;
  let processed = 0;

  while (true) {
    const due = await Booking.find({
      status: 'accepted',
      startTime: { $lte: now },
      ...(lastId ? { _id: { $gt: lastId } } : {}),
    }).sort({ _id: 1 }).limit(100).lean();
    if (!due.length) break;

    for (const booking of due) {
      lastId = booking._id;
      const durationMs = Number.isSafeInteger(booking.serviceDurationMinutes) && booking.serviceDurationMinutes > 0
        ? booking.serviceDurationMinutes * 60 * 1000
        : DAY_MS;
      if (now.getTime() - booking.startTime.getTime() < durationMs) continue;

      try {
        const updated = await bookingService.runBookingTransaction(mongoose, async session => {
          let couponRedeemedAt;
          if (booking.couponId && !booking.couponRedeemedAt) {
            const redeemed = await UserCoupon.findOneAndUpdate(
              { id: booking.couponId, reservedBookingId: booking.id, redeemedAt: { $exists: false } },
              {
                $set: {
                  redeemedAt: now,
                  redeemedBookingId: booking.id,
                  redeemedSalonId: booking.salonId,
                },
                $unset: { reservedAt: '', reservedBookingId: '' },
              },
              { new: true, session },
            );
            if (!redeemed) {
              const legacy = await UserCoupon.findOne({
                id: booking.couponId, redeemedBookingId: booking.id,
              }).session(session);
              if (!legacy) throw new Error(`Coupon state is inconsistent for booking ${booking.id}`);
              couponRedeemedAt = legacy.redeemedAt || now;
            } else {
              couponRedeemedAt = redeemed.redeemedAt;
            }
          }

          const completed = await Booking.findOneAndUpdate(
            {
              _id: booking._id,
              status: 'accepted',
              startTime: booking.startTime,
              serviceDurationMinutes: booking.serviceDurationMinutes ?? null,
            },
            { $set: {
              status: 'completed',
              completionSource: 'automatic',
              completedAt: now,
              updatedAt: now,
              merchantMessage: '预约时间已结束，系统已自动完成订单。如实际未到店，请及时更正订单状态。',
              userMessage: '预约时间已结束，系统已自动完成订单。如未到店、服务未完成或订单有问题，请进入订单详情反馈。',
              ...(couponRedeemedAt ? { couponRedeemedAt } : {}),
            } },
            { new: true, session },
          );
          if (!completed) throw bookingService.transactionError(409, 'Booking changed before automatic completion');
          await SlotOccupancy.deleteOne({ bookingId: completed.id }, { session });
          await bookingMessages.appendBookingMessage(BookingMessage, completed, 'complete', session);
          return completed;
        });
        processed += 1;
        broadcastBookingEvent('booking.updated', updated);
        await recordAnalyticsEvent(AnalyticsEvent, bookingEvent('visit_completed', updated))
          .catch(error => console.error('Booking completion analytics failed:', error));
      } catch (error) {
        if (error.httpStatus === 409) continue;
        console.error(`Automatic booking completion failed for ${booking.id}:`, error);
      }
    }
    if (due.length < 100) break;
  }
  return processed;
};

// Pending bookings hold stylist slots until the merchant answers. Release the ones nobody will answer:
// those whose start time has passed, and those left unhandled longer than timeoutMs (0 = no time limit).
// They end as 'rejected' with a system reason, a status and field every released client already renders.
const expirePendingBookings = async ({
  mongoose, Booking, BookingMessage, SlotOccupancy, UserCoupon, broadcastBookingEvent,
}, now = new Date(), { timeoutMs = 0 } = {}) => {
  const overdue = timeoutMs > 0 ? new Date(now.getTime() - timeoutMs) : null;
  let lastId;
  let processed = 0;

  while (true) {
    const stale = await Booking.find({
      status: 'pending',
      $or: [
        { startTime: { $lte: now } },
        ...(overdue ? [{ createdAt: { $lte: overdue } }] : []),
      ],
      ...(lastId ? { _id: { $gt: lastId } } : {}),
    }).sort({ _id: 1 }).limit(100).lean();
    if (!stale.length) break;

    for (const booking of stale) {
      lastId = booking._id;
      const started = booking.startTime.getTime() <= now.getTime();
      const reason = started
        ? '预约时间已到，商家未确认，系统已自动取消'
        : '商家长时间未确认，系统已自动取消';
      try {
        const updated = await bookingService.runBookingTransaction(mongoose, async session => {
          if (booking.couponId) {
            await UserCoupon.updateOne(
              { id: booking.couponId, reservedBookingId: booking.id },
              { $unset: { reservedAt: '', reservedBookingId: '' } },
              { session },
            );
          }
          const expired = await Booking.findOneAndUpdate(
            { _id: booking._id, status: 'pending', startTime: booking.startTime },
            { $set: {
              status: 'rejected',
              updatedAt: now,
              rejectReason: reason,
              merchantMessage: '该预约超时未处理，系统已自动取消。',
              userMessage: `${reason}，请重新选择时间预约。`,
              ...(booking.couponId ? {
                couponId: '',
                couponCode: '',
                couponTitle: '',
                couponDiscountFen: 0,
                payableAmountFen: bookingService.normalizeBookingPayload(booking).originalAmountFen,
                couponRedeemedAt: null,
              } : {}),
            } },
            { new: true, session },
          );
          if (!expired) throw bookingService.transactionError(409, 'Booking changed before pending expiry');
          await SlotOccupancy.deleteOne({ bookingId: expired.id }, { session });
          await bookingMessages.appendBookingMessage(BookingMessage, expired, 'reject', session);
          return expired;
        });
        processed += 1;
        broadcastBookingEvent('booking.updated', updated);
      } catch (error) {
        if (error.httpStatus === 409) continue;
        console.error(`Pending booking expiry failed for ${booking.id}:`, error);
      }
    }
    if (stale.length < 100) break;
  }
  return processed;
};

module.exports = { completeDueBookings, expirePendingBookings };
