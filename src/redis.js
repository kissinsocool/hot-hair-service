const { randomUUID } = require('node:crypto');
const { createClient } = require('redis');

const redisUrl = String(process.env.REDIS_URL || '').trim();
const SESSION_REVOCATION_CHANNEL = 'hot-hair:session-revoked';
const INSTANCE_EVENT_CHANNEL = 'hot-hair:instance-events';
const instanceId = randomUUID();
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
const isRedisReady = () => Boolean(client?.isReady && subscriber?.isReady);

const disconnectRedis = async () => {
  await Promise.allSettled([subscriber, client]
    .filter(connection => connection?.isOpen)
    .map(connection => connection.close()));
};

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

const publishInstanceEvent = async (type, payload) => {
  if (!redisUrl) return;
  if (!client?.isReady) throw new Error('Redis publisher is unavailable');
  await client.publish(INSTANCE_EVENT_CHANNEL, JSON.stringify({ instanceId, type, payload }));
};

const subscribeInstanceEvents = async (handler, onReconnect) => {
  await subscriber.subscribe(INSTANCE_EVENT_CHANNEL, message => {
    try {
      const event = JSON.parse(message);
      if (event.instanceId !== instanceId) handler(event.type, event.payload);
    } catch (error) {
      console.error('Redis instance event failed:', error.message);
    }
  });
  subscriber.on('ready', onReconnect);
};

module.exports = {
  publishInstanceEvent,
  subscribeInstanceEvents,
  connectRedis,
  disconnectRedis,
  getRedisClient,
  isRedisReady,
  publishSessionRevocation,
  subscribeSessionRevocations,
};
