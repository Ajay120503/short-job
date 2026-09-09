const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Conversation = require('../models/Conversation');

const validId = (value) => typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);

const authenticateSocket = async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (typeof token !== 'string' || !token) throw new Error('Missing token');
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    if (!validId(decoded.id)) throw new Error('Invalid user');
    const user = await User.findById(decoded.id).select('_id isActive isBlocked showOnlineStatus');
    if (!user || user.isActive === false || user.isBlocked) throw new Error('Account unavailable');
    socket.data.userId = String(user._id);
    socket.data.sharePresence = user.showOnlineStatus !== false;
    socket.data.expiresAt = decoded.exp * 1000;
    next();
  } catch {
    next(new Error('Not authenticated. Please sign in again.'));
  }
};

const canJoinConversation = async (socket, conversationId) => {
  if (!validId(conversationId)) return false;
  return Boolean(await Conversation.exists({ _id: conversationId, participants: socket.data.userId }));
};

module.exports = { authenticateSocket, canJoinConversation };
