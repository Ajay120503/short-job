const User = require('../models/User');
const Post = require('../models/Post');
const JobPost = require('../models/JobPost');
const Story = require('../models/Story');
const LoginRecord = require('../models/LoginRecord');
const Application = require('../models/Application');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Comment = require('../models/Comment');
const Notification = require('../models/Notification');
const { deleteFromCloudinary } = require('../middlewares/upload.middleware');
const { collectUserCloudinaryAssets, deleteCloudinaryAssets } = require('../utils/cloudinaryCleanup');
const { getIO } = require('../config/socket');
const {
  getAdminSettings: readAdminSettings,
  updateAdminSettings: saveAdminSettings,
} = require('../utils/adminSettings');
const { runFakeDetectionRuleOnly } = require('../utils/fakeDetectionRuleOnly');

const CONTENT_MODELS = {
  post: { Model: Post, authorField: 'author', populate: 'author' },
  job: { Model: JobPost, authorField: 'postedBy', populate: 'postedBy' },
  story: { Model: Story, authorField: 'author', populate: 'author' },
};

const getContentConfig = (type) => CONTENT_MODELS[type];

const getContentTitle = (type, content) => {
  if (type === 'job') return content.title || 'your job post';
  if (type === 'story') return content.text ? 'your story' : 'your story';
  return content.text ? `"${content.text.slice(0, 60)}${content.text.length > 60 ? '...' : ''}"` : 'your post';
};

const getContentLink = (type, content) => {
  if (type === 'job') return `/jobs/${content._id}`;
  if (type === 'post') return `/post/${content._id}`;
  return '/feed';
};

const notifyModerationDecision = async ({ type, content, config, status, reason }) => {
  const recipient = content[config.authorField];
  const approved = status === 'approved';
  const notification = await Notification.create({
    recipient,
    sender: null,
    type: approved ? 'content_approved' : 'content_rejected',
    message: approved
      ? `Admin approved ${getContentTitle(type, content)}. It is now public.`
      : `Admin rejected ${getContentTitle(type, content)}.${reason ? ` Reason: ${reason}` : ''}`,
    link: getContentLink(type, content),
  });

  const io = getIO();
  io.to(recipient.toString()).emit('notification', {
    _id: notification._id,
    type: notification.type,
    message: notification.message,
    link: notification.link,
    isRead: false,
    createdAt: notification.createdAt,
  });

  io.to(recipient.toString()).emit(approved ? 'content_approved' : 'content_rejected', {
    type,
    id: content._id,
    reason,
  });
};

const syncLinkedJobFeedPost = async (type, content, status, moderationMeta) => {
  if (type === 'job') {
    await Post.updateMany(
      { jobPost: content._id },
      { status, moderationMeta }
    );
  }

  if (type === 'post' && content.jobPost) {
    await JobPost.findByIdAndUpdate(content.jobPost, { status, moderationMeta });
  }
};

const syncUserTrustStatus = (user) => {
  const activeTrustBadges = new Set(
    (user.badges || [])
      .filter((badge) => badge.isActive !== false)
      .map((badge) => badge.type)
  );

  user.isEmailVerified = activeTrustBadges.has('email_verified');
  user.isPhoneVerified = activeTrustBadges.has('phone_verified');

  if (activeTrustBadges.has('platform_owner')) {
    user.isVerified = true;
    user.verifiedStatus = 'platform_owner';
    return;
  }

  if (activeTrustBadges.has('verified_institution')) {
    user.isVerified = true;
    user.verifiedStatus = 'institution';
    return;
  }

  if (activeTrustBadges.has('top_contributor')) {
    user.isVerified = true;
    user.verifiedStatus = 'top_contributor';
    return;
  }

  if (activeTrustBadges.has('email_verified')) {
    user.isVerified = true;
    user.verifiedStatus = 'email';
    return;
  }

  user.isVerified = false;
  user.verifiedStatus = 'none';
};

const isSameUser = (a, b) => a?.toString?.() === b?.toString?.();

