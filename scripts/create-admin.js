const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const { AdminUser } = require('../src/models');
const { hashPassword } = require('../src/passwords');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const readAdminConfig = (env = process.env) => {
  const username = String(env.ADMIN_USERNAME || '').trim();
  const password = String(env.ADMIN_PASSWORD || '');
  const displayName = String(env.ADMIN_DISPLAY_NAME || '平台管理员').trim();
  if (!username || username.length > 100) throw new Error('ADMIN_USERNAME is required and must not exceed 100 characters');
  if (password.length < 12 || password.length > 128) throw new Error('ADMIN_PASSWORD must contain 12 to 128 characters');
  if (!displayName || displayName.length > 100) throw new Error('ADMIN_DISPLAY_NAME must not exceed 100 characters');
  return { username, password, displayName };
};

const createAdmin = async () => {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) throw new Error('MONGODB_URI is required');
  const { username, password, displayName } = readAdminConfig();
  await mongoose.connect(mongoUri);
  if (await AdminUser.exists({ username })) throw new Error(`Admin user ${username} already exists`);
  const { salt, hash } = await hashPassword(password);
  await AdminUser.create({
    id: `admin-${crypto.randomUUID()}`,
    username,
    displayName,
    role: 'admin',
    passwordSalt: salt,
    passwordHash: hash,
  });
  console.log(`Admin user ${username} created`);
};

if (require.main === module) {
  createAdmin()
    .catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => mongoose.disconnect());
}

module.exports = { readAdminConfig };
