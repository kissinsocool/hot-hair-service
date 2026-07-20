const path = require('node:path');
const crypto = require('node:crypto');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const { sessionTtlSeconds } = require('../src/config');
const { ClientUser } = require('../src/models');
const { hashPassword } = require('../src/passwords');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const readLoadTestConfig = (env = process.env) => {
  if (env.NODE_ENV === 'production') {
    throw new Error('Refusing to create load-test users in production');
  }

  const mongoUri = String(env.MONGODB_URI || '').trim();
  const count = Number(env.K6_TOKEN_COUNT || 5);
  const prefix = String(env.K6_USER_PREFIX || 'k6-load').trim().toLowerCase();
  if (!mongoUri) throw new Error('MONGODB_URI is required');
  if (!Number.isInteger(count) || count < 1 || count > 50) {
    throw new Error('K6_TOKEN_COUNT must be an integer from 1 to 50');
  }
  if (!/^[a-z0-9_-]{1,40}$/.test(prefix)) {
    throw new Error('K6_USER_PREFIX may contain only a-z, 0-9, _ and -');
  }
  return { mongoUri, count, prefix };
};

const createLoadTestUsers = async () => {
  const { mongoUri, count, prefix } = readLoadTestConfig();
  await mongoose.connect(mongoUri);

  const { salt, hash } = await hashPassword(crypto.randomBytes(32).toString('hex'));
  const expiresAt = new Date(Date.now() + sessionTtlSeconds * 1000);
  const tokens = [];

  for (let index = 1; index <= count; index += 1) {
    const suffix = String(index).padStart(3, '0');
    const account = `${prefix}-${suffix}`;
    const token = crypto.randomBytes(32).toString('hex');
    tokens.push(token);
    await ClientUser.updateOne(
      { account },
      {
        $set: {
          sessionTokenHash: crypto.createHash('sha256').update(token).digest('hex'),
          sessionExpiresAt: expiresAt,
          lastLoginAt: new Date(),
        },
        $setOnInsert: {
          id: account,
          account,
          displayName: `K6 Load User ${suffix}`,
          passwordSalt: salt,
          passwordHash: hash,
        },
      },
      { upsert: true },
    );
  }

  console.log(`Created or refreshed ${count} load-test users; tokens expire at ${expiresAt.toISOString()}`);
  console.log(`K6_CLIENT_TOKENS=${tokens.join(',')}`);
};

if (require.main === module) {
  createLoadTestUsers()
    .catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => mongoose.disconnect());
}

module.exports = { readLoadTestConfig };
