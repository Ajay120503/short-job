const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const { getIO, getOnlineUsers } = require('../config/socket');
const { uploadToCloudinary, deleteFromCloudinary } = require('../middlewares/upload.middleware');

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

const getMapDateValue = (mapValue, key) => {
  if (!mapValue) return null;
  const value =
    typeof mapValue.get === 'function'
      ? mapValue.get(key)
      : mapValue[key];
  return value ? new Date(value) : null;
};

const getConversationVisibleAfter = (conversation, userId) => {
  const key = userId.toString();
  const clearedAt = getMapDateValue(conversation.clearedAtBy, key);
  const deletedAt = getMapDateValue(conversation.deletedAtBy, key);
  const dates = [clearedAt, deletedAt].filter((date) => date && !Number.isNaN(date.getTime()));
  if (!dates.length) return null;
  return new Date(Math.max(...dates.map((date) => date.getTime())));
};

const getVisibleMessageFilter = (conversation, userId) => {
  const filter = { conversation: conversation._id };
  const visibleAfter = getConversationVisibleAfter(conversation, userId);
  if (visibleAfter) {
    filter.createdAt = { $gt: visibleAfter };
  }
  return filter;
};

// @desc    Get all conversations for a user
// @route   GET /api/conversations
const getConversations = async (req, res) => {
  try {
    const conversations = await Conversation.find({
      participants: req.user._id,
    })
      .populate('participants', 'name profilePic role category institutionName openToOpportunities badges isAdmin isSuperAdmin lastActiveAt activeDays followers profileThemeVariant showOnlineStatus')
      .populate('lastMessageSender', 'name')
      .sort({ updatedAt: -1 });

    // Add online status info
    const onlineUsers = getOnlineUsers();
    const seenParticipants = new Set();
    const conversationsWithStatus = [];

    for (const conv of conversations) {
      const otherParticipant = conv.participants.find(
        (p) => p._id.toString() !== req.user._id.toString()
      );
      const otherId = otherParticipant?._id?.toString();
      if (!otherId || seenParticipants.has(otherId)) continue;

      const visibleAfter = getConversationVisibleAfter(conv, req.user._id);
      const visibleLastMessage = await Message.findOne(getVisibleMessageFilter(conv, req.user._id))
        .sort({ createdAt: -1 })
        .select('content fileName type sender createdAt');
      const deletedForUser = getMapDateValue(
        conv.deletedAtBy,
        req.user._id.toString()
      );
      if (deletedForUser && !visibleLastMessage) continue;

      seenParticipants.add(otherId);

      const unreadCounts = normalizeUnreadCounts(conv);
      if (visibleAfter) {
        unreadCounts[req.user._id.toString()] = 0;
      }

      conversationsWithStatus.push({
        ...conv.toObject(),
        lastMessage: visibleLastMessage
          ? visibleLastMessage.content || visibleLastMessage.fileName || 'File'
          : '',
        lastMessageTime: visibleLastMessage?.createdAt || null,
        lastMessageSender: visibleLastMessage?.sender || undefined,
        unreadCounts,
        otherParticipant,
        isOnline:
          req.user.showOnlineStatus !== false &&
          otherParticipant?.showOnlineStatus !== false &&
          onlineUsers.has(otherParticipant?._id.toString()),
      });
    }

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

    const messageFilter = getVisibleMessageFilter(conversation, req.user._id);
    const messages = await Message.find(messageFilter)
      .populate('sender', 'name profilePic role category institutionName openToOpportunities badges isAdmin isSuperAdmin lastActiveAt activeDays followers profileThemeVariant showOnlineStatus')
      .populate({ path: 'replyTo', select: 'content type fileName sender', populate: { path: 'sender', select: 'name' } })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await Message.countDocuments(messageFilter);
    const unreadIds = messages
      .filter((message) => {
        const senderId = message.sender?._id || message.sender;
        return senderId && senderId.toString() !== req.user._id.toString();
      })
      .map((message) => message._id);
    if (unreadIds.length) {
      await Message.updateMany(
        { _id: { $in: unreadIds } },
        { $addToSet: { readBy: req.user._id, deliveredTo: req.user._id } }
      );
      messages.forEach((message) => {
        if (!(message.readBy || []).some((id) => id.toString() === req.user._id.toString())) message.readBy.push(req.user._id);
        if (!(message.deliveredTo || []).some((id) => id.toString() === req.user._id.toString())) message.deliveredTo.push(req.user._id);
      });
      await Conversation.updateOne(
        { _id: conversation._id },
        { $set: { [`unreadCounts.${req.user._id.toString()}`]: 0 } }
      );
      try {
        getIO().to(id).emit('messages_read', { messageIds: unreadIds, userId: req.user._id });
      } catch (_) { /* Socket may be unavailable in tests. */ }
    }

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
        .populate('participants', 'name profilePic role category institutionName openToOpportunities badges isAdmin isSuperAdmin lastActiveAt activeDays followers profileThemeVariant showOnlineStatus');

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
        .populate('participants', 'name profilePic role category institutionName openToOpportunities badges isAdmin isSuperAdmin lastActiveAt activeDays followers profileThemeVariant showOnlineStatus');
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
    const { conversationId, content, type, replyTo } = req.body;

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

    if (replyTo) {
      const repliedMessage = await Message.findOne({ _id: replyTo, conversation: conversationId });
      if (!repliedMessage) {
        return res.status(400).json({ message: 'The replied message is not part of this conversation.' });
      }
    }

    const messageData = {
      conversation: conversationId,
      sender: req.user._id,
      content: content || '',
      type: type || 'text',
      readBy: [req.user._id],
      deliveredTo: [req.user._id],
      replyTo: replyTo || null,
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
      messageData.fileMimeType = req.file.mimetype;
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

    const recipientId = conversation.participants.find(
      (participant) => participant.toString() !== req.user._id.toString()
    );
    if (recipientId && getOnlineUsers().has(recipientId.toString())) {
      message.deliveredTo.addToSet(recipientId);
      await message.save();
    }

    const populatedMessage = await Message.findById(message._id)
      .populate('sender', 'name profilePic role category institutionName openToOpportunities badges isAdmin isSuperAdmin lastActiveAt activeDays followers profileThemeVariant showOnlineStatus')
      .populate({ path: 'replyTo', select: 'content type fileName sender', populate: { path: 'sender', select: 'name' } });

    // Emit socket events
    try {
      const io = getIO();
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

    const conversation = await Conversation.findById(message.conversation);
    if (!conversation?.participants.some((participant) => participant.toString() === req.user._id.toString())) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    let changed = false;
    if (!message.readBy.some((id) => id.toString() === req.user._id.toString())) {
      message.readBy.push(req.user._id);
      changed = true;
    }
    if (!message.deliveredTo.some((id) => id.toString() === req.user._id.toString())) {
      message.deliveredTo.push(req.user._id);
      changed = true;
    }
    if (changed) await message.save();

    // Reset unread count in conversation
    if (conversation) {
      await Conversation.updateOne(
        { _id: conversation._id },
        { $set: { [`unreadCounts.${req.user._id.toString()}`]: 0 } }
      );
    }

    try {
      getIO().to(message.conversation.toString()).emit('message_read', {
        messageId: message._id,
        userId: req.user._id,
      });
    } catch (_) { /* Socket may be unavailable in tests. */ }
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

    const userId = req.user._id;
    const alreadyReacted = message.reactions.some(
      (reaction) => reaction.emoji === emoji
        && reaction.reactedBy.some((id) => id.toString() === userId.toString())
    );

    if (alreadyReacted) {
      await Message.updateOne(
        { _id: message._id },
        [{
          $set: {
            reactions: {
              $filter: {
                input: {
                  $map: {
                    input: { $ifNull: ['$reactions', []] },
                    as: 'reaction',
                    in: {
                      $cond: [
                        { $eq: ['$$reaction.emoji', emoji] },
                        {
                          $mergeObjects: [
                            '$$reaction',
                            {
                              reactedBy: {
                                $filter: {
                                  input: { $ifNull: ['$$reaction.reactedBy', []] },
                                  as: 'reactedUser',
                                  cond: { $ne: ['$$reactedUser', userId] },
                                },
                              },
                            },
                          ],
                        },
                        '$$reaction',
                      ],
                    },
                  },
                },
                as: 'reaction',
                cond: { $gt: [{ $size: { $ifNull: ['$$reaction.reactedBy', []] } }, 0] },
              },
            },
          },
        }],
        { updatePipeline: true }
      );
    } else {
      await Message.updateOne(
        { _id: message._id },
        [{
          $set: {
            reactions: {
              $cond: [
                {
                  $in: [
                    emoji,
                    {
                      $map: {
                        input: { $ifNull: ['$reactions', []] },
                        as: 'reaction',
                        in: '$$reaction.emoji',
                      },
                    },
                  ],
                },
                {
                  $map: {
                    input: { $ifNull: ['$reactions', []] },
                    as: 'reaction',
                    in: {
                      $cond: [
                        { $eq: ['$$reaction.emoji', emoji] },
                        {
                          $mergeObjects: [
                            '$$reaction',
                            { reactedBy: { $setUnion: [{ $ifNull: ['$$reaction.reactedBy', []] }, [userId]] } },
                          ],
                        },
                        '$$reaction',
                      ],
                    },
                  },
                },
                { $concatArrays: [{ $ifNull: ['$reactions', []] }, [{ emoji, reactedBy: [userId] }]] },
              ],
            },
          },
        }],
        { updatePipeline: true }
      );
    }

    const updatedMessage = await Message.findById(message._id).select('reactions conversation');

    // Emit via Socket.io
    try {
      const io = getIO();
      io.to(updatedMessage.conversation.toString()).emit('message_reaction', {
        messageId: updatedMessage._id,
        reactions: updatedMessage.reactions,
      });
    } catch (socketErr) {}

    res.json({ success: true, reactions: updatedMessage.reactions });
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
      .populate('sender', 'name profilePic role category institutionName openToOpportunities badges isAdmin isSuperAdmin lastActiveAt activeDays followers profileThemeVariant showOnlineStatus');

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
    if (message.filePublicId || message.fileUrl) {
      await deleteFromCloudinary(message.filePublicId || message.fileUrl);
    }
    message.content = 'This message was deleted';
    message.type = 'deleted';
    message.fileUrl = '';
    message.filePublicId = '';
    message.fileName = '';
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

    const userId = req.user._id.toString();
    conversation.clearedAtBy = conversation.clearedAtBy || new Map();
    conversation.clearedAtBy.set(userId, new Date());
    conversation.unreadCounts = conversation.unreadCounts || new Map();
    conversation.unreadCounts.set(userId, 0);
    await conversation.save();

    try {
      const io = getIO();
      io.to(userId).emit('conversation_cleared', { conversationId: id });
    } catch (socketErr) {}

    res.json({ success: true, message: 'Chat cleared for you.' });
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

    const userId = req.user._id.toString();
    conversation.deletedAtBy = conversation.deletedAtBy || new Map();
    conversation.deletedAtBy.set(userId, new Date());
    conversation.unreadCounts = conversation.unreadCounts || new Map();
    conversation.unreadCounts.set(userId, 0);
    await conversation.save();

    try {
      const io = getIO();
      io.to(userId).emit('conversation_deleted', { conversationId: id });
    } catch (socketErr) {}

    res.json({ success: true, message: 'Conversation deleted for you.' });
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
