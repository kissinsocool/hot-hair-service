const { isIP } = require('node:net');
const { readFile } = require('node:fs/promises');

const databasePaths = {
  4: process.env.IP_REGION_V4_XDB,
  6: process.env.IP_REGION_V6_XDB,
};
const searchers = new Map();

async function lookupRegion(ip, family) {
  const path = databasePaths[family];
  if (!path) return '';
  if (!searchers.has(family)) {
    const pending = Promise.all([import('ip2region.js'), readFile(path)])
      .then(([xdb, buffer]) => xdb.newWithBuffer(family === 4 ? xdb.IPv4 : xdb.IPv6, buffer))
      .catch(error => {
        searchers.delete(family);
        throw error;
      });
    searchers.set(family, pending);
  }
  return (await searchers.get(family)).search(ip);
}

async function serviceAreaStatus(address, lookup = lookupRegion) {
  const ip = String(address || '').replace(/^::ffff:(?=\d+\.)/i, '');
  const family = isIP(ip);
  if (!family) return 'unknown';
  const [country, province] = String(await lookup(ip, family) || '').split('|');
  if (!country || ['0', '内网IP', 'Reserved'].includes(country)) return 'unknown';
  if (country !== '中国') return 'closed';
  if (!province || province === '0') return 'unknown';
  return province === '北京' || province === '北京市' ? 'open' : 'closed';
}

module.exports = { serviceAreaStatus };
