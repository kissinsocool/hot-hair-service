const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const DEMO_USER_ID = 'demo';
const uploadDir = path.join(__dirname, '..', 'uploads');
const imageCacheDir = path.join(__dirname, '..', 'image-cache');
const dataDir = path.join(__dirname, '..', 'data');
const favoritesFile = path.join(dataDir, 'favorites.json');
const picturesDir = process.env.PICTURES_DIR || path.join(process.env.HOME || '', 'Pictures');
const amapWebServiceKey = process.env.AMAP_WEB_SERVICE_KEY || process.env.AMAP_WEB_KEY || '';
const wechatAppId = process.env.WECHAT_APP_ID || process.env.WX_APP_ID || '';
const wechatAppSecret = process.env.WECHAT_APP_SECRET || process.env.WX_APP_SECRET || '';
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:3000,http://localhost:5173,http://127.0.0.1:5173')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

module.exports = {
  PORT,
  DEMO_USER_ID,
  uploadDir,
  imageCacheDir,
  dataDir,
  favoritesFile,
  picturesDir,
  amapWebServiceKey,
  wechatAppId,
  wechatAppSecret,
  allowedOrigins,
};
