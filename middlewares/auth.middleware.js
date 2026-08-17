const jwt = require('jsonwebtoken');
const User = require('../models/User');

const getTokenFromRequest = (req) => {
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    return req.headers.authorization.split(' ')[1];
  }
  if (req.cookies && req.cookies.token) {
    return req.cookies.token;
  }
  return null;
};

const attachUserFromToken = async (req, token) => {
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  const user = await User.findById(decoded.id);
  if (!user) {
    const error = new Error('User no longer exists.');
    error.statusCode = 401;
    throw error;
  }

  if (user.isActive === false) {
    const error = new Error('Please verify your account before continuing.');
    error.statusCode = 403;
    throw error;
  }

  if (user.isBlocked) {
    const error = new Error('Your account has been suspended.');
    error.statusCode = 403;
    error.code = 'account_suspended';
    error.reason = user.blockedReason;
    throw error;
  }

  req.user = user;

  const today = new Date().toISOString().slice(0, 10);
  const recentDays = (user.activeDays || []).filter((day) => {
    const dayTime = new Date(`${day}T00:00:00.000Z`).getTime();
    return !Number.isNaN(dayTime) && Date.now() - dayTime <= 8 * 24 * 60 * 60 * 1000;
  });

  const shouldTouchActivity =
    !user.lastActiveAt ||
    Date.now() - new Date(user.lastActiveAt).getTime() > 5 * 60 * 1000 ||
    !recentDays.includes(today);

  if (shouldTouchActivity) {
    const activeDays = [...new Set([...recentDays, today])].slice(-8);
    user.lastActiveAt = new Date();
    user.activeDays = activeDays;
    User.updateOne(
      { _id: user._id },
      { lastActiveAt: user.lastActiveAt, activeDays }
    ).catch(() => {});
  }
};

const authMiddleware = async (req, res, next) => {
  try {
    const token = getTokenFromRequest(req);

    if (!token) {
      return res.status(401).json({ message: 'Not authenticated. Please log in.' });
    }

    await attachUserFromToken(req, token);
    next();
  } catch (error) {
    if (error.code === 'account_suspended') {
      return res.status(403).json({
        error: 'account_suspended',
        message: error.message,
        reason: error.reason,
        contact: 'support@educonnect.in',
      });
    }
    if (error.statusCode) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ message: 'Invalid token.' });
    }
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Token expired. Please log in again.' });
    }
    next(error);
  }
};

const optionalAuthMiddleware = async (req, res, next) => {
  try {
    const token = getTokenFromRequest(req);
    if (token) {
      await attachUserFromToken(req, token);
    }
    next();
  } catch {
    next();
  }
};

module.exports = authMiddleware;
module.exports.optionalAuth = optionalAuthMiddleware;
