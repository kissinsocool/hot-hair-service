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
  ossPublicUploadUrl,
  ossPrivateUploadUrl,
  ossEnabled,
} = require('./config');

const MODERATED_IMAGE_MAX_BYTES = 800 * 1024;
const MERCHANT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const MODERATED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

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
      const cachePath = await compressedImagePath(sourcePath, false);
      if (!cachePath) return next();
      res.type('jpg').sendFile(cachePath);
    } catch (_) {
      next();
    }
  };
}

async function compressedImagePath(sourcePath, waitForCompression = true) {
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
    return waitForCompression ? compressionJobs.get(cachePath) : '';
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

const publicOssOrigin = `https://${ossBucket}.${ossRegion}.aliyuncs.com`;
const publicImageUrl = (url) => {
  const value = String(url || '').trim();
  return value === publicOssOrigin || value.startsWith(`${publicOssOrigin}/`)
    ? `${ossPublicBaseUrl}${value.slice(publicOssOrigin.length)}`
    : value;
};

const saveBase64Image = async (prefix, fileName, data, index = 0) => {
  const { buffer, imageName } = decodeBase64Image(prefix, fileName, data, index);
  if (!buffer) return '';

  if (ossClient) {
    await ossClient.put(`uploads/${imageName}`, buffer);
    return `${ossPublicBaseUrl}/uploads/${imageName}`;
  }

  const imagePath = path.join(uploadDir, imageName);
  await fs.promises.writeFile(imagePath, buffer);
  await compressedImagePath(imagePath, false);
  return `${publicBaseUrl}/uploads/${imageName}`;
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

const moderatedOwnerKey = userId => crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 24);

const createMerchantUploadPolicies = ({ type, userId, files }) => {
  const isPrivate = type === 'qualification';
  const client = isPrivate ? privateOssClient : ossClient;
  if (!['public', 'qualification'].includes(type) || !client) {
    const error = new Error('OSS direct upload is not configured');
    error.httpStatus = 503;
    throw error;
  }
  if (!Array.isArray(files) || files.length < 1 || files.length > 4) {
    const error = new Error('Invalid merchant image upload request');
    error.httpStatus = 400;
    throw error;
  }

  const expiration = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  return files.map(file => {
    const contentType = String(file?.contentType || '').toLowerCase();
    const size = Number(file?.size);
    const extension = path.extname(String(file?.fileName || '')).toLowerCase();
    const safeExtension = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(extension) ? extension : '.jpg';
    if (!MODERATED_IMAGE_TYPES.has(contentType) || !Number.isInteger(size) || size < 1 || size > MERCHANT_IMAGE_MAX_BYTES) {
      const error = new Error('Image must be JPEG, PNG, WebP or GIF and no larger than 5 MB');
      error.httpStatus = 400;
      throw error;
    }

    const owner = moderatedOwnerKey(userId);
    const objectName = `${isPrivate ? 'licenses' : 'uploads'}/${owner}/${crypto.randomUUID()}${safeExtension}`;
    const signature = client.calculatePostSignature({
      expiration,
      conditions: [
        ['eq', '$key', objectName],
        ['eq', '$Content-Type', contentType],
        ['eq', '$success_action_status', '200'],
        ['content-length-range', 1, MERCHANT_IMAGE_MAX_BYTES],
      ],
    });
    return {
      objectName,
      uploadUrl: isPrivate ? ossPrivateUploadUrl : ossPublicUploadUrl,
      url: isPrivate ? undefined : `${ossPublicBaseUrl}/${objectName}`,
      expiresAt: expiration,
      fields: {
        key: objectName,
        policy: signature.policy,
        OSSAccessKeyId: signature.OSSAccessKeyId,
        signature: signature.Signature,
        'Content-Type': contentType,
        success_action_status: '200',
      },
    };
  });
};

const verifyMerchantQualificationObjects = async ({ userId, objectNames }) => {
  if (!Array.isArray(objectNames) || objectNames.length > 4 || new Set(objectNames).size !== objectNames.length) {
    const error = new Error('Invalid qualification image objects');
    error.httpStatus = 400;
    throw error;
  }
  if (!objectNames.length) return [];
  if (!privateOssClient) {
    const error = new Error('OSS direct upload is not configured');
    error.httpStatus = 503;
    throw error;
  }

  const prefix = `licenses/${moderatedOwnerKey(userId)}/`;
  await Promise.all(objectNames.map(async objectName => {
    if (typeof objectName !== 'string' || !objectName.startsWith(prefix) || objectName.includes('..')) {
      const error = new Error('Invalid qualification image object');
      error.httpStatus = 400;
      throw error;
    }
    try {
      const result = await privateOssClient.head(objectName);
      const headers = result?.res?.headers || result?.headers || {};
      const size = Number(headers['content-length']);
      const contentType = String(headers['content-type'] || '').split(';')[0].toLowerCase();
      if (!Number.isFinite(size) || size < 1 || size > MERCHANT_IMAGE_MAX_BYTES || !MODERATED_IMAGE_TYPES.has(contentType)) {
        const error = new Error('Invalid qualification image');
        error.httpStatus = 400;
        throw error;
      }
    } catch (error) {
      if (error.httpStatus) throw error;
      const invalid = new Error('Uploaded qualification image was not found');
      invalid.httpStatus = 400;
      throw invalid;
    }
  }));
  return objectNames;
};

const createModeratedUploadPolicies = ({ type, userId, files }) => {
  if (!privateOssClient) {
    const error = new Error('OSS direct upload is not configured');
    error.httpStatus = 503;
    throw error;
  }
  if (!['review', 'complaint'].includes(type) || !Array.isArray(files) || files.length < 1 || files.length > 5) {
    const error = new Error('Invalid image upload request');
    error.httpStatus = 400;
    throw error;
  }

  const expiration = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  return files.map(file => {
    const contentType = String(file?.contentType || '').toLowerCase();
    const size = Number(file?.size);
    const extension = path.extname(String(file?.fileName || '')).toLowerCase();
    const safeExtension = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(extension) ? extension : '.jpg';
    if (!MODERATED_IMAGE_TYPES.has(contentType) || !Number.isInteger(size) || size < 1 || size > MODERATED_IMAGE_MAX_BYTES) {
      const error = new Error('Image must be JPEG, PNG, WebP or GIF and no larger than 800 KB');
      error.httpStatus = 400;
      throw error;
    }

    const objectName = `moderation/${type}/${moderatedOwnerKey(userId)}/${crypto.randomUUID()}${safeExtension}`;
    const signature = privateOssClient.calculatePostSignature({
      expiration,
      conditions: [
        ['eq', '$key', objectName],
        ['eq', '$Content-Type', contentType],
        ['eq', '$success_action_status', '200'],
        ['content-length-range', 1, MODERATED_IMAGE_MAX_BYTES],
      ],
    });
    return {
      objectName,
      uploadUrl: ossPrivateUploadUrl,
      expiresAt: expiration,
      fields: {
        key: objectName,
        policy: signature.policy,
        OSSAccessKeyId: signature.OSSAccessKeyId,
        signature: signature.Signature,
        'Content-Type': contentType,
        success_action_status: '200',
      },
    };
  });
};

const verifyModeratedImageObjects = async ({ type, userId, objectNames }) => {
  if (!Array.isArray(objectNames) || objectNames.length > 5 || new Set(objectNames).size !== objectNames.length) {
    const error = new Error('Invalid image objects');
    error.httpStatus = 400;
    throw error;
  }
  if (!objectNames.length) return [];
  if (!privateOssClient) {
    const error = new Error('OSS direct upload is not configured');
    error.httpStatus = 503;
    throw error;
  }

  const prefix = `moderation/${type}/${moderatedOwnerKey(userId)}/`;
  await Promise.all(objectNames.map(async objectName => {
    if (typeof objectName !== 'string' || !objectName.startsWith(prefix) || objectName.includes('..')) {
      const error = new Error('Invalid image object');
      error.httpStatus = 400;
      throw error;
    }
    try {
      const result = await privateOssClient.head(objectName);
      const headers = result?.res?.headers || result?.headers || {};
      const size = Number(headers['content-length']);
      const contentType = String(headers['content-type'] || '').split(';')[0].toLowerCase();
      if (!Number.isFinite(size) || size < 1 || size > MODERATED_IMAGE_MAX_BYTES) {
        const error = new Error('图片压缩后仍超过 800 KB');
        error.httpStatus = 400;
        throw error;
      }
      if (!MODERATED_IMAGE_TYPES.has(contentType)) {
        const error = new Error('上传的图片格式无效');
        error.httpStatus = 400;
        throw error;
      }
    } catch (error) {
      if (error.httpStatus) throw error;
      const invalid = new Error('Uploaded image was not found');
      invalid.httpStatus = 400;
      throw invalid;
    }
  }));
  return objectNames;
};

const publishModeratedImage = async (objectName) => {
  if (!objectName || /^https?:\/\//i.test(objectName)) return objectName || '';
  if (!objectName.startsWith('moderation/') || !privateOssClient || !ossClient) return '';
  const publicObjectName = `uploads/${path.basename(objectName)}`;
  const { content } = await privateOssClient.get(objectName);
  await ossClient.put(publicObjectName, content);
  await privateOssClient.delete(objectName);
  return `${ossPublicBaseUrl}/${publicObjectName}`;
};

const deleteModeratedImages = async (objectNames = []) => {
  if (!privateOssClient) return;
  await Promise.all(objectNames
    .filter(name => typeof name === 'string' && name.startsWith('moderation/'))
    .map(name => privateOssClient.delete(name)));
};

const privateImageUrl = (objectName, expires = 600) => {
  if (!objectName || /^https?:\/\//i.test(objectName)) return objectName || '';
  if (!privateOssClient) return '';
  return privateOssClient.signatureUrl(objectName, { expires });
};

module.exports = {
  compressedImageMiddleware,
  createMerchantUploadPolicies,
  createModeratedUploadPolicies,
  imageExists,
  publicImageUrl,
  deleteModeratedImages,
  publishModeratedImage,
  saveBase64Image,
  privateImageUrl,
  verifyMerchantQualificationObjects,
  verifyModeratedImageObjects,
};