const ensureCanMutateUser = async (req, targetUser, action) => {
  if (!targetUser) {
    return { allowed: false, status: 404, message: 'User not found.' };
  }

  if (isSameUser(req.user?._id, targetUser._id) && ['block', 'delete'].includes(action)) {
    return {
      allowed: false,
      status: 400,
      message: `You cannot ${action} your own admin account.`,
    };
  }

  if (targetUser.isSuperAdmin && !isSameUser(req.user?._id, targetUser._id)) {
    return {
      allowed: false,
      status: 403,
      message: 'Super admin accounts cannot be modified by another admin.',
    };
  }

  return { allowed: true };
};

const TRUST_BADGE_TYPES = [
  'verified_institution',
  'top_contributor',
  'email_verified',
  'phone_verified',
  'platform_owner',
];

const respondIfDenied = (res, permission) => {
  if (permission.allowed) return false;
  res.status(permission.status).json({ message: permission.message });
  return true;
};

// @desc    Get all users (admin)
// @route   GET /api/admin/users
const getAllUsers = async (req, res) => {
  try {
    const { search, status, category } = req.query;
    const query = {};

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { institutionName: { $regex: search, $options: 'i' } },
      ];
    }
    if (category) {
      query.$or = [
        { category },
        { badges: { $elemMatch: { type: category, isActive: { $ne: false } } } },
      ];
    }
    if (status === 'blocked') query.isBlocked = true;
    if (status === 'verified') query.isVerified = true;
    if (status === 'unverified') query.isVerified = { $ne: true };

    const users = await User.find(query).select('-password -verificationToken -resetPasswordToken -otp');
    res.json({ success: true, users });
  } catch (error) {
    console.error('Get all users error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Get single user detail (admin)
// @route   GET /api/admin/users/:id
const getUserDetail = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password -verificationToken -resetPasswordToken');
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }
    res.json({ success: true, user });
  } catch (error) {
    console.error('Get user detail error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Block/unblock user (admin)
// @route   PUT /api/admin/users/:id/block
const blockUser = async (req, res) => {
  try {
    const body = req.body || {};
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const permission = await ensureCanMutateUser(req, user, 'block');
    if (respondIfDenied(res, permission)) return;

    user.isBlocked = true;
    user.blockedAt = new Date();
    user.blockedReason = body.reason || 'Violated community guidelines';
    user.adminNotes = body.notes || user.adminNotes || '';
    await user.save();

    res.json({ success: true, user });
  } catch (error) {
    console.error('Block user error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Unblock user (admin)
// @route   PUT /api/admin/users/:id/unblock
const unblockUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const permission = await ensureCanMutateUser(req, user, 'unblock');
    if (respondIfDenied(res, permission)) return;

    user.isBlocked = false;
    user.blockedAt = null;
    user.blockedReason = null;
    await user.save();

    res.json({ success: true, user });
  } catch (error) {
    console.error('Unblock user error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Update admin notes
// @route   PUT /api/admin/users/:id/notes
const updateUserNotes = async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { adminNotes: req.body?.notes || '' },
      { returnDocument: 'after' }
    ).select('-password -verificationToken -resetPasswordToken -otp');

    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    res.json({ success: true, user });
  } catch (error) {
    console.error('Update user notes error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Delete user (admin)
// @route   DELETE /api/admin/users/:id
const deleteUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const permission = await ensureCanMutateUser(req, user, 'delete');
    if (respondIfDenied(res, permission)) return;

    const userJobIds = await JobPost.find({ postedBy: user._id }).distinct('_id');
    const conversationIds = await Conversation.find({ participants: user._id }).distinct('_id');
    const assets = await collectUserCloudinaryAssets(user._id);
    await deleteCloudinaryAssets(assets);

    await Promise.all([
      User.findByIdAndDelete(user._id),
      Post.deleteMany({ author: user._id }),
      JobPost.deleteMany({ postedBy: user._id }),
      Story.deleteMany({ author: user._id }),
      Application.deleteMany({ $or: [{ applicant: user._id }, { jobPost: { $in: userJobIds } }] }),
      LoginRecord.deleteMany({ user: user._id }),
      Conversation.deleteMany({ participants: user._id }),
      Message.deleteMany({ $or: [{ sender: user._id }, { conversation: { $in: conversationIds } }] }),
      Comment.deleteMany({ author: user._id }),
      Notification.deleteMany({ $or: [{ recipient: user._id }, { sender: user._id }] }),
      User.updateMany({ followers: user._id }, { $pull: { followers: user._id } }),
      User.updateMany({ following: user._id }, { $pull: { following: user._id } }),
    ]);

    res.json({ success: true, message: 'User deleted.' });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Grant badge to user (admin)
// @route   PUT /api/admin/users/:id/grant-badge
const grantBadge = async (req, res) => {
  try {
    const body = req.body || {};
    const { badgeType } = body;
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const permission = await ensureCanMutateUser(req, user, 'grant badge to');
    if (respondIfDenied(res, permission)) return;

    if (!TRUST_BADGE_TYPES.includes(badgeType)) {
      return res.status(400).json({ message: 'Invalid trust badge type.' });
    }

    // Check if badge already granted
    const existingBadgeIndex = user.badges.findIndex(
      (b) => b.type === badgeType && b.isActive
    );

    if (existingBadgeIndex >= 0) {
      return res.status(400).json({ message: 'Badge already granted.' });
    }

    // Add badge
    user.badges.push({
      type: badgeType,
      grantedBy: 'admin',
      grantedAt: new Date(),
      isActive: true,
    });

    syncUserTrustStatus(user);
    await user.save();

    res.json({ success: true, user });
  } catch (error) {
    console.error('Grant badge error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Promote a user to admin (super admin)
// @route   PUT /api/admin/users/:id/make-admin
const makeAdmin = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const permission = await ensureCanMutateUser(req, user, 'make admin');
    if (respondIfDenied(res, permission)) return;

    user.isAdmin = true;
    await user.save();

    res.json({ success: true, user, message: 'User promoted to admin.' });
  } catch (error) {
    console.error('Make admin error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Remove admin access from a user (super admin)
// @route   PUT /api/admin/users/:id/remove-admin
const removeAdmin = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const permission = await ensureCanMutateUser(req, user, 'remove admin from');
    if (respondIfDenied(res, permission)) return;

    user.isAdmin = false;
    await user.save();

    res.json({ success: true, user, message: 'Admin access removed.' });
  } catch (error) {
    console.error('Remove admin error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Revoke badge from user (admin)
// @route   PUT /api/admin/users/:id/revoke-badge
const revokeBadge = async (req, res) => {
  try {
    const body = req.body || {};
    const { badgeType } = body;
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const permission = await ensureCanMutateUser(req, user, 'revoke badge from');
    if (respondIfDenied(res, permission)) return;

    const badgeIndex = user.badges.findIndex(
      (b) => b.type === badgeType && b.isActive
    );

    if (badgeIndex < 0) {
      return res.status(400).json({ message: 'Badge not found on this user.' });
    }

    user.badges[badgeIndex].isActive = false;
    syncUserTrustStatus(user);
    await user.save();

    res.json({ success: true, user });
  } catch (error) {
    console.error('Revoke badge error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Get moderation queue (admin)
// @route   GET /api/admin/queue
const getModerationQueue = async (req, res) => {
  try {
    const { type } = req.query;

    const types = type ? [type] : Object.keys(CONTENT_MODELS);
    const invalidType = types.find((itemType) => !CONTENT_MODELS[itemType]);
    if (invalidType) {
      return res.status(400).json({ message: 'Invalid content type.' });
    }

    const results = await Promise.all(
      types.map(async (itemType) => {
        const config = CONTENT_MODELS[itemType];
        const reviewStatusQuery = {
          $or: [
            { status: 'pending_review' },
            { status: 'rejected', 'moderationMeta.reviewMethod': 'auto_rejected' },
          ],
        };
        const query = itemType === 'post'
          ? {
              $and: [
                reviewStatusQuery,
                {
                  $or: [
                    { type: { $ne: 'job' } },
                    { jobPost: null },
                    { jobPost: { $exists: false } },
                  ],
                },
              ],
            }
          : reviewStatusQuery;
        const docs = await config.Model.find(query)
          .populate(config.populate, 'name email profilePic badges category institutionName openToOpportunities isAdmin isSuperAdmin lastActiveAt activeDays followers profileThemeVariant')
          .sort({ createdAt: 1 });
        return docs.map((doc) => ({ ...doc.toObject(), contentType: itemType }));
      })
    );

    const items = results.flat().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    res.json({ success: true, items });
  } catch (error) {
    console.error('Get moderation queue error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Get content detail (admin)
// @route   GET /api/admin/content/:type/:id
const getContentDetail = async (req, res) => {
  try {
    const config = getContentConfig(req.params.type);
    if (!config) {
      return res.status(400).json({ message: 'Invalid content type.' });
    }

    const content = await config.Model.findById(req.params.id)
      .populate(config.populate, 'name email profilePic badges category institutionName openToOpportunities isAdmin isSuperAdmin lastActiveAt activeDays followers profileThemeVariant');

    if (!content) {
      return res.status(404).json({ message: 'Content not found.' });
    }

    res.json({ success: true, content });
  } catch (error) {
    console.error('Get content detail error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Approve content (admin)
// @route   PUT /api/admin/content/:type/:id/approve
const approveContent = async (req, res) => {
  try {
    const { type, id } = req.params;
    const body = req.body || {};

    const config = getContentConfig(type);
    if (!config) {
      return res.status(400).json({ message: 'Invalid content type.' });
    }

    const content = await config.Model.findById(id);

    if (!content) {
      return res.status(404).json({ message: 'Content not found.' });
    }

    content.status = 'approved';
    content.moderationMeta = {
      reviewedBy: req.user._id,
      reviewedAt: new Date(),
      reviewMethod: 'admin_manual',
      reviewNotes: body.notes || 'Manually approved',
    };
    await content.save();
    await syncLinkedJobFeedPost(type, content, content.status, content.moderationMeta);

    // Notify content creator
    try {
      const settings = await readAdminSettings();
      if (settings.notifyCreators) {
        await notifyModerationDecision({
          type,
          content,
          config,
          status: 'approved',
        });
      }
    } catch (socketErr) {}

    res.json({ success: true, content });
  } catch (error) {
    console.error('Approve content error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Reject content (admin)
// @route   PUT /api/admin/content/:type/:id/reject
const rejectContent = async (req, res) => {
  try {
    const { type, id } = req.params;
    const body = req.body || {};

    const config = getContentConfig(type);
    if (!config) {
      return res.status(400).json({ message: 'Invalid content type.' });
    }

    const settings = await readAdminSettings();
    if (settings.requireRejectReason && !body.notes?.trim()) {
      return res.status(400).json({ message: 'Rejection notes are required by admin settings.' });
    }

    const content = await config.Model.findById(id);

    if (!content) {
      return res.status(404).json({ message: 'Content not found.' });
    }

    content.status = 'rejected';
    content.moderationMeta = {
      reviewedBy: req.user._id,
      reviewedAt: new Date(),
      reviewMethod: 'admin_manual',
      reviewNotes: body.notes || 'Manually rejected',
    };
    await content.save();
    await syncLinkedJobFeedPost(type, content, content.status, content.moderationMeta);

    // Notify content creator
    try {
      if (settings.notifyCreators) {
        await notifyModerationDecision({
          type,
          content,
          config,
          status: 'rejected',
          reason: body.notes,
        });
      }
    } catch (socketErr) {}

    res.json({ success: true, content });
  } catch (error) {
    console.error('Reject content error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Run rule-based moderation on one content item (admin)
// @route   PUT /api/admin/content/:type/:id/run-check
const runContentRuleCheck = async (req, res) => {
  try {
    const { type, id } = req.params;
    const config = getContentConfig(type);
    if (!config) {
      return res.status(400).json({ message: 'Invalid content type.' });
    }

    const content = await config.Model.findById(id);
    if (!content) {
      return res.status(404).json({ message: 'Content not found.' });
    }

    const result = await runFakeDetectionRuleOnly(content, type);
    content.status = result.approved ? 'approved' : 'rejected';
    content.moderationMeta = {
      ...(content.moderationMeta?.toObject?.() || content.moderationMeta || {}),
      reviewedBy: req.user._id,
      reviewedAt: new Date(),
      reviewMethod: result.approved ? 'auto_approved' : 'auto_rejected',
      reviewNotes: result.reason,
      autoScore: result.score,
      autoFlags: result.flags,
      autoReason: result.reason,
      autoDecision: result.decision,
      autoSeverity: result.severity,
      autoReviewedAt: new Date(),
    };

    await content.save();
    await syncLinkedJobFeedPost(type, content, content.status, content.moderationMeta);

    const settings = await readAdminSettings();
    if (settings.notifyCreators) {
      try {
        await notifyModerationDecision({
          type,
          content,
          config,
          status: content.status,
          reason: result.reason,
        });
      } catch (notifyErr) {}
    }

    res.json({ success: true, content, moderationResult: result });
  } catch (error) {
    console.error('Run content rule check error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Get admin settings
// @route   GET /api/admin/settings
const getAdminSettings = async (req, res) => {
  try {
    const settings = await readAdminSettings();
    res.json({ success: true, settings });
  } catch (error) {
    console.error('Get admin settings error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Update admin settings
// @route   PUT /api/admin/settings
const updateAdminSettings = async (req, res) => {
  try {
    const settings = await saveAdminSettings(req.body || {});
    res.json({ success: true, settings });
  } catch (error) {
    console.error('Update admin settings error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

const LOGIN_RECORD_USER_SELECT =
  'name email phone profilePic badges institutionName address city state isBlocked createdAt verifiedStatus isEmailVerified';

const buildLoginRecordFilter = async (query) => {
  const { userId, city, from, to, search } = query;
  const filter = {};

  if (userId) filter.user = userId;
  if (city) filter['location.city'] = new RegExp(city, 'i');
  if (from || to) {
    filter.loginAt = {};
    if (from) filter.loginAt.$gte = new Date(from);
    if (to) filter.loginAt.$lte = new Date(to);
  }

  if (search) {
    const matchedUsers = await User.find({
      $or: [
        { name: new RegExp(search, 'i') },
        { email: new RegExp(search, 'i') },
      ],
    }).select('_id');
    const ids = matchedUsers.map((user) => user._id);
    filter.user = userId ? filter.user : { $in: ids };
  }

  return filter;
};

// @desc    Get login audit records
// @route   GET /api/admin/login-records
const getLoginRecords = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
    const filter = await buildLoginRecordFilter(req.query);

    const [records, total] = await Promise.all([
      LoginRecord.find(filter)
        .populate('user', LOGIN_RECORD_USER_SELECT)
        .sort({ loginAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      LoginRecord.countDocuments(filter),
    ]);

    res.json({ success: true, records, total, page, pages: Math.ceil(total / limit) });
  } catch (error) {
    console.error('Get login records error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Get single login audit record
// @route   GET /api/admin/login-records/:id
const getLoginRecordDetail = async (req, res) => {
  try {
    const record = await LoginRecord.findById(req.params.id)
      .populate('user', LOGIN_RECORD_USER_SELECT);
    if (!record) {
      return res.status(404).json({ message: 'Login record not found.' });
    }
    res.json({ success: true, record });
  } catch (error) {
    console.error('Get login record detail error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Get all login audit records for one user
// @route   GET /api/admin/login-records/user/:userId
const getUserLoginRecords = async (req, res) => {
  try {
    const records = await LoginRecord.find({ user: req.params.userId })
      .populate('user', LOGIN_RECORD_USER_SELECT)
      .sort({ loginAt: -1 });
    res.json({ success: true, records });
  } catch (error) {
    console.error('Get user login records error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Delete any login audit record
// @route   DELETE /api/admin/login-records/:id
const deleteLoginRecord = async (req, res) => {
  try {
    const record = await LoginRecord.findById(req.params.id);
    if (!record) {
      return res.status(404).json({ message: 'Login record not found.' });
    }

    if (record.photo?.publicId) {
      await deleteFromCloudinary(record.photo.publicId);
    }
    await record.deleteOne();

    res.json({ success: true, message: 'Login record deleted.' });
  } catch (error) {
    console.error('Delete login record error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

module.exports = {
  getAllUsers,
  getUserDetail,
  blockUser,
  unblockUser,
  updateUserNotes,
  deleteUser,
  grantBadge,
  revokeBadge,
  makeAdmin,
  removeAdmin,
  getModerationQueue,
  getContentDetail,
  runContentRuleCheck,
  approveContent,
  rejectContent,
  getAdminSettings,
  updateAdminSettings,
  getLoginRecords,
  getLoginRecordDetail,
  getUserLoginRecords,
  deleteLoginRecord,
};
