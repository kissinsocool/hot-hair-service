const { wechatBookingStatusTemplateId, wechatMiniprogramState } = require('../config');
const { ClientUser } = require('../models');
const { normalizeUserId, sendWechatSubscribeMessage } = require('./auth');

const text = (value, limit = 20) => String(value || '').trim().slice(0, limit);

const formatBookingTime = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
};

const bookingAcceptedData = booking => ({
  thing1: { value: text(booking?.serviceName || '美发预约') },
  thing8: { value: text(booking?.salonName || '预约门店') },
  phrase11: { value: '预约成功' },
  time10: { value: formatBookingTime(booking?.startTime) },
});

const sendBookingAcceptedNotification = async (booking) => {
  if (!wechatBookingStatusTemplateId || !booking?.userId) return false;
  const user = await ClientUser.findOne({ id: normalizeUserId(booking.userId) })
    .select('wechatOpenId')
    .lean();
  if (!user?.wechatOpenId) return false;
  return sendWechatSubscribeMessage({
    touser: user.wechatOpenId,
    template_id: wechatBookingStatusTemplateId,
    page: 'pages/messages/messages',
    miniprogram_state: wechatMiniprogramState,
    lang: 'zh_CN',
    data: bookingAcceptedData(booking),
  });
};

module.exports = {
  bookingAcceptedData,
  formatBookingTime,
  sendBookingAcceptedNotification,
};
