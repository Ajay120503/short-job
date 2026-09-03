const User = require('../models/User');
const Post = require('../models/Post');
const JobPost = require('../models/JobPost');
const Notification = require('../models/Notification');
const LoginRecord = require('../models/LoginRecord');
const { getIO, getOnlineUsers } = require('../config/socket');
const { uploadToCloudinary, deleteFromCloudinary } = require('../middlewares/upload.middleware');

const SELF_BADGES = [
  'student', 'teacher', 'professor', 'principal', 'hod',
  'researcher', 'phd_scholar', 'lecturer',
  'school_member', 'college_member', 'university_member', 'coaching_member',
  'stem_expert', 'arts_expert', 'sports_coach', 'counselor',
];

const hasActiveBadge = (user, badgeType) =>
  (user.badges || []).some((badge) => badge.type === badgeType && badge.isActive !== false);

const canUseOpportunityStatus = (user) => Boolean(user);

const updateCurrentLocation = async (req, res) => {
  try {
    const lat = Number(req.body.lat);
    const lng = Number(req.body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({ message: 'Valid latitude and longitude are required.' });
    }

    let city = '';
    let state = '';
    try {
      const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}`, {
        headers: { 'User-Agent': 'ShorJob/1.0 (location@shorjob.app)' },
        signal: AbortSignal.timeout(7000),
      });
      if (response.ok) {
        const place = await response.json();
        city = place.address?.city || place.address?.town || place.address?.village || place.address?.district || '';
        state = place.address?.state || '';
      }
    } catch (_) { /* Coordinates are still useful if reverse geocoding is unavailable. */ }

    const currentLocation = { lat, lng, city, state, updatedAt: new Date() };
    await User.findByIdAndUpdate(req.user._id, { currentLocation });
    res.json({ success: true, currentLocation });
  } catch (error) {
    console.error('Update current location error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

const calculateAgeFromDate = (dateValue) => {
  if (!dateValue) return undefined;
  const birthDate = new Date(dateValue);
  if (Number.isNaN(birthDate.getTime()) || birthDate > new Date()) return undefined;

  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();
  if (
    monthDiff < 0 ||
    (monthDiff === 0 && today.getDate() < birthDate.getDate())
  ) {
    age -= 1;
  }
  return Math.max(age, 0);
};

// @desc    Get online user IDs for global presence indicators
// @route   GET /api/users/online
const getOnlineUserIds = async (req, res) => {
  try {
    if (req.user.showOnlineStatus === false) {
      return res.json({ success: true, onlineUserIds: [] });
    }

    const socketOnlineUserIds = Array.from(getOnlineUsers().keys());
    const visibleUsers = await User.find({
      _id: { $in: socketOnlineUserIds },
      showOnlineStatus: { $ne: false },
    }).select('_id');

    res.json({
      success: true,
      onlineUserIds: visibleUsers.map((user) => user._id.toString()),
    });
  } catch (error) {
    console.error('Get online users error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Get logged-in user's own login audit history
// @route   GET /api/users/me/login-history
const getMyLoginHistory = async (req, res) => {
  try {
    if (req.user.loginAuditEnabled === false) {
      return res.json({
        success: true,
        loginAuditEnabled: false,
        records: [],
        total: 0,
        page: 1,
        pages: 0,
      });
    }

    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 50);
    const skip = (page - 1) * limit;

    const filter = { user: req.user._id };
    const [records, total] = await Promise.all([
      LoginRecord.find(filter).sort({ loginAt: -1 }).skip(skip).limit(limit),
      LoginRecord.countDocuments(filter),
    ]);
    const unseenIds = records
      .filter((record) => !record.userSeenAt)
      .map((record) => record._id);

    if (unseenIds.length) {
      const seenAt = new Date();
      await LoginRecord.updateMany(
        { _id: { $in: unseenIds }, user: req.user._id, userSeenAt: { $exists: false } },
        { $set: { userSeenAt: seenAt } }
      );
      records.forEach((record) => {
        if (!record.userSeenAt) {
          record.userSeenAt = seenAt;
        }
      });
    }

    res.json({
      success: true,
      records,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (error) {
    console.error('Get login history error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Delete one of the logged-in user's own login records
// @route   DELETE /api/users/me/login-history/:id
const deleteMyLoginRecord = async (req, res) => {
  try {
    const record = await LoginRecord.findOne({
      _id: req.params.id,
      user: req.user._id,
    });

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

// @desc    Toggle logged-in user's login audit preference
// @route   PATCH /api/users/me/login-audit
const updateMyLoginAuditPreference = async (req, res) => {
  try {
    const loginAuditEnabled =
      req.body.loginAuditEnabled === true || req.body.loginAuditEnabled === 'true';

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { loginAuditEnabled },
      {
        returnDocument: 'after',
        runValidators: true,
      }
    ).select('-password -verificationToken -verificationTokenExpires -resetPasswordToken -resetPasswordExpires -otp');

    res.json({
      success: true,
      user,
      loginAuditEnabled: user.loginAuditEnabled,
      message: user.loginAuditEnabled
        ? 'Login audit enabled for your account.'
        : 'Login audit disabled for your account.',
    });
  } catch (error) {
    console.error('Update login audit preference error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

const canUseSpecialProfileStyle = (user) => {
  if (!user) return false;
  const activeDaysCount = Array.isArray(user.activeDays) ? user.activeDays.length : 0;
  const followerCount = Array.isArray(user.followers) ? user.followers.length : 0;

  let recentlyActive = false;
  if (user.lastActiveAt) {
    const lastActive = new Date(user.lastActiveAt).getTime();
    if (!Number.isNaN(lastActive)) {
      recentlyActive = Date.now() - lastActive <= 7 * 24 * 60 * 60 * 1000;
    }
  }

  return Boolean(
    user.isAdmin ||
      user.isSuperAdmin ||
      user.verifiedStatus === 'top_contributor' ||
      hasActiveBadge(user, 'top_contributor') ||
      followerCount >= 5 ||
      activeDaysCount >= 5 ||
      recentlyActive
  );
};

const isOwnerOrAdmin = (req, ownerId) =>
  req.user?._id?.toString() === ownerId?.toString() ||
  req.user?.isAdmin ||
  req.user?.role === 'admin' ||
  hasActiveBadge(req.user, 'admin') ||
  hasActiveBadge(req.user, 'moderator');

// @desc    Get user profile by ID
// @route   GET /api/users/:id
const getUserProfile = async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .select('-verificationToken -verificationTokenExpires -resetPasswordToken -resetPasswordExpires');

    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    res.json({ success: true, user });
  } catch (error) {
    console.error('Get user profile error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Update user profile
// @route   PUT /api/users/:id
const updateProfile = async (req, res) => {
  try {
    // Ensure user can only update their own profile
    if (req.user._id.toString() !== req.params.id) {
      return res.status(403).json({ message: 'You can only update your own profile.' });
    }

    const allowedFields = [
      'name', 'bio', 'age', 'dateOfBirth', 'educationLevel',
      'institutionName', 'institutionType', 'subject', 'experience',
      'address', 'city', 'state',
      'linkedinUrl', 'profession', 'isCurrentlyWorking',
      'currentPosition', 'currentCompany', 'previousWork',
      'profileThemeVariant', 'showOnlineStatus', 'loginAuditEnabled',
    ];

    const arrayFields = ['skills', 'qualifications', 'interests'];

    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        if (field === 'profileThemeVariant') {
          if (!canUseSpecialProfileStyle(req.user)) {
            return res.status(403).json({
              message: 'Your account does not have permission to customize the profile color yet.',
            });
          }
          const allowedVariants = ['teal', 'coral', 'emerald', 'amber', 'indigo', 'sky', 'deep-teal', 'rose', 'slate', 'violet', 'pink', 'premium'];
          if (!allowedVariants.includes(req.body[field])) {
            return res.status(400).json({ message: 'Invalid profile theme variant.' });
          }
          // Premium Gold is admin-only
          if (req.body[field] === 'premium' && !(req.user.isAdmin || req.user.isSuperAdmin)) {
            return res.status(403).json({ message: 'Premium Gold is reserved for platform admins only.' });
          }
        }
        updates[field] =
          field === 'isCurrentlyWorking' ||
          field === 'showOnlineStatus' ||
          field === 'loginAuditEnabled'
            ? req.body[field] === true || req.body[field] === 'true'
            : req.body[field];
      }
    }

    // Parse comma-separated string fields into arrays
    for (const field of arrayFields) {
      if (req.body[field] !== undefined) {
        const value = req.body[field];
        if (typeof value === 'string') {
          updates[field] = value.split(',').map(s => s.trim()).filter(Boolean);
        } else if (Array.isArray(value)) {
          updates[field] = value;
        }
      }
    }

    if (updates.dateOfBirth === '') {
      updates.dateOfBirth = undefined;
      updates.age = undefined;
    } else if (updates.dateOfBirth) {
      const calculatedAge = calculateAgeFromDate(updates.dateOfBirth);
      if (calculatedAge === undefined || calculatedAge < 18 || calculatedAge > 100) {
        return res.status(400).json({
          message: calculatedAge < 18
            ? 'You must be at least 18 years old to use ShortJob.'
            : 'Please provide a valid date of birth for an age between 18 and 100.',
          errors: { age: calculatedAge < 18 ? 'Minimum age is 18.' : 'Age must be between 18 and 100.' },
        });
      }
      updates.age = calculatedAge;
    } else if (updates.age === '') {
      updates.age = undefined;
    } else if (updates.age !== undefined) {
      const age = Number(updates.age);
      if (!Number.isFinite(age) || age < 18 || age > 100) {
        return res.status(400).json({
          message: 'Age must be between 18 and 100.',
          errors: { age: 'Age must be between 18 and 100.' },
        });
      }
      updates.age = age;
    }

    const oldProfilePicPublicId = req.user.profilePic?.publicId;
    const oldInstitutionPicPublicId = req.user.institutionPic?.publicId;
    const oldResumeUrl = req.user.resumeUrl;

    // Handle profile picture upload
    if (req.files?.profilePic?.[0]) {
      const result = await uploadToCloudinary(req.files.profilePic[0], 'ShortJob/profile-pics');
      updates.profilePic = { url: result.secure_url, publicId: result.public_id };
    }

    // Handle institution picture upload
    if (req.files?.institutionPic?.[0]) {
      const result = await uploadToCloudinary(req.files.institutionPic[0], 'ShortJob/institution-pics');
      updates.institutionPic = { url: result.secure_url, publicId: result.public_id };
    }

    // Handle resume upload
    if (req.files?.resume?.[0]) {
      const result = await uploadToCloudinary(req.files.resume[0], 'ShortJob/resumes');
      updates.resumeUrl = result.secure_url;
    }

    const user = await User.findByIdAndUpdate(req.params.id, updates, {
      returnDocument: 'after',
      runValidators: true,
    });

    if (updates.profilePic && oldProfilePicPublicId) {
      await deleteFromCloudinary(oldProfilePicPublicId);
    }

    if (updates.institutionPic) {
      await JobPost.updateMany(
        { postedBy: user._id },
        { institutionLogo: updates.institutionPic }
      );
      if (oldInstitutionPicPublicId) {
        await deleteFromCloudinary(oldInstitutionPicPublicId);
      }
    }

    if (updates.resumeUrl && oldResumeUrl) {
      await deleteFromCloudinary(oldResumeUrl);
    }

    if (
      Object.prototype.hasOwnProperty.call(updates, 'showOnlineStatus') &&
      updates.showOnlineStatus === false
    ) {
      try {
        getIO().emit('online_status', {
          userId: user._id.toString(),
          isOnline: false,
        });
      } catch (socketErr) {}
    }

    res.json({ success: true, user });
  } catch (error) {
    console.error('Update profile error:', error);
    if (error.name === 'ValidationError') {
      const errors = Object.fromEntries(
        Object.entries(error.errors || {}).map(([field, detail]) => [field, detail.message])
      );
      return res.status(400).json({
        message: Object.values(errors)[0] || 'Please correct the highlighted profile fields.',
        errors,
      });
    }
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Follow / Unfollow user
// @route   POST /api/users/:id/follow
const followUser = async (req, res) => {
  try {
    if (req.user._id.toString() === req.params.id) {
      return res.status(400).json({ message: 'You cannot follow yourself.' });
    }

    const userToFollow = await User.findById(req.params.id);
    const currentUser = await User.findById(req.user._id);

    if (!userToFollow) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const isFollowing = currentUser.following.includes(req.params.id);

    if (isFollowing) {
      // Unfollow
      currentUser.following.pull(req.params.id);
      userToFollow.followers.pull(req.user._id);
    } else {
      // Follow
      currentUser.following.push(req.params.id);
      userToFollow.followers.push(req.user._id);

      // Create notification
      await Notification.create({
        recipient: req.params.id,
        sender: req.user._id,
        type: 'new_follower',
        message: `${currentUser.name} started following you.`,
        link: `/profile/${req.user._id}`,
      });

      // Send real-time notification
      try {
        const io = getIO();
        io.to(req.params.id).emit('notification', {
          type: 'new_follower',
          message: `${currentUser.name} started following you.`,
        });
      } catch (socketErr) {
        // Socket not initialized yet
      }
    }

    await currentUser.save();
    await userToFollow.save();

    res.json({
      success: true,
      isFollowing: !isFollowing,
      followersCount: userToFollow.followers.length,
    });
  } catch (error) {
    console.error('Follow user error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Search users
// @route   GET /api/users/search?q=
const searchUsers = async (req, res) => {
  try {
    const { q, role, institution, excludeFollowed } = req.query;
    const searchTerm = q?.trim();
    const normalizedSearch = searchTerm?.toLowerCase();
    const isAdminSearch = ['admin', 'admins', 'administrator', 'super admin', 'superadmin']
      .includes(normalizedSearch);
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    let query = {
      isActive: { $ne: false },
      isBlocked: { $ne: true },
    };

    if (req.user) {
      query._id = {
        $nin:
          excludeFollowed === 'true'
            ? [req.user._id, ...(req.user.following || [])]
            : [req.user._id],
      };
    }

    if (isAdminSearch || role === 'admin') {
      query.$or = [{ isAdmin: true }, { isSuperAdmin: true }];
    } else if (searchTerm) {
      query.$text = { $search: searchTerm };
    }

    if (role && role !== 'admin') {
      query.$or = [
        { role },
        { category: role },
        { badges: { $elemMatch: { type: role, isActive: { $ne: false } } } },
      ];
    }

    if (institution) {
      query.institutionName = { $regex: institution, $options: 'i' };
    }

    const users = await User.find(query)
      .select('-password -verificationToken -resetPasswordToken')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await User.countDocuments(query);

    res.json({
      success: true,
      users,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Get user's posts
// @route   GET /api/users/:id/posts
const getUserPosts = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const query = { author: req.params.id };
    if (!isOwnerOrAdmin(req, req.params.id)) {
      query.status = 'approved';
    }

    const posts = await Post.find(query)
      .populate('author', 'name profilePic role category institutionName openToOpportunities badges isAdmin isSuperAdmin lastActiveAt activeDays followers profileThemeVariant')
      .populate('jobPost', 'title institutionName roleType shortJobType duration startTime endTime isPaid stipend currency location workplaceName workplaceAddress workplaceCity workplaceState workplaceCountry coordinates deadline status')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await Post.countDocuments(query);

    res.json({
      success: true,
      posts,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Get user posts error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Get user's job posts
// @route   GET /api/users/:id/jobs
const getUserJobs = async (req, res) => {
  try {
    const query = { postedBy: req.params.id };
    if (!isOwnerOrAdmin(req, req.params.id)) {
      query.status = 'approved';
      query.isActive = true;
    }

    const jobs = await JobPost.find(query)
      .populate('postedBy', 'name profilePic role category openToOpportunities badges isAdmin isSuperAdmin lastActiveAt activeDays followers profileThemeVariant')
      .sort({ createdAt: -1 });

    res.json({ success: true, jobs });
  } catch (error) {
    console.error('Get user jobs error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Get user's followers
// @route   GET /api/users/:id/followers
const getFollowers = async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .populate('followers', 'name profilePic role category institutionName openToOpportunities badges isAdmin isSuperAdmin lastActiveAt activeDays followers profileThemeVariant');

    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    res.json({ success: true, followers: user.followers });
  } catch (error) {
    console.error('Get followers error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Get user's following
// @route   GET /api/users/:id/following
const getFollowing = async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .populate('following', 'name profilePic role category institutionName openToOpportunities badges isAdmin isSuperAdmin lastActiveAt activeDays followers profileThemeVariant');

    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    res.json({ success: true, following: user.following });
  } catch (error) {
    console.error('Get following error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    F07 — Verify/update user verified status (admin only)
// @route   PUT /api/admin/users/:id/verify
const verifyUser = async (req, res) => {
  try {
    const { verifiedStatus } = req.body;
    if (!['none', 'email', 'institution', 'top_contributor', 'platform_owner'].includes(verifiedStatus)) {
      return res.status(400).json({ message: 'Invalid verified status.' });
    }

    const user = await User.findByIdAndUpdate(
      req.params.id,
      {
        verifiedStatus,
        isVerified: verifiedStatus !== 'none',
      },
      { returnDocument: 'after' }
    );

    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    res.json({ success: true, user });
  } catch (error) {
    console.error('Verify user error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    F07 — Request institution verification (upload document)
// @route   POST /api/users/request-verification
const requestVerification = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'Verification document is required.' });
    }

    const result = await uploadToCloudinary(req.file, 'ShortJob/verification-docs');
    const oldDocuments = req.user.verificationDocuments || [];
    req.user.verificationDocuments = [{
      url: result.secure_url,
      publicId: result.public_id,
    }];
    await req.user.save();

    for (const doc of oldDocuments) {
      if (doc.publicId || doc.url) {
        await deleteFromCloudinary(doc.publicId || doc.url);
      }
    }

    res.json({ success: true, message: 'Verification request submitted.', user: req.user });
  } catch (error) {
    console.error('Request verification error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    F09 — Endorse a skill on a user's profile
// @route   POST /api/users/:id/skills/:skillName/endorse
const endorseSkill = async (req, res) => {
  try {
    const { skillName } = req.params;
    if (req.user._id.toString() === req.params.id) {
      return res.status(400).json({ message: 'You cannot endorse your own skills.' });
    }

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    // Since skills are still string array for backward compatibility,
    // we're keeping it simple: endorsements based on skill name
    // Check if skill exists on user
    if (!user.skills.includes(skillName)) {
      return res.status(404).json({ message: 'Skill not found on this user.' });
    }

    // For this version, we track endorsements using a simple approach
    // The existing skills field is [String], we'll keep it backward compatible
    // Endorsements are tracked via a simple array on the user
    if (!user.skillEndorsements) {
      user.skillEndorsements = new Map();
    }

    const endorsements = user.skillEndorsements?.get(skillName) || [];
    const userId = req.user._id;

    if (endorsements.some(e => e.toString() === userId.toString())) {
      // Remove endorsement
      user.skillEndorsements.set(skillName, endorsements.filter(e => e.toString() !== userId.toString()));
      await user.save();
      const count = (user.skillEndorsements?.get(skillName) || []).length;
      return res.json({ success: true, endorsed: false, endorsementCount: count });
    }

    // Add endorsement
    endorsements.push(userId);
    user.skillEndorsements.set(skillName, endorsements);
    await user.save();

    res.json({ success: true, endorsed: true, endorsementCount: endorsements.length });
  } catch (error) {
    console.error('Endorse skill error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    F10 — Toggle open to opportunities status
// @route   PATCH /api/users/me/opportunity-status
const toggleOpportunityStatus = async (req, res) => {
  try {
    const { openToOpportunities } = req.body;
    if (typeof openToOpportunities !== 'boolean') {
      return res.status(400).json({ message: 'openToOpportunities must be a boolean.' });
    }

    if (!canUseOpportunityStatus(req.user)) {
      return res.status(403).json({ message: 'This account cannot toggle opportunity status.' });
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { openToOpportunities },
      { returnDocument: 'after' }
    );

    res.json({ success: true, openToOpportunities: user.openToOpportunities });
  } catch (error) {
    console.error('Toggle opportunity status error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    F08 — Update user timeline
// @route   PUT /api/users/:id/timeline
const updateTimeline = async (req, res) => {
  try {
    if (req.user._id.toString() !== req.params.id) {
      return res.status(403).json({ message: 'You can only update your own timeline.' });
    }

    const { timeline } = req.body;
    if (!Array.isArray(timeline)) {
      return res.status(400).json({ message: 'Timeline must be an array.' });
    }

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { timeline },
      { returnDocument: 'after' }
    );

    res.json({ success: true, user });
  } catch (error) {
    console.error('Update timeline error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Update self-selected badges
// @route   POST /api/users/me/badges
const updateMyBadges = async (req, res) => {
  try {
    const { badges } = req.body;
    if (!Array.isArray(badges)) {
      return res.status(400).json({ message: 'Badges must be an array.' });
    }

    const uniqueBadges = [...new Set(badges)];
    const invalidBadge = uniqueBadges.find((badge) => !SELF_BADGES.includes(badge));
    if (invalidBadge) {
      return res.status(400).json({ message: `Badge "${invalidBadge}" cannot be self-assigned.` });
    }

    const user = await User.findById(req.user._id);
    const nonSelfBadges = (user.badges || []).filter((badge) => badge.grantedBy !== 'self');
    const selfBadges = uniqueBadges.map((badge) => ({
      type: badge,
      grantedBy: 'self',
      grantedAt: new Date(),
      isActive: true,
    }));

    user.badges = [...nonSelfBadges, ...selfBadges];
    await user.save();

    res.json({ success: true, badges: user.badges, user });
  } catch (error) {
    console.error('Update badges error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Get active badges for a user
// @route   GET /api/users/:id/badges
const getUserBadges = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('badges');
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    res.json({
      success: true,
      badges: (user.badges || []).filter((badge) => badge.isActive !== false),
    });
  } catch (error) {
    console.error('Get user badges error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

module.exports = {
  getUserProfile,
  getOnlineUserIds,
  getMyLoginHistory,
  deleteMyLoginRecord,
  updateMyLoginAuditPreference,
  updateProfile,
  followUser,
  searchUsers,
  getUserPosts,
  getUserJobs,
  getFollowers,
  getFollowing,
  verifyUser,
  requestVerification,
  endorseSkill,
  toggleOpportunityStatus,
  updateTimeline,
  updateMyBadges,
  getUserBadges,
  updateCurrentLocation,
};
