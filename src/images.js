const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const OSS = require('ali-oss');
const { execFile } = require('child_process');
const { promisify } = require('util');
const {
  imageCacheDir,
  picturesDir,
  publicBaseUrl,
  uploadDir,
  ossRegion,
  ossBucket,
  ossPrivateBucket,
  ossEndpoint,
  ossPublicBaseUrl,
  ossEnabled,
} = require('./config');

const execFileAsync = promisify(execFile);
const compressionJobs = new Map();
let compressionQueue = Promise.resolve();

const ossClient = ossEnabled
  ? new OSS({
      region: ossRegion,
      bucket: ossBucket,
      endpoint: ossEndpoint,
      accessKeyId: process.env.OSS_ACCESS_KEY_ID,
      accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    })
  : null;

const privateOssClient = ossEnabled
  ? new OSS({
      region: ossRegion,
      bucket: ossPrivateBucket,
      endpoint: ossEndpoint,
      accessKeyId: process.env.OSS_ACCESS_KEY_ID,
      accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    })
  : null;

function compressedImageMiddleware(rootDir) {
  return async (req, res, next) => {
    try {
      const relativePath = decodeURIComponent((req.params[0] || '').replace(/^\/+/, ''));
      if (!/\.(jpe?g|png)$/i.test(relativePath)) return next();

      const sourcePath = path.resolve(rootDir, relativePath);
      if (!sourcePath.startsWith(path.resolve(rootDir) + path.sep)) return res.status(403).end();
      const cachePath = await compressedImagePath(sourcePath);
      if (!cachePath) return next();
      res.type('jpg').sendFile(cachePath);
    } catch (_) {
      next();
    }
  };
}

async function compressedImagePath(sourcePath) {
  if (!/\.(jpe?g|png)$/i.test(sourcePath)) return '';

  let stat;
  try {
    stat = await fs.promises.stat(sourcePath);
  } catch {
    return '';
  }
  const cacheName = crypto
    .createHash('sha1')
    .update(`${sourcePath}:${stat.mtimeMs}:${stat.size}`)
    .digest('hex') + '.jpg';
  const cachePath = path.join(imageCacheDir, cacheName);

  try {
    await fs.promises.access(cachePath);
  } catch {
    if (!compressionJobs.has(cachePath)) {
      // ponytail: serialize local compression; move this queue to workers when upload throughput requires it.
      const compression = compressionQueue.then(() =>
        execFileAsync('sips', ['-Z', '900', '-s', 'format', 'jpeg', '-s', 'formatOptions', '72', sourcePath, '--out', cachePath])
      );
      compressionQueue = compression.catch(() => {});
      const job = compression
        .then(() => cachePath)
        .catch(() => '')
        .finally(() => compressionJobs.delete(cachePath));
      compressionJobs.set(cachePath, job);
    }
    return compressionJobs.get(cachePath);
  }

  return cachePath;
}

const localImagePath = (url) => {
  try {
    const parsed = new URL(url);
    const publicOrigin = new URL(publicBaseUrl).origin;
    if (parsed.origin !== publicOrigin) return '';
    const pathname = decodeURIComponent(parsed.pathname);
    if (pathname.startsWith('/uploads/')) return path.join(uploadDir, pathname.slice('/uploads/'.length));
    if (pathname.startsWith('/images/')) return path.join(picturesDir, pathname.slice('/images/'.length));
  } catch (_) {}
  return '';
};

const imageExists = async (url) => {
  const filePath = localImagePath(url);
  if (!filePath) return true;
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
};

const publicImageUrl = url => url;

const saveBase64Image = async (prefix, fileName, data, index = 0) => {
  const { buffer, imageName } = decodeBase64Image(prefix, fileName, data, index);
  if (!buffer) return '';

  if (ossClient) {
    await ossClient.put(`uploads/${imageName}`, buffer);
    return `${ossPublicBaseUrl}/uploads/${imageName}`;
  }

  const imagePath = path.join(uploadDir, imageName);
  await fs.promises.writeFile(imagePath, buffer);
  const cachePath = await compressedImagePath(imagePath);
  return cachePath
    ? `${publicBaseUrl}/cached-images/${path.basename(cachePath)}`
    : `${publicBaseUrl}/uploads/${imageName}`;
};

const decodeBase64Image = (prefix, fileName, data, index = 0) => {
  if (typeof data !== 'string' || data.length === 0) return {};

  const extension = path.extname(fileName || '').toLowerCase() || '.png';
  const safeExtension = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(extension) ? extension : '.png';
  const base64 = data.includes(',') ? data.split(',').pop() : data;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return {};

  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length === 0 || buffer.length > 5 * 1024 * 1024) return {};

  const isImage =
    buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ||
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
    buffer.subarray(0, 6).toString('ascii') === 'GIF87a' ||
    buffer.subarray(0, 6).toString('ascii') === 'GIF89a' ||
    (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP');
  if (!isImage) return {};

  return {
    buffer,
    imageName: `${prefix}-${Date.now()}-${index}-${Math.random().toString(36).slice(2)}${safeExtension}`,
  };
};

const savePrivateBase64Image = async (prefix, fileName, data, index = 0) => {
  const { buffer, imageName } = decodeBase64Image(prefix, fileName, data, index);
  if (!buffer || !privateOssClient) return '';
  const objectName = `licenses/${imageName}`;
  await privateOssClient.put(objectName, buffer, { headers: { 'x-oss-object-acl': 'private' } });
  return objectName;
};

const privateImageUrl = (objectName, expires = 600) => {
  if (!objectName || /^https?:\/\//i.test(objectName)) return objectName || '';
  if (!privateOssClient) return '';
  return privateOssClient.signatureUrl(objectName, { expires });
};

module.exports = {
  compressedImageMiddleware,
  imageExists,
  publicImageUrl,
  saveBase64Image,
  savePrivateBase64Image,
  privateImageUrl,
};
