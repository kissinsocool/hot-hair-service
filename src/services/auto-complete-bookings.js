const bookingService = require('./booking');
const bookingMessages = require('./booking-messages');
const { bookingEvent, recordAnalyticsEvent } = require('./analytics');

const DAY_MS = 24 * 60 * 60 * 1000;

const completeDueBookings = async ({
  mongoose, Booking, BookingMessage, SlotOccupancy, UserCoupon,
  AnalyticsEvent, broadcastBookingEvent,
}, now = new Date()) => {
  const cutoff = new Date(now.getTime() - DAY_MS);
  let lastId;
  let processed = 0;

  while (true) {
    const due = await Booking.find({
      status: 'accepted',
      startTime: { $lte: cutoff },
      ...(lastId ? { _id: { $gt: lastId } } : {}),
    }).sort({ _id: 1 }).limit(100).lean();
    if (!due.length) break;

    for (const booking of due) {
      lastId = booking._id;
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
            { _id: booking._id, status: 'accepted', startTime: { $lte: cutoff } },
            { $set: {
              status: 'completed',
              updatedAt: now,
              merchantMessage: '订单已完成。',
              userMessage: '本次预约已完成，感谢到店。',
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

module.exports = { completeDueBookings };
