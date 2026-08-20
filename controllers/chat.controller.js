const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const { getIO, getOnlineUsers } = require('../config/socket');
const { uploadToCloudinary } = require('../middlewares/upload.middleware');

const conversationLocks = new Map();

const getConversationKey = (userIdA, userIdB) =>
  [userIdA.toString(), userIdB.toString()].sort().join(':');

const withConversationLock = async (key, work) => {
  const previous = conversationLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  const entry = previous.then(() => current);
  conversationLocks.set(key, entry);

  await previous;
  try {
    return await work();
  } finally {
    release();
    if (conversationLocks.get(key) === entry) {
      conversationLocks.delete(key);
    }
  }
};

const hasExactlyParticipants = (conversation, participantIds) => {
  const current = (conversation.participants || []).map((id) => id.toString()).sort();
  const expected = participantIds.map((id) => id.toString()).sort();
  return current.length === expected.length && current.every((id, index) => id === expected[index]);
};

const normalizeUnreadCounts = (conversation) => {
  const unreadCounts = conversation.unreadCounts;
  if (!unreadCounts) return {};
  if (typeof unreadCounts.toObject === 'function') return unreadCounts.toObject();
  if (unreadCounts instanceof Map) return Object.fromEntries(unreadCounts);
  return unreadCounts;
};

