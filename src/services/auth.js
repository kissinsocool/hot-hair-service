const crypto = require('crypto');
const mongoose = require('mongoose');
const {
  DEMO_USER_ID,
  sessionTtlSeconds,
  wechatAppId,
  wechatAppSecret,
} = require('../config');
const {
  AdminUser,
  ClientUser,
  CouponCampaign,
  MerchantUser,
  UserCoupon,
} = require('../models');
const { issueSignupCoupons } = require('../coupons');
const { publicImageUrl } = require('../images');

const normalizePhone = phone => String(phone || '').replace(/\D/g, '');
const isValidPhone = phone => /^1\d{10}$/.test(phone);
const normalizeUserId = id => String(id || '').trim().replace(/^user-/, '');
const userIdAliases = (id) => {
  const normalized = normalizeUserId(id);
  if (!normalized) return [];
  return normalized === DEMO_USER_ID
    ? [DEMO_USER_ID, 'user-demo', 'demo-user']
    : [normalized, `user-${normalized}`];
};
const maskPhone = phone => phone.length === 11
  ? `${phone.slice(0, 3)}****${phone.slice(7)}`
  : phone;

const buildMerchantUserPayload = user => ({
  id: user.id,
  username: user.username,
  displayName: user.displayName,
  salonId: user.salonId,
  deposit: user.deposit || 0,
  role: user.role,
});
const buildAdminUserPayload = user => ({
  id: user.id,
  username: user.username,
  displayName: user.displayName,
  role: user.role,
});
const buildClientUserPayload = user => ({
  id: normalizeUserId(user.id),
  account: user.account,
  displayName: user.displayName,
  gender: user.gender || '保密',
  avatarUrl: publicImageUrl(user.avatarUrl || ''),
  avatarReviewStatus: user.avatarReviewStatus || 'none',
  avatarRejectReason: user.avatarRejectReason || '',
  phone: user.phone || user.account,
});

const sessionTokenFromRequest = req =>
  String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
const hashSessionToken = token => crypto.createHash('sha256').update(String(token)).digest('hex');
const activeSessionQuery = (token, now = new Date()) => ({
  sessionTokenHash: hashSessionToken(token),
  sessionExpiresAt: { $gt: now },
});
const createSession = (now = Date.now()) => {
  const token = crypto.randomBytes(32).toString('hex');
  return {
    token,
    tokenHash: hashSessionToken(token),
    expiresAt: new Date(now + sessionTtlSeconds * 1000),
  };
};

const fetchJson = async (url, options = {}) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, {
      ...options,
      headers: { 'User-Agent': 'hot-hair-service/1.0', ...options.headers },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
};

let wechatTokenCache = { token: '', expiresAt: 0 };
const getWechatAccessToken = async () => {
  if (wechatTokenCache.token && wechatTokenCache.expiresAt > Date.now()) return wechatTokenCache.token;
  const url = new URL('https://api.weixin.qq.com/cgi-bin/token');
  url.searchParams.set('grant_type', 'client_credential');
  url.searchParams.set('appid', wechatAppId);
  url.searchParams.set('secret', wechatAppSecret);
  const data = await fetchJson(url);
  if (!data?.access_token) throw new Error(data?.errmsg || '获取微信 access_token 失败');
  wechatTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + Math.max(Number(data.expires_in || 7200) - 300, 60) * 1000,
  };
  return wechatTokenCache.token;
};

const getWechatPhoneNumber = async (code) => {
  const accessToken = await getWechatAccessToken();
  const data = await fetchJson(`https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token=${accessToken}`, {
    method: 'POST',
    body: JSON.stringify({ code }),
    headers: { 'content-type': 'application/json' },
  });
  const phone = normalizePhone(data?.phone_info?.phoneNumber);
  if (!isValidPhone(phone)) throw new Error(data?.errmsg || '微信手机号授权失败');
  return phone;
};

const getWechatSessionKey = async (loginCode) => {
  const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
  url.searchParams.set('appid', wechatAppId);
  url.searchParams.set('secret', wechatAppSecret);
  url.searchParams.set('js_code', loginCode);
  url.searchParams.set('grant_type', 'authorization_code');
  const data = await fetchJson(url);
  if (!data?.session_key) throw new Error(data?.errmsg || '微信登录失败');
  return data.session_key;
};

