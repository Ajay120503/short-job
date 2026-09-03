const { createClient } = require('redis');

let client;
let ready = false;

const connectRedis = async () => {
  if (!process.env.REDIS_URL) {
    console.log('Redis disabled: REDIS_URL is not configured');
    return false;
  }

  try {
    const { hostname } = new URL(process.env.REDIS_URL);
    const isRenderInternalHost = /^red-[a-z0-9]+$/i.test(hostname);
    const isRenderRuntime = process.env.RENDER === 'true';
    if (!isRenderRuntime && isRenderInternalHost) {
      console.warn('Redis disabled locally: the configured Render internal URL is only reachable from Render. Use localhost Redis or a Render external URL for local development.');
      return false;
    }
  } catch (_) {
    console.error('Redis disabled: REDIS_URL is not a valid redis:// or rediss:// URL');
    return false;
  }

  let connecting = true;
  client = createClient({
    url: process.env.REDIS_URL,
    socket: {
      connectTimeout: 5000,
      reconnectStrategy: (retries) => (retries > 5 ? false : Math.min(retries * 200, 2000)),
    },
  });
  client.on('ready', () => { ready = true; });
  client.on('end', () => { ready = false; });
  client.on('reconnecting', () => { ready = false; });
  client.on('error', (error) => {
    if (!connecting) console.error('Redis connection lost:', error.message);
  });

  try {
    await client.connect();
    await client.set('shortjob:cache:version', '1', { NX: true });
    ready = true;
    connecting = false;
    console.log('Redis connected successfully');
    return true;
  } catch (error) {
    ready = false;
    connecting = false;
    if (client?.isOpen) client.destroy();
    console.error('Redis unavailable; continuing without cache:', error.message);
    return false;
  }
};

const getRedisClient = () => (ready && client?.isReady ? client : null);
const getRedisStatus = () => ({ configured: Boolean(process.env.REDIS_URL), connected: Boolean(getRedisClient()) });

const disconnectRedis = async () => {
  ready = false;
  if (client?.isOpen) await client.quit().catch(() => client.destroy());
};

module.exports = { connectRedis, disconnectRedis, getRedisClient, getRedisStatus };
