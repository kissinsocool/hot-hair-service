module.exports = (app, ctx) => {
  const {
    AdminUser,
    MerchantUser,
    verifyPassword,
    buildAdminUserPayload,
    buildMerchantUserPayload,
    rotateSession,
    loginClientByPhone,
    wechatAppId,
    wechatAppSecret,
    getWechatPhoneNumber,
    decryptWechatPhoneNumber,
    rateLimits,
  } = ctx;

  app.post('/api/auth/wechat/phone', ...rateLimits.login, async (req, res) => {
    const body = req.body || {};
    const code = String(body.code || '').trim();
    const encryptedData = String(body.encryptedData || '').trim();
    const iv = String(body.iv || '').trim();
    const loginCode = String(body.loginCode || '').trim();
    if (!code && (!encryptedData || !iv || !loginCode)) {
      return res.status(400).json({ message: '微信手机号授权参数不完整' });
    }
    if (!wechatAppId || !wechatAppSecret) {
      return res.status(503).json({ message: 'WECHAT_APP_ID and WECHAT_APP_SECRET are missing' });
    }

    try {
      const phone = code
        ? await getWechatPhoneNumber(code)
        : await decryptWechatPhoneNumber({ encryptedData, iv, loginCode });
      res.json(await loginClientByPhone(phone));
    } catch (error) {
      res.status(401).json({ message: error.message || '微信手机号授权失败' });
    }
  });

  const passwordLogin = ({ path, Model, accountField, buildPayload }) => {
    app.post(path, ...rateLimits.login, async (req, res) => {
      const body = req.body || {};
      const account = String(body[accountField] || '').trim();
      const password = String(body.password || '');
      if (!account || !password) {
        return res.status(400).json({ message: `${accountField} and password are required` });
      }
      if (account.length > 100 || password.length > 128) {
        return res.status(400).json({ message: `${accountField} or password is too long` });
      }

      const user = await Model.findOne({ [accountField]: account });
      if (!user || !await verifyPassword(password, user)) {
        return res.status(401).json({ message: '账号或密码错误' });
      }
      const session = await rotateSession(user);
      res.json({
        token: session.token,
        expiresAt: session.expiresAt,
        user: buildPayload(user),
      });
    });
  };

  passwordLogin({
    path: '/api/merchant/auth/login',
    Model: MerchantUser,
    accountField: 'username',
    buildPayload: buildMerchantUserPayload,
  });
  passwordLogin({
    path: '/api/admin/auth/login',
    Model: AdminUser,
    accountField: 'username',
    buildPayload: buildAdminUserPayload,
  });
};