const decryptWechatPhoneNumber = async ({ encryptedData, iv, loginCode }) => {
  if (!encryptedData || !iv || !loginCode) throw new Error('微信手机号授权失败');
  const sessionKey = await getWechatSessionKey(loginCode);
  const decipher = crypto.createDecipheriv(
    'aes-128-cbc',
    Buffer.from(sessionKey, 'base64'),
    Buffer.from(iv, 'base64'),
  );
  decipher.setAutoPadding(true);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedData, 'base64')),
    decipher.final(),
  ]);
  const data = JSON.parse(decrypted.toString('utf8'));
  if (data?.watermark?.appid && data.watermark.appid !== wechatAppId) {
    throw new Error('微信手机号授权失败');
  }
  const phone = normalizePhone(data.phoneNumber || data.purePhoneNumber);
  if (!isValidPhone(phone)) throw new Error('微信手机号授权失败');
  return phone;
};

const createClientUserWithSignupCoupons = async (fields) => {
  const mongoSession = await mongoose.startSession();
  try {
    let user;
    await mongoSession.withTransaction(async () => {
      user = new ClientUser(fields);
      await user.save({ session: mongoSession });
      await issueSignupCoupons({
        CouponCampaign,
        UserCoupon,
        crypto,
        userId: normalizeUserId(user.id),
        session: mongoSession,
      });
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    return user;
  } finally {
    await mongoSession.endSession();
  }
};

const createAuthService = ({ revokeSessionHash = async () => {} } = {}) => {
  const rotateSession = async (user) => {
    const previousSessionHash = user.sessionTokenHash;
    const session = createSession();
    user.sessionTokenHash = session.tokenHash;
    user.sessionExpiresAt = session.expiresAt;
    user.lastLoginAt = new Date();
    await user.save();
    if (previousSessionHash && previousSessionHash !== session.tokenHash) {
      await revokeSessionHash(previousSessionHash);
    }
    return session;
  };

  const logoutSession = async (Model, user, req) => {
    const token = sessionTokenFromRequest(req);
    await Model.updateOne(
      { id: user.id, ...activeSessionQuery(token) },
      { $set: { sessionTokenHash: '', sessionExpiresAt: null } },
    );
    await revokeSessionHash(hashSessionToken(token));
  };

  const loginClientByPhone = async (phone) => {
    let user = await ClientUser.findOne({ $or: [{ account: phone }, { phone }] });
    if (!user) {
      user = await createClientUserWithSignupCoupons({
        id: crypto.randomUUID(),
        account: phone,
        displayName: maskPhone(phone),
        gender: '保密',
        phone,
        authProvider: 'wechat',
      });
    } else {
      user.account = phone;
      user.phone = phone;
      user.authProvider = 'wechat';
    }
    const session = await rotateSession(user);
    return {
      token: session.token,
      expiresAt: session.expiresAt,
      user: buildClientUserPayload(user),
    };
  };

  const requireAuth = ({ Model, missing, expired, requestKey, query = activeSessionQuery }) =>
    async (req, res, next) => {
      const token = sessionTokenFromRequest(req);
      if (!token) return res.status(401).json({ message: missing });
      const user = await Model.findOne(query(token)).lean();
      if (!user) return res.status(401).json({ message: expired });
      req[requestKey] = user;
      next();
    };

  return {
    loginClientByPhone,
    logoutSession,
    rotateSession,
    requireMerchantAuth: requireAuth({
      Model: MerchantUser,
      missing: 'Merchant login required',
      expired: 'Merchant login expired',
      requestKey: 'merchantUser',
    }),
    requireAdminAuth: requireAuth({
      Model: AdminUser,
      missing: 'Admin login required',
      expired: 'Admin login expired',
      requestKey: 'adminUser',
    }),
    requireClientAuth: requireAuth({
      Model: ClientUser,
      missing: 'User login required',
      expired: 'User login required',
      requestKey: 'clientUser',
      query: token => ({ ...activeSessionQuery(token), authProvider: 'wechat' }),
    }),
  };
};

module.exports = {
  activeSessionQuery,
  buildAdminUserPayload,
  buildClientUserPayload,
  buildMerchantUserPayload,
  createAuthService,
  createClientUserWithSignupCoupons,
  createSession,
  decryptWechatPhoneNumber,
  getWechatPhoneNumber,
  hashSessionToken,
  normalizeUserId,
  sessionTokenFromRequest,
  userIdAliases,
};
