// 把新用户注册活动当前的满减规则同步到已经发出的优惠券上。
// 默认只预览（dry run），加 --apply 才真正写库。
//   npm run coupons:sync-rules            预览
//   npm run coupons:sync-rules -- --apply 写库
//
// 只更新"未使用、未被订单占用、未过期"的券；已核销的券保持原样（账目要对得上），
// 已被待支付/待服务订单占用的券也不动（订单里已按旧规则锁定了优惠金额）。
const path = require('path');
if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
}
const mongoose = require('mongoose');
const { CouponCampaign, UserCoupon } = require('../src/models');
const { CAMPAIGN_KEY, validateCampaignInput } = require('../src/coupons');

const RULE_FIELDS = ['minimumSpendFen', 'discountFen', 'title', 'description'];

// 用表达式保留历史空字符串，避免 Mongoose 把 Date 查询中的 '' 转成 null。
const emptyRedemption = { $expr: { $in: [{ $ifNull: ['$redeemedAt', null] }, ['', null]] } };

const syncableFilter = (couponType, now) => ({
  campaignKey: CAMPAIGN_KEY,
  couponType,
  ...emptyRedemption,
  reservedBookingId: { $in: ['', null] },
  validUntil: { $gt: now },
});

const outdatedFilter = template => ({
  $or: RULE_FIELDS.map(field => ({ [field]: { $ne: template[field] ?? '' } })),
});

const campaignTemplates = campaign => {
  if (!campaign) throw new Error('未找到活动配置');
  const { value, error } = validateCampaignInput(campaign);
  if (error) throw new Error(`活动配置无效: ${error}`);
  return value.coupons;
};

const sync = async ({ apply = false, now = new Date() } = {}) => {
  const campaign = await CouponCampaign.findOne({ key: CAMPAIGN_KEY }).lean();
  const templates = campaignTemplates(campaign);

  const report = [];
  for (const template of templates) {
    const base = syncableFilter(template.key, now);
    const filter = { $and: [base, outdatedFilter(template)] };
    const [toUpdate, claimed, reserved, redeemed] = await Promise.all([
      UserCoupon.countDocuments(filter),
      UserCoupon.countDocuments({ $and: [filter, { $expr: { $not: { $in: [{ $ifNull: ['$claimedAt', null] }, ['', null]] } } }] }),
      UserCoupon.countDocuments({ campaignKey: CAMPAIGN_KEY, couponType: template.key, reservedBookingId: { $nin: ['', null] }, ...emptyRedemption }),
      UserCoupon.countDocuments({ campaignKey: CAMPAIGN_KEY, couponType: template.key, $nor: [emptyRedemption] }),
    ]);
    const item = {
      couponType: template.key,
      newRule: Object.fromEntries(RULE_FIELDS.map(f => [f, template[f] ?? ''])),
      toUpdate,
      toUpdateAlreadyClaimed: claimed,
      skippedReserved: reserved,
      skippedRedeemed: redeemed,
    };
    if (apply) {
      const result = await UserCoupon.updateMany(filter, { $set: item.newRule });
      item.modified = result.modifiedCount;
    }
    report.push(item);
  }
  return { apply, report };
};

if (require.main === module) {
  const apply = process.argv.includes('--apply');
  const mongoUri = String(process.env.MONGODB_URI || '').trim();
  if (!mongoUri) {
    console.error('MONGODB_URI is missing');
    process.exitCode = 1;
  } else {
    mongoose.connect(mongoUri)
      .then(() => sync({ apply }))
      .then(result => {
        console.log(JSON.stringify(result, null, 2));
        if (!apply) console.log('\n以上为预览，确认无误后加 --apply 执行。');
      })
      .catch(error => {
        console.error('同步失败:', error.message);
        process.exitCode = 1;
      })
      .finally(() => mongoose.disconnect());
  }
}

module.exports = { sync, syncableFilter, outdatedFilter, campaignTemplates };
