const { Server } = require('socket.io');
const { authenticateSocket, canJoinConversation } = require('../utils/socketAccess');

let io;
// Map userId -> Set of socketIds (supports multiple tabs)
const onlineUsers = new Map();
// Map socketId -> disconnect timeout (for reconnection grace period)
const disconnectTimeouts = new Map();

const initSocket = (httpServer) => {
  io = new Server(httpServer, {
    cors: {
      origin: [
        'http://localhost:5173',
        'http://localhost:5000',
        'https://edu-connect-3.vercel.app',
        'https://edu-connect-fwoo.onrender.com',
        'https://short-job-3.vercel.app',
        ...(process.env.CLIENT_URL ? [process.env.CLIENT_URL] : []),
      ],
      methods: ['GET', 'POST'],
      credentials: true,
    },
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  io.use(authenticateSocket);

  io.on('connection', (socket) => {
    const expiryTimer = setTimeout(() => socket.disconnect(true), Math.min(
      Math.max(0, socket.data.expiresAt - Date.now()), 2147483647,
    ));
    console.log(`User connected: ${socket.id}`);

    // Join personal room and track online status
    socket.on('join_room', (payload) => {
      const requestedId = payload && typeof payload === 'object' ? payload.userId : payload;
      const userId = socket.data.userId;
      if (requestedId !== userId) return;
      const sharePresence = socket.data.sharePresence && payload?.sharePresence !== false;

      socket.join(userId);

      if (!sharePresence) {
        const existingSockets = onlineUsers.get(userId);
        const wasOnline = Boolean(existingSockets?.size);
        if (existingSockets) {
          existingSockets.delete(socket.id);
          if (existingSockets.size === 0) {
            onlineUsers.delete(userId);
          }
        }
        if (wasOnline && !onlineUsers.has(userId)) {
          io.emit('online_status', { userId, isOnline: false });
        }
        console.log(`User ${userId} joined privately`);
        return;
      }

      // Track all socket IDs for this user (supports multiple tabs)
      if (!onlineUsers.has(userId)) {
        onlineUsers.set(userId, new Set());
      }
      const wasOffline = onlineUsers.get(userId).size === 0;
      onlineUsers.get(userId).add(socket.id);

      // Clear any pending disconnect timeout for reconnection grace period
      if (disconnectTimeouts.has(socket.id)) {
        clearTimeout(disconnectTimeouts.get(socket.id));
        disconnectTimeouts.delete(socket.id);
      }

      // Only emit online if user was previously offline (handles reconnection)
      if (wasOffline) {
        io.emit('online_status', { userId, isOnline: true });
      }
      console.log(`User ${userId} joined their room (connections: ${onlineUsers.get(userId).size})`);
    });

    // Handle typing events
    socket.on('typing', (payload) => {
      const conversationId = payload?.conversationId;
      if (!socket.rooms.has(conversationId)) return;
      socket.to(conversationId).emit('is_typing', { conversationId, userId: socket.data.userId });
    });

    socket.on('stop_typing', (payload) => {
      const conversationId = payload?.conversationId;
      if (!socket.rooms.has(conversationId)) return;
      socket.to(conversationId).emit('stopped_typing', { conversationId, userId: socket.data.userId });
    });

    // Join conversation room for chat
    socket.on('join_conversation', async (conversationId, acknowledge) => {
      try {
        const allowed = await canJoinConversation(socket, conversationId);
        if (allowed) await socket.join(conversationId);
        if (typeof acknowledge === 'function') acknowledge({ success: allowed });
      } catch {
        if (typeof acknowledge === 'function') acknowledge({ success: false });
      }
    });

    socket.on('leave_conversation', (conversationId) => {
      if (typeof conversationId === 'string' && conversationId !== socket.data.userId) socket.leave(conversationId);
    });

    // Read receipts are emitted only by the authenticated HTTP controller
    // after membership verification and a successful database update.

    // Handle disconnect
    socket.on('disconnect', () => {
      clearTimeout(expiryTimer);
      console.log(`User disconnected: ${socket.id}`);
      // Find user by socket ID and remove this socket
      for (const [userId, socketIds] of onlineUsers.entries()) {
        if (socketIds.has(socket.id)) {
          socketIds.delete(socket.id);
          // Only emit offline if ALL sockets for this user are disconnected
          if (socketIds.size === 0) {
            // Grace period: wait 3 seconds before marking as offline
            // This handles page refreshes where a new socket connects quickly
            const timeout = setTimeout(() => {
              disconnectTimeouts.delete(socket.id);
              // Check if user still has no connections
              if (!onlineUsers.has(userId) || onlineUsers.get(userId).size === 0) {
                onlineUsers.delete(userId);
                io.emit('online_status', { userId, isOnline: false });
                console.log(`User ${userId} is now offline (all connections closed)`);
              }
            }, 3000);
            disconnectTimeouts.set(socket.id, timeout);
          } else {
            console.log(`User ${userId} still has ${socketIds.size} active connection(s)`);
          }
          break;
        }
      }
    });
  });

  return io;
};

const getIO = () => {
  if (!io) {
    throw new Error('Socket.io not initialized');
  }
  return io;
};

const getOnlineUsers = () => onlineUsers;

module.exports = { initSocket, getIO, getOnlineUsers };
