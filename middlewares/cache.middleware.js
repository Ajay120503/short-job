const crypto = require('crypto');
const { getRedisClient } = require('../config/redis');

const VERSION_KEY = 'shortjob:cache:version';

const cacheResponse = ({ ttl = 30, varyByUser = false } = {}) => async (req, res, next) => {
  const redis = getRedisClient();
  if (!redis || req.method !== 'GET') return next();

  try {
    const version = (await redis.get(VERSION_KEY)) || '1';
    const identity = varyByUser ? (req.user?._id?.toString() || 'guest') : 'shared';
    const digest = crypto.createHash('sha256').update(`${identity}:${req.originalUrl}`).digest('hex');
    const key = `shortjob:cache:v${version}:${digest}`;
    const cached = await redis.get(key);
    if (cached) {
      res.set('X-Cache', 'HIT');
      return res.status(200).json(JSON.parse(cached));
    }

    const sendJson = res.json.bind(res);
    res.json = (payload) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        redis.setEx(key, ttl, JSON.stringify(payload)).catch((error) => {
          console.error('Redis cache write failed:', error.message);
        });
        res.set('X-Cache', 'MISS');
      }
      return sendJson(payload);
    };
  } catch (error) {
    console.error('Redis cache read failed:', error.message);
  }
  next();
};

const invalidateCacheAfterMutation = (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const doesNotAffectCachedContent =
    req.path === '/api/users/me/location' ||
    /^\/api\/jobs\/[^/]+\/view$/.test(req.path) ||
    req.path.startsWith('/api/chat/') ||
    req.path.startsWith('/api/notifications/') ||
    req.path.startsWith('/api/auth/login') ||
    req.path === '/api/auth/logout' ||
    req.path === '/api/auth/refresh-token';
  if (doesNotAffectCachedContent) return next();
  res.on('finish', () => {
    if (res.statusCode < 200 || res.statusCode >= 400) return;
    const redis = getRedisClient();
    if (redis) redis.incr(VERSION_KEY).catch((error) => console.error('Redis invalidation failed:', error.message));
  });
  next();
};

module.exports = { cacheResponse, invalidateCacheAfterMutation };
