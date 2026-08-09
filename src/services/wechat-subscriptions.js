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

const bookingStatusText = status => ({
  accepted: '预约成功',
  rejected: '预约失败',
  canceled: '已取消',
  rescheduled: '已改期',
}[status] || '状态更新');

const bookingStatusData = (booking, status = booking?.status) => ({
  thing1: { value: text(booking?.serviceName || '美发预约') },
  time2: { value: formatBookingTime(booking?.startTime) },
  phrase3: { value: bookingStatusText(status) },
  thing4: { value: text(booking?.salonName || '预约门店') },
  thing5: { value: text(booking?.rejectReason || booking?.userMessage || '请查看预约详情') },
});

const sendBookingStatusNotification = async (booking, status = booking?.status) => {
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
    data: bookingStatusData(booking, status),
  });
};

module.exports = {
  bookingStatusData,
  bookingStatusText,
  formatBookingTime,
  sendBookingStatusNotification,
};
