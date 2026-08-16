const User = require('../models/User');
const Post = require('../models/Post');
const JobPost = require('../models/JobPost');
const Story = require('../models/Story');
const Notification = require('../models/Notification');
const { getIO } = require('../config/socket');
const {
  getAdminSettings: readAdminSettings,
  updateAdminSettings: saveAdminSettings,
} = require('../utils/adminSettings');

const CONTENT_MODELS = {
  post: { Model: Post, authorField: 'author', populate: 'author' },
  job: { Model: JobPost, authorField: 'postedBy', populate: 'postedBy' },
  story: { Model: Story, authorField: 'author', populate: 'author' },
};

const getContentConfig = (type) => CONTENT_MODELS[type];

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
    const user = await User.findByIdAndUpdate(req.params.id, {
      isBlocked: true,
      blockedAt: new Date(),
      blockedReason: body.reason || 'Violated community guidelines',
      adminNotes: body.notes || '',
    }, { returnDocument: 'after' });

    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

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
    const user = await User.findByIdAndUpdate(req.params.id, {
      isBlocked: false,
      blockedAt: null,
      blockedReason: null,
    }, { returnDocument: 'after' });

    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

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
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    await Promise.all([
      Post.deleteMany({ author: user._id }),
      JobPost.deleteMany({ postedBy: user._id }),
      Story.deleteMany({ author: user._id }),
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

    // Check if badge type is valid
    const validBadges = [
      'student', 'teacher', 'professor', 'principal', 'hod',
      'researcher', 'phd_scholar', 'lecturer',
      'school_member', 'college_member', 'university_member', 'coaching_member',
      'stem_expert', 'arts_expert', 'sports_coach', 'counselor',
      'verified_institution', 'top_contributor', 'email_verified', 'phone_verified'
    ];

    if (!validBadges.includes(badgeType)) {
      return res.status(400).json({ message: 'Invalid badge type.' });
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
        const query = itemType === 'post'
          ? { status: 'pending_review', type: { $ne: 'job' } }
          : { status: 'pending_review' };
        const docs = await config.Model.find(query)
          .populate(config.populate, 'name email profilePic badges category institutionName openToOpportunities')
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
      .populate(config.populate, 'name email profilePic badges category institutionName openToOpportunities');

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
        const io = getIO();
        io.to(`user_${content[config.authorField]}`).emit('content_approved', {
          type,
          id: content._id,
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
        const io = getIO();
        io.to(`user_${content[config.authorField]}`).emit('content_rejected', {
          type,
          id: content._id,
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

module.exports = {
  getAllUsers,
  getUserDetail,
  blockUser,
  unblockUser,
  updateUserNotes,
  deleteUser,
  grantBadge,
  revokeBadge,
  getModerationQueue,
  getContentDetail,
  approveContent,
  rejectContent,
  getAdminSettings,
  updateAdminSettings,
};
