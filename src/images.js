const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PORT, imageCacheDir, picturesDir, uploadDir } = require('./config');

function compressedImageMiddleware(rootDir) {
  return (req, res, next) => {
    try {
      const relativePath = decodeURIComponent((req.params[0] || '').replace(/^\/+/, ''));
      if (!/\.(jpe?g|png)$/i.test(relativePath)) return next();

      const sourcePath = path.resolve(rootDir, relativePath);
      if (!sourcePath.startsWith(path.resolve(rootDir) + path.sep)) return res.status(403).end();
      const cachePath = compressedImagePath(sourcePath);
      if (!cachePath) return next();
      res.type('jpg').sendFile(cachePath);
    } catch (_) {
      next();
    }
  };
}

function compressedImagePath(sourcePath) {
  if (!/\.(jpe?g|png)$/i.test(sourcePath) || !fs.existsSync(sourcePath)) return '';

  const stat = fs.statSync(sourcePath);
  const cacheName = crypto
    .createHash('sha1')
    .update(`${sourcePath}:${stat.mtimeMs}:${stat.size}`)
    .digest('hex') + '.jpg';
  const cachePath = path.join(imageCacheDir, cacheName);

  if (!fs.existsSync(cachePath)) {
    // ponytail: macOS dev backend, switch to sharp when this runs off Mac.
    execFileSync('sips', ['-Z', '900', '-s', 'format', 'jpeg', '-s', 'formatOptions', '72', sourcePath, '--out', cachePath], {
      stdio: 'ignore',
    });
  }

  return cachePath;
}

const localImagePath = (url) => {
  try {
    const parsed = new URL(url);
    const pathname = decodeURIComponent(parsed.pathname);
    if (pathname.startsWith('/uploads/')) return path.join(uploadDir, pathname.slice('/uploads/'.length));
    if (pathname.startsWith('/images/')) return path.join(picturesDir, pathname.slice('/images/'.length));
  } catch (_) {}
  return '';
};

const imageExists = (url) => {
  const filePath = localImagePath(url);
  return !filePath || fs.existsSync(filePath);
};

const publicImageUrl = (url) => {
  const filePath = localImagePath(url);
  if (!filePath) return url;
  const cachePath = compressedImagePath(filePath);
  return cachePath ? `http://localhost:${PORT}/cached-images/${path.basename(cachePath)}` : url;
};

const saveBase64Image = (prefix, fileName, data, index = 0) => {
  if (typeof data !== 'string' || data.length === 0) return '';

  const extension = path.extname(fileName || '').toLowerCase() || '.png';
  const safeExtension = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(extension) ? extension : '.png';
  const base64 = data.includes(',') ? data.split(',').pop() : data;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return '';

  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length === 0 || buffer.length > 5 * 1024 * 1024) return '';

  const isImage =
    buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ||
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
    buffer.subarray(0, 6).toString('ascii') === 'GIF87a' ||
    buffer.subarray(0, 6).toString('ascii') === 'GIF89a' ||
    (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP');
  if (!isImage) return '';

  const imageName = `${prefix}-${Date.now()}-${index}-${Math.random().toString(36).slice(2)}${safeExtension}`;
  fs.writeFileSync(path.join(uploadDir, imageName), buffer);
  return `http://localhost:${PORT}/uploads/${imageName}`;
};

module.exports = {
  compressedImageMiddleware,
  imageExists,
  publicImageUrl,
  saveBase64Image,
};
