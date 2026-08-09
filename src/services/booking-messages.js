const bookingMessagePayload = (booking, type) => ({
  userId: booking.userId,
  bookingId: booking.id,
  type,
  status: booking.status,
  userMessage: booking.userMessage,
  salonId: booking.salonId,
  salonName: booking.salonName,
  staffId: booking.staffId,
  staffName: booking.staffName,
  serviceId: booking.serviceId,
  serviceName: booking.serviceName,
  startTime: booking.startTime,
  couponTitle: booking.couponTitle,
  couponDiscountFen: booking.couponDiscountFen,
  createdAt: booking.updatedAt || new Date(),
});

const appendBookingMessage = async (BookingMessage, booking, type, session) => {
  const [message] = await BookingMessage.create(
    [bookingMessagePayload(booking, type)],
    { session },
  );
  return message;
};

module.exports = {
  appendBookingMessage,
  bookingMessagePayload,
};
