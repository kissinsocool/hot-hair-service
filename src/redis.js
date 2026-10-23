const { createClient } = require('redis');

const redisUrl = String(process.env.REDIS_URL || '').trim();
const SESSION_REVOCATION_CHANNEL = 'hot-hair:session-revoked';
let client;
let subscriber;

const connectRedis = async () => {
  if (!redisUrl) return false;
  client = createClient({ url: redisUrl });
  client.on('error', error => console.error('Redis error:', error.message));
  await client.connect();
  subscriber = client.duplicate();
  subscriber.on('error', error => console.error('Redis subscriber error:', error.message));
  await subscriber.connect();
  return true;
};

const getRedisClient = () => client?.isReady ? client : null;

const publishSessionRevocation = async (sessionHash) => {
  if (sessionHash && client?.isReady) {
    await client.publish(SESSION_REVOCATION_CHANNEL, sessionHash);
  }
};

const subscribeSessionRevocations = async (handler) => {
  if (!subscriber?.isReady) return false;
  await subscriber.subscribe(SESSION_REVOCATION_CHANNEL, handler);
  return true;
};

module.exports = {
  connectRedis,
  getRedisClient,
  publishSessionRevocation,
  subscribeSessionRevocations,
};
