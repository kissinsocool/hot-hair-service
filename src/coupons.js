const CAMPAIGN_KEY = 'new-user-registration';

const defaultCampaign = () => ({
  key: CAMPAIGN_KEY,
  enabled: false,
  registrationStartAt: null,
  registrationEndAt: null,
  coupons: [
    {
      key: '99-20',
      minimumSpendFen: 9900,
      discountFen: 2000,
      title: '新用户满99减20',
      description: '订单满99元可用',
    },
    {
      key: '199-30',
      minimumSpendFen: 19900,
      discountFen: 3000,
      title: '新用户满199减30',
      description: '订单满199元可用',
    },
  ],
});

const parseDate = value => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const validateCampaignInput = (body = {}) => {
  const registrationStartAt = parseDate(body.registrationStartAt);
  const registrationEndAt = parseDate(body.registrationEndAt);
  if (
    !registrationStartAt
    || !registrationEndAt
    || registrationStartAt >= registrationEndAt
  ) {
    return { error: '请填写有效的活动时间' };
  }
  if (typeof body.enabled !== 'boolean') return { error: '活动开关必须是布尔值' };

  const sourceCoupons = Array.isArray(body.coupons) ? body.coupons : [];
  const expectedKeys = ['99-20', '199-30'];
  if (sourceCoupons.length !== expectedKeys.length) return { error: '活动必须配置两张优惠券' };

  const coupons = [];
  for (const key of expectedKeys) {
    const source = sourceCoupons.find(item => String(item?.key || '') === key);
    const minimumSpendFen = Number(source?.minimumSpendFen);
    const discountFen = Number(source?.discountFen);
    const title = String(source?.title || '').trim();
    const description = String(source?.description || '').trim();
    if (
      !Number.isSafeInteger(minimumSpendFen)
      || !Number.isSafeInteger(discountFen)
      || minimumSpendFen <= 0
      || discountFen <= 0
      || discountFen > minimumSpendFen
    ) {
      return { error: '优惠券门槛和优惠金额必须是有效的整数分' };
    }
    if (!title || title.length > 50 || description.length > 200) {
      return { error: '优惠券标题不能为空且文案不能过长' };
    }
    coupons.push({ key, minimumSpendFen, discountFen, title, description });
  }

  return {
    value: {
      key: CAMPAIGN_KEY,
      enabled: body.enabled,
      registrationStartAt,
      registrationEndAt,
      coupons,
    },
  };
};

const campaignPayload = campaign => {
  const source = campaign?.toObject ? campaign.toObject() : campaign;
  const payload = { ...defaultCampaign(), ...(source || {}), key: CAMPAIGN_KEY };
  delete payload.validFrom;
  delete payload.validUntil;
  return payload;
};

const couponStatus = (coupon, now = new Date()) => {
  if (coupon.redeemedAt) return 'redeemed';
  if (new Date(coupon.validUntil) <= now) return 'expired';
  if (!coupon.claimedAt) return 'unclaimed';
  if (new Date(coupon.validFrom) > now) return 'pending';
  return 'available';
};

const couponPayload = (coupon, now = new Date()) => {
  const source = coupon?.toObject ? coupon.toObject() : coupon;
  return {
    id: source.id,
    couponType: source.couponType,
    minimumSpendFen: source.minimumSpendFen,
    discountFen: source.discountFen,
    title: source.title,
    description: source.description,
    grantedAt: source.grantedAt,
    validFrom: source.validFrom,
    validUntil: source.validUntil,
    claimedAt: source.claimedAt || null,
    code: source.code || '',
    redeemedAt: source.redeemedAt || null,
    redeemedBookingId: source.redeemedBookingId || '',
    status: couponStatus(source, now),
  };
};

const couponDiscountForOrder = (originalAmountFen, coupon) => {
  const amount = Number(originalAmountFen);
  const minimum = Number(coupon?.minimumSpendFen);
  const discount = Number(coupon?.discountFen);
  if (
    !Number.isSafeInteger(amount)
    || !Number.isSafeInteger(minimum)
    || !Number.isSafeInteger(discount)
    || amount < minimum
  ) return null;
  return Math.min(amount, discount);
};

const issueSignupCoupons = async ({
  CouponCampaign,
  UserCoupon,
  crypto,
  userId,
  now = new Date(),
  session,
}) => {
  const campaign = await CouponCampaign.findOne({
    key: CAMPAIGN_KEY,
    enabled: true,
    registrationStartAt: { $lte: now },
    registrationEndAt: { $gt: now },
  }).session(session);
  if (!campaign) return [];

  const coupons = campaign.coupons.map(template => ({
    id: crypto.randomUUID(),
    campaignKey: CAMPAIGN_KEY,
    couponType: template.key,
    userId,
    minimumSpendFen: template.minimumSpendFen,
    discountFen: template.discountFen,
    title: template.title,
    description: template.description,
    grantedAt: now,
    validFrom: campaign.registrationStartAt,
    validUntil: campaign.registrationEndAt,
  }));
  return UserCoupon.create(coupons, { session });
};

module.exports = {
  CAMPAIGN_KEY,
  campaignPayload,
  couponDiscountForOrder,
  couponPayload,
  couponStatus,
  defaultCampaign,
  issueSignupCoupons,
  validateCampaignInput,
};
