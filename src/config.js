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
const ossPublicBaseUrl = (process.env.OSS_PUBLIC_BASE_URL || `https://${ossBucket}.${ossRegion}.aliyuncs.com`).replace(/\/+$/, '');
const ossPublicUploadUrl = (process.env.OSS_PUBLIC_UPLOAD_URL || `https://${ossBucket}.${ossRegion}.aliyuncs.com`).replace(/\/+$/, '');
const ossPrivateUploadUrl = (process.env.OSS_PRIVATE_UPLOAD_URL || `https://${ossPrivateBucket}.${ossRegion}.aliyuncs.com`).replace(/\/+$/, '');
const ossEnabled = Boolean(process.env.OSS_ACCESS_KEY_ID && process.env.OSS_ACCESS_KEY_SECRET);
const amapWebServiceKey = process.env.AMAP_WEB_SERVICE_KEY || process.env.AMAP_WEB_KEY || '';
const wechatAppId = process.env.WECHAT_APP_ID || process.env.WX_APP_ID || '';
const wechatAppSecret = process.env.WECHAT_APP_SECRET || process.env.WX_APP_SECRET || '';
const trustProxyHops = Math.max(0, Math.floor(Number(process.env.TRUST_PROXY_HOPS || 0)) || 0);
const positiveInteger = (value, fallback) => {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
};
const wsMaxConnections = positiveInteger(process.env.WS_MAX_CONNECTIONS, 5000);
const wsMaxConnectionsPerIp = positiveInteger(process.env.WS_MAX_CONNECTIONS_PER_IP, 20);
const sessionTtlSeconds = Math.min(positiveInteger(process.env.SESSION_TTL_SECONDS, 7 * 24 * 60 * 60), 30 * 24 * 60 * 60);
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:3000,http://localhost:5173,http://127.0.0.1:5173,http://oss.hothair.top')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);
const isAllowedOrigin = (origin) => {
  if (!origin || allowedOrigins.includes(origin)) return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1';
  } catch {
    return false;
  }
};

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
  trustProxyHops,
  wsMaxConnections,
  wsMaxConnectionsPerIp,
  sessionTtlSeconds,
  allowedOrigins,
  isAllowedOrigin,
};