// @desc    Get all conversations for a user
// @route   GET /api/conversations
const getConversations = async (req, res) => {
  try {
    const conversations = await Conversation.find({
      participants: req.user._id,
    })
      .populate('participants', 'name profilePic role openToOpportunities profileThemeVariant')
      .populate('lastMessageSender', 'name')
      .sort({ updatedAt: -1 });

    // Add online status info
    const onlineUsers = getOnlineUsers();
    const seenParticipants = new Set();
    const conversationsWithStatus = [];

    conversations.forEach((conv) => {
      const otherParticipant = conv.participants.find(
        (p) => p._id.toString() !== req.user._id.toString()
      );
      const otherId = otherParticipant?._id?.toString();
      if (!otherId || seenParticipants.has(otherId)) return;
      seenParticipants.add(otherId);

      conversationsWithStatus.push({
        ...conv.toObject(),
        unreadCounts: normalizeUnreadCounts(conv),
        otherParticipant,
        isOnline: onlineUsers.has(otherParticipant?._id.toString()),
      });
    });

    res.json({ success: true, conversations: conversationsWithStatus });
  } catch (error) {
    console.error('Get conversations error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Get messages in a conversation
// @route   GET /api/conversations/:id/messages
const getMessages = async (req, res) => {
  try {
    const { id } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    // Verify user is a participant
    const conversation = await Conversation.findById(id);
    if (!conversation) {
      return res.status(404).json({ message: 'Conversation not found.' });
    }

    if (!conversation.participants.some((p) => p.toString() === req.user._id.toString())) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const messages = await Message.find({ conversation: id })
      .populate('sender', 'name profilePic openToOpportunities profileThemeVariant')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await Message.countDocuments({ conversation: id });

    res.json({
      success: true,
      messages: messages.reverse(), // Return in chronological order
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Get messages error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Start a new conversation (or get existing)
// @route   POST /api/conversations
const createConversation = async (req, res) => {
  try {
    const { participantId } = req.body;

    if (!participantId) {
      return res.status(400).json({ message: 'Participant ID is required.' });
    }

    if (participantId === req.user._id.toString()) {
      return res.status(400).json({ message: 'Cannot create conversation with yourself.' });
    }

    const conversationKey = getConversationKey(req.user._id, participantId);
    const participantIds = [req.user._id, participantId];

    const conversation = await withConversationLock(conversationKey, async () => {
      // Backfill a key for any older exact one-to-one conversation between these users.
      await Conversation.updateMany(
        {
          participants: { $all: participantIds, $size: 2 },
          $or: [{ conversationKey: { $exists: false } }, { conversationKey: null }],
        },
        { $set: { conversationKey } }
      );

      // Check if conversation already exists. $size avoids matching future group chats.
      const existingConversations = await Conversation.find({
        $or: [
          { conversationKey },
          { participants: { $all: participantIds, $size: 2 } },
        ],
      })
        .sort({ updatedAt: -1 })
        .populate('participants', 'name profilePic role openToOpportunities profileThemeVariant');

      const existingConversation = existingConversations.find((item) =>
        hasExactlyParticipants(item, participantIds)
      );

      if (existingConversation) {
        if (existingConversation.conversationKey !== conversationKey) {
          existingConversation.conversationKey = conversationKey;
          await existingConversation.save();
        }
        return existingConversation;
      }

      // Create new conversation
      const created = await Conversation.create({
        participants: participantIds,
        conversationKey,
        unreadCounts: new Map([
          [req.user._id.toString(), 0],
          [participantId, 0],
        ]),
      });

      return Conversation.findById(created._id)
        .populate('participants', 'name profilePic role openToOpportunities profileThemeVariant');
    });

    res.status(201).json({ success: true, conversation });
  } catch (error) {
    console.error('Create conversation error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Send a message
// @route   POST /api/messages
const sendMessage = async (req, res) => {
  try {
    const { conversationId, content, type } = req.body;

    if (!conversationId) {
      return res.status(400).json({ message: 'Conversation ID is required.' });
    }

    if (!content && (!req.file)) {
      return res.status(400).json({ message: 'Message content is required.' });
    }

    const conversation = await Conversation.findById(conversationId);
    if (!conversation) {
      return res.status(404).json({ message: 'Conversation not found.' });
    }

    if (!conversation.participants.some((p) => p.toString() === req.user._id.toString())) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const messageData = {
      conversation: conversationId,
      sender: req.user._id,
      content: content || '',
      type: type || 'text',
      readBy: [req.user._id],
    };

    // Handle file upload
    if (req.file) {
      const folder = req.file.mimetype.startsWith('image')
        ? 'ShortJob/chat-images'
        : 'ShortJob/chat-files';

      const result = await uploadToCloudinary(req.file, folder);
      messageData.fileUrl = result.secure_url;
      messageData.filePublicId = result.public_id;
      messageData.fileName = req.file.originalname;
      messageData.type = req.file.mimetype.startsWith('image') ? 'image' : 'file';
    }

    const message = await Message.create(messageData);

    // Update conversation's last message
    conversation.lastMessage = message.content || (message.fileName || 'File');
    conversation.lastMessageTime = message.createdAt;
    conversation.lastMessageSender = req.user._id;

    // Update unread counts for other participants
    for (const participantId of conversation.participants) {
      const pId = participantId.toString();
      if (pId !== req.user._id.toString()) {
        const currentCount = conversation.unreadCounts?.get(pId) || 0;
        conversation.unreadCounts.set(pId, currentCount + 1);
      }
    }

    await conversation.save();

    const populatedMessage = await Message.findById(message._id)
      .populate('sender', 'name profilePic openToOpportunities profileThemeVariant');

    // Emit socket events
    try {
      const io = getIO();
      const recipientId = conversation.participants.find(
        (p) => p.toString() !== req.user._id.toString()
      );

      // Emit to conversation room (for active chat display)
      io.to(conversationId).emit('receive_message', populatedMessage);

      // Emit notification to recipient's personal room (for badge counter and toast)
      if (recipientId) {
        io.to(recipientId.toString()).emit('notification', {
          type: 'new_message',
          message: `New message from ${req.user.name}`,
          sender: { _id: req.user._id, name: req.user.name },
          link: `/chat`,
        });
      }
    } catch (socketErr) {
      // Socket not available
    }

    res.status(201).json({ success: true, message: populatedMessage });
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Mark message as read
// @route   PUT /api/messages/:id/read
const markAsRead = async (req, res) => {
  try {
    const message = await Message.findById(req.params.id);

    if (!message) {
      return res.status(404).json({ message: 'Message not found.' });
    }

    if (!message.readBy.includes(req.user._id)) {
      message.readBy.push(req.user._id);
      await message.save();
    }

    // Reset unread count in conversation
    const conversation = await Conversation.findById(message.conversation);
    if (conversation) {
      conversation.unreadCounts.set(req.user._id.toString(), 0);
      await conversation.save();
    }

    res.json({ success: true, message: 'Marked as read.' });
  } catch (error) {
    console.error('Mark as read error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    F15 — React to a message
// @route   POST /api/messages/:id/react
const reactToMessage = async (req, res) => {
  try {
    const { emoji } = req.body;
    const ALLOWED_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];

    if (!emoji || !ALLOWED_REACTIONS.includes(emoji)) {
      return res.status(400).json({ message: 'Invalid emoji reaction.' });
    }

    const message = await Message.findById(req.params.id);
    if (!message) {
      return res.status(404).json({ message: 'Message not found.' });
    }

    // Verify user is a conversation participant
    const conversation = await Conversation.findById(message.conversation);
    if (!conversation || !conversation.participants.some(p => p.toString() === req.user._id.toString())) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    // Find existing reaction with this emoji
    let existingReaction = message.reactions.find(r => r.emoji === emoji);

    if (existingReaction) {
      // Check if user already reacted with this emoji
      const userIndex = existingReaction.reactedBy.findIndex(
        uid => uid.toString() === req.user._id.toString()
      );

      if (userIndex > -1) {
        // Remove user's reaction (toggle off)
        existingReaction.reactedBy.splice(userIndex, 1);
        if (existingReaction.reactedBy.length === 0) {
          message.reactions = message.reactions.filter(r => r.emoji !== emoji);
        }
      } else {
        // Add user's reaction
        existingReaction.reactedBy.push(req.user._id);
      }
    } else {
      // Create new reaction
      message.reactions.push({
        emoji,
        reactedBy: [req.user._id],
      });
    }

    await message.save();

    // Emit via Socket.io
    try {
      const io = getIO();
      io.to(message.conversation.toString()).emit('message_reaction', {
        messageId: message._id,
        reactions: message.reactions,
      });
    } catch (socketErr) {}

    res.json({ success: true, reactions: message.reactions });
  } catch (error) {
    console.error('React to message error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Update/edit a message
// @route   PUT /api/messages/:id
const updateMessage = async (req, res) => {
  try {
    const { content } = req.body;
    if (!content || !content.trim()) {
      return res.status(400).json({ message: 'Message content is required.' });
    }

    const message = await Message.findById(req.params.id);
    if (!message) {
      return res.status(404).json({ message: 'Message not found.' });
    }

    // Only the sender can edit their message
    if (message.sender.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'You can only edit your own messages.' });
    }

    // Only text messages can be edited
    if (message.type !== 'text') {
      return res.status(400).json({ message: 'Only text messages can be edited.' });
    }

    message.content = content.trim();
    message.editedAt = new Date();
    await message.save();

    const populatedMessage = await Message.findById(message._id)
      .populate('sender', 'name profilePic openToOpportunities profileThemeVariant');

    // Emit socket event for real-time update
    try {
      const io = getIO();
      io.to(message.conversation.toString()).emit('message_updated', populatedMessage);
    } catch (socketErr) {}

    res.json({ success: true, message: populatedMessage });
  } catch (error) {
    console.error('Update message error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Delete a message (soft delete)
// @route   DELETE /api/messages/:id
const deleteMessage = async (req, res) => {
  try {
    const message = await Message.findById(req.params.id);
    if (!message) {
      return res.status(404).json({ message: 'Message not found.' });
    }

    // Only the sender can delete their message
    if (message.sender.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'You can only delete your own messages.' });
    }

    // Soft delete - replace content with deletion notice
    message.content = 'This message was deleted';
    message.type = 'deleted';
    message.deletedAt = new Date();
    await message.save();

    // Emit socket event for real-time deletion
    try {
      const io = getIO();
      io.to(message.conversation.toString()).emit('message_deleted', {
        messageId: message._id,
        conversationId: message.conversation,
      });
    } catch (socketErr) {}

    res.json({ success: true, message: 'Message deleted.' });
  } catch (error) {
    console.error('Delete message error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Clear all messages in a conversation (for current user — soft delete)
// @route   DELETE /api/conversations/:id/clear
const clearConversation = async (req, res) => {
  try {
    const { id } = req.params;

    const conversation = await Conversation.findById(id);
    if (!conversation) {
      return res.status(404).json({ message: 'Conversation not found.' });
    }

    // Verify user is a participant
    if (!conversation.participants.some(p => p.toString() === req.user._id.toString())) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    // Soft delete all text messages in this conversation by the current user
    // or hard delete all messages (clear conversation entirely)
    await Message.deleteMany({ conversation: id });

    // Reset conversation last message
    conversation.lastMessage = '';
    conversation.lastMessageTime = null;
    conversation.lastMessageSender = undefined;
    await conversation.save();

    // Emit socket event
    try {
      const io = getIO();
      io.to(id).emit('conversation_cleared', { conversationId: id });
    } catch (socketErr) {}

    res.json({ success: true, message: 'Conversation cleared.' });
  } catch (error) {
    console.error('Clear conversation error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Delete entire conversation (for current user — remove from their list)
// @route   DELETE /api/conversations/:id
const deleteConversation = async (req, res) => {
  try {
    const { id } = req.params;

    const conversation = await Conversation.findById(id);
    if (!conversation) {
      return res.status(404).json({ message: 'Conversation not found.' });
    }

    // Verify user is a participant
    if (!conversation.participants.some(p => p.toString() === req.user._id.toString())) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    // Delete all messages in the conversation
    await Message.deleteMany({ conversation: id });

    // Delete the conversation itself
    await Conversation.findByIdAndDelete(id);

    // Emit socket event
    try {
      const io = getIO();
      io.to(id).emit('conversation_deleted', { conversationId: id });
    } catch (socketErr) {}

    res.json({ success: true, message: 'Conversation deleted.' });
  } catch (error) {
    console.error('Delete conversation error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

module.exports = {
  getConversations,
  getMessages,
  createConversation,
  sendMessage,
  markAsRead,
  reactToMessage,
  updateMessage,
  deleteMessage,
  clearConversation,
  deleteConversation,
};
