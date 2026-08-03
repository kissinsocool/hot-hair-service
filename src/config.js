const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const publicBaseUrl = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const DEMO_USER_ID = 'demo';
const uploadDir = path.join(__dirname, '..', 'uploads');
const imageCacheDir = path.join(__dirname, '..', 'image-cache');
const picturesDir = process.env.PICTURES_DIR || path.join(process.env.HOME || '', 'Pictures');
const ossRegion = process.env.OSS_REGION || 'oss-cn-beijing';
const ossBucket = process.env.OSS_BUCKET || 'hothairapp';
const ossPrivateBucket = process.env.OSS_PRIVATE_BUCKET || 'hothairprivate';
const ossEndpoint = process.env.OSS_ENDPOINT || 'https://oss-cn-beijing.aliyuncs.com';
const ossPublicBaseUrl = (process.env.OSS_PUBLIC_BASE_URL || 'https://oss.hothaircc.cn').replace(/\/+$/, '');
const ossPublicUploadUrl = (process.env.OSS_PUBLIC_UPLOAD_URL || `https://${ossBucket}.${ossRegion}.aliyuncs.com`).replace(/\/+$/, '');
const ossPrivateUploadUrl = (process.env.OSS_PRIVATE_UPLOAD_URL || `https://${ossPrivateBucket}.${ossRegion}.aliyuncs.com`).replace(/\/+$/, '');
const ossEnabled = Boolean(process.env.OSS_ACCESS_KEY_ID && process.env.OSS_ACCESS_KEY_SECRET);
const amapWebServiceKey = process.env.AMAP_WEB_SERVICE_KEY || process.env.AMAP_WEB_KEY || '';
const wechatAppId = process.env.WECHAT_APP_ID || process.env.WX_APP_ID || '';
const wechatAppSecret = process.env.WECHAT_APP_SECRET || process.env.WX_APP_SECRET || '';
const resolveTrustProxyHops = (value, nodeEnv = process.env.NODE_ENV) => {
  const fallback = String(nodeEnv || '').toLowerCase() === 'production' ? 1 : 0;
  if (value === undefined || value === '') return fallback;
  const hops = Math.floor(Number(value));
  return Number.isFinite(hops) && hops >= 0 ? hops : fallback;
};
const trustProxyHops = resolveTrustProxyHops(process.env.TRUST_PROXY_HOPS);
const positiveInteger = (value, fallback) => {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
};
const wsMaxConnections = positiveInteger(process.env.WS_MAX_CONNECTIONS, 5000);
const wsMaxConnectionsPerIp = positiveInteger(process.env.WS_MAX_CONNECTIONS_PER_IP, 20);
const sessionTtlSeconds = Math.min(positiveInteger(process.env.SESSION_TTL_SECONDS, 7 * 24 * 60 * 60), 30 * 24 * 60 * 60);
const businessTimeZone = 'Asia/Shanghai';
const businessUtcOffset = '+08:00';
const allowedOrigins = (process.env.CORS_ORIGIN || 'https://oss.hothaircc.cn')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);
const isAllowedOrigin = origin => !origin || allowedOrigins.includes(origin);

module.exports = {
  PORT,
  publicBaseUrl,
  DEMO_USER_ID,
  uploadDir,
  imageCacheDir,
  picturesDir,
  ossRegion,
  ossBucket,
  ossPrivateBucket,
  ossEndpoint,
  ossPublicBaseUrl,
  ossPublicUploadUrl,
  ossPrivateUploadUrl,
  ossEnabled,
  amapWebServiceKey,
  wechatAppId,
  wechatAppSecret,
  resolveTrustProxyHops,
  trustProxyHops,
  wsMaxConnections,
  wsMaxConnectionsPerIp,
  sessionTtlSeconds,
  businessTimeZone,
  businessUtcOffset,
  allowedOrigins,
  isAllowedOrigin,
};
