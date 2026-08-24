const Post = require('../models/Post');
const Comment = require('../models/Comment');
const Notification = require('../models/Notification');
const { getIO } = require('../config/socket');
const { uploadToCloudinary, deleteFromCloudinary } = require('../middlewares/upload.middleware');
const { runFakeDetectionRuleOnly } = require('../utils/fakeDetectionRuleOnly');
const { getInitialModerationState } = require('../utils/adminSettings');

const USER_SIGNAL_SELECT = 'name profilePic badges role category institutionName institutionPic openToOpportunities isAdmin isSuperAdmin lastActiveAt activeDays followers profileThemeVariant';

const hasActiveBadge = (user, badgeType) =>
  (user.badges || []).some((badge) => badge.type === badgeType && badge.isActive !== false);

const isInstitutionMember = (user) => {
  const institutionBadges = [
    'teacher', 'professor', 'hod', 'principal', 'lecturer',
    'school_member', 'college_member', 'university_member', 'coaching_member',
  ];
  return (
    ['school', 'college'].includes(user?.category) ||
    institutionBadges.some((badge) => hasActiveBadge(user, badge))
  );
};

const canViewContent = (content, user, authorField = 'author') => {
  if (!content.status || content.status === 'approved') return true;
  if (!user) return false;
  if (user.isAdmin || user.isSuperAdmin) return true;
  const authorId = content[authorField]?._id || content[authorField];
  return authorId?.toString?.() === user._id.toString();
};

// @desc    Get feed posts (paginated)
// @route   GET /api/posts
const getFeed = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    const { type } = req.query;

    let query = { status: 'approved' };
    if (type) {
      query.type = type;
    }

    // Public feed shows all approved content. Logged-in users also see their
    // own pending/rejected content so moderation state is not confusing.
    if (req.user) {
      const typeFilter = type ? { type } : {};
      query = {
        $or: [
          { status: 'approved', ...typeFilter },
          { author: req.user._id, ...typeFilter },
        ],
      };
    }

    const posts = await Post.find(query)
      .populate('author', USER_SIGNAL_SELECT)
      .populate({
        path: 'jobPost',
        select: 'title institutionName institutionLogo roleType isPaid stipend currency location deadline description image skillsRequired applicants postedBy',
        populate: {
          path: 'postedBy',
          select: USER_SIGNAL_SELECT,
        },
      })
      .populate({
        path: 'comments',
        select: 'author text likes createdAt',
        populate: {
          path: 'author',
          select: USER_SIGNAL_SELECT,
        },
      })
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
    console.error('Get feed error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Create a new post
// @route   POST /api/posts
const createPost = async (req, res) => {
  const uploadedPublicIds = [];
  let postCreated = false;
  try {
    const { text, type, tags } = req.body;

    if (!text && (!req.files || req.files.length === 0)) {
      return res.status(400).json({ message: 'Post must have text or images.' });
    }

    const moderationState = await getInitialModerationState('post');

    const postData = {
      author: req.user._id,
      text: text || '',
      type: type || 'general',
      tags: tags ? (typeof tags === 'string' ? tags.split(',').map(t => t.trim()) : tags) : [],
      images: [],
      ...moderationState,
    };

    // Set expiry for noticeboard posts
    if (type === 'noticeboard') {
      postData.noticeboardExpiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48 hours
    }

    // Upload images to Cloudinary
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const result = await uploadToCloudinary(file, 'ShortJob/post-images');
        uploadedPublicIds.push(result.public_id);
        postData.images.push({
          url: result.secure_url,
          publicId: result.public_id,
        });
      }
    }

    const post = await Post.create(postData);
    postCreated = true;
    const populatedPost = await Post.findById(post._id)
      .populate('author', USER_SIGNAL_SELECT);

    // Auto-run fake detection after 60 seconds (using cron job instead of Bull/Redis)
    // The cron job will handle the 1-minute admin window

    res.status(201).json({ success: true, post: populatedPost });
  } catch (error) {
    if (!postCreated) {
      for (const publicId of uploadedPublicIds) {
        await deleteFromCloudinary(publicId);
      }
    }
    console.error('Create post error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Update a post (author only)
// @route   PUT /api/posts/:id
const updatePost = async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);

    if (!post) {
      return res.status(404).json({ message: 'Post not found.' });
    }

    // Check ownership
    if (post.author.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'You can only edit your own posts.' });
    }

    const { text, type, tags } = req.body;

    // Update text
    if (text !== undefined) {
      post.text = text;
    }

    // Update type
    if (type !== undefined) {
      post.type = type;
      if (type === 'noticeboard') {
        // F11 — Refresh expiry when marked as noticeboard
        post.noticeboardExpiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48 hours
      } else if (post.noticeboardExpiresAt) {
        // Clearing expiry when type changes away from noticeboard
        post.noticeboardExpiresAt = undefined;
      }
    }

    // Update tags
    if (tags !== undefined) {
      post.tags = typeof tags === 'string' ? tags.split(',').map(t => t.trim()) : tags;
    }

    // Remove images marked for deletion (comma-separated or JSON array of publicIds)
    let removedPublicIds = [];
    if (req.body.removeImages) {
      try {
        removedPublicIds = JSON.parse(req.body.removeImages);
      } catch {
        removedPublicIds = req.body.removeImages.split(',').map(s => s.trim()).filter(Boolean);
      }
      if (removedPublicIds.length > 0) {
        post.images = post.images.filter(img => !removedPublicIds.includes(img.publicId));
        for (const publicId of removedPublicIds) {
          await deleteFromCloudinary(publicId);
        }
      }
    }

    // Upload new images
    if (req.files && req.files.length > 0) {
      const remainingSlots = 5 - post.images.length;
      if (remainingSlots <= 0) {
        return res.status(400).json({ message: 'Maximum 5 images allowed per post.' });
      }
      const filesToUpload = req.files.slice(0, remainingSlots);
      for (const file of filesToUpload) {
        const result = await uploadToCloudinary(file, 'ShortJob/post-images');
        post.images.push({
          url: result.secure_url,
          publicId: result.public_id,
        });
      }
    }

    await post.save();

    const populatedPost = await Post.findById(post._id)
      .populate('author', USER_SIGNAL_SELECT)
      .populate({
        path: 'jobPost',
        select: 'title institutionName institutionLogo roleType isPaid stipend currency location deadline description image skillsRequired applicants postedBy',
        populate: {
          path: 'postedBy',
          select: USER_SIGNAL_SELECT,
        },
      })
      .populate({
        path: 'comments',
        select: 'author text likes createdAt',
        populate: {
          path: 'author',
          select: USER_SIGNAL_SELECT,
        },
      });

    res.json({ success: true, post: populatedPost });
  } catch (error) {
    console.error('Update post error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Delete a post
// @route   DELETE /api/posts/:id
const deletePost = async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);

    if (!post) {
      return res.status(404).json({ message: 'Post not found.' });
    }

    // Check ownership
    if (post.author.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'You can only delete your own posts.' });
    }

    // Delete images from Cloudinary
    for (const image of post.images) {
      await deleteFromCloudinary(image.publicId);
    }

    // Delete associated comments
    await Comment.deleteMany({ post: post._id });

    await post.deleteOne();

    res.json({ success: true, message: 'Post deleted.' });
  } catch (error) {
    console.error('Delete post error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Like / Unlike a post
// @route   POST /api/posts/:id/like
const toggleLike = async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);

    if (!post) {
      return res.status(404).json({ message: 'Post not found.' });
    }

    if (!canViewContent(post, req.user)) {
      return res.status(404).json({ message: 'Post not found.' });
    }

    const isLiked = post.likes.includes(req.user._id);

    if (isLiked) {
      post.likes.pull(req.user._id);
    } else {
      post.likes.push(req.user._id);

      // Create notification for post author (if not their own post)
      if (post.author.toString() !== req.user._id.toString()) {
        await Notification.create({
          recipient: post.author,
          sender: req.user._id,
          type: 'post_like',
          message: `${req.user.name} liked your post.`,
          link: `/post/${post._id}`,
        });

        try {
          const io = getIO();
          io.to(post.author.toString()).emit('notification', {
            type: 'post_like',
            message: `${req.user.name} liked your post.`,
            link: `/post/${post._id}`,
          });
        } catch (socketErr) {}
      }
    }

    await post.save();

    res.json({
      success: true,
      isLiked: !isLiked,
      likesCount: post.likes.length,
    });
  } catch (error) {
    console.error('Toggle like error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Save / Unsave a post
// @route   POST /api/posts/:id/save
const toggleSave = async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);

    if (!post) {
      return res.status(404).json({ message: 'Post not found.' });
    }

    if (!canViewContent(post, req.user)) {
      return res.status(404).json({ message: 'Post not found.' });
    }

    const isSaved = post.saves.includes(req.user._id);

    if (isSaved) {
      post.saves.pull(req.user._id);
    } else {
      post.saves.push(req.user._id);
    }

    await post.save();

    res.json({
      success: true,
      saved: !isSaved,
      saves: post.saves,
    });
  } catch (error) {
    console.error('Toggle save error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Get saved posts
// @route   GET /api/posts/saved
const getSavedPosts = async (req, res) => {
  try {
    const posts = await Post.find({
      saves: req.user._id,
      $or: [
        { status: 'approved' },
        { author: req.user._id },
      ],
    })
      .populate('author', USER_SIGNAL_SELECT)
      .populate({
        path: 'jobPost',
        select: 'title institutionName institutionLogo roleType isPaid stipend currency location deadline description image skillsRequired applicants postedBy',
        populate: {
          path: 'postedBy',
          select: USER_SIGNAL_SELECT,
        },
      })
      .populate({
        path: 'comments',
        select: 'author text likes createdAt',
        populate: {
          path: 'author',
          select: USER_SIGNAL_SELECT,
        },
      })
      .sort({ createdAt: -1 });

    res.json({ success: true, posts });
  } catch (error) {
    console.error('Get saved posts error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Get a single post
// @route   GET /api/posts/:id
const getPost = async (req, res) => {
  try {
    const post = await Post.findById(req.params.id)
      .populate('author', USER_SIGNAL_SELECT)
      .populate({
        path: 'jobPost',
        select: 'title institutionName institutionLogo roleType isPaid stipend currency location deadline description image skillsRequired applicants postedBy',
        populate: {
          path: 'postedBy',
          select: USER_SIGNAL_SELECT,
        },
      })
      .populate({
        path: 'comments',
        populate: {
          path: 'author',
          select: USER_SIGNAL_SELECT,
        },
      });

    if (!post) {
      return res.status(404).json({ message: 'Post not found.' });
    }

    if (!canViewContent(post, req.user)) {
      return res.status(404).json({ message: 'Post not found.' });
    }

    res.json({ success: true, post });
  } catch (error) {
    console.error('Get post error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    F11 — Get active noticeboard posts for explore page
// @route   GET /api/posts/noticeboard
const getNoticeboardPosts = async (req, res) => {
  try {
    const notices = await Post.find({
      type: 'noticeboard',
      status: 'approved',
      noticeboardExpiresAt: { $gt: new Date() },
    })
      .populate('author', USER_SIGNAL_SELECT)
      .sort({ createdAt: -1 })
      .limit(5);

    res.json({ success: true, notices });
  } catch (error) {
    console.error('Get noticeboard posts error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Auto-moderate pending posts using rule-based detection
// @route   POST /api/posts/:id/moderate
const moderatePost = async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);

    if (!post) {
      return res.status(404).json({ message: 'Post not found.' });
    }

    if (post.status !== 'pending_review') {
      return res.status(400).json({ message: 'Post is not pending review.' });
    }

    // Run rule-based fake detection
    const result = await runFakeDetectionRuleOnly(post, 'post');

    // Apply decision
    post.status = result.approved ? 'approved' : 'rejected';
    post.moderationMeta = {
      reviewedAt: new Date(),
      reviewMethod: result.approved ? 'auto_approved' : 'auto_rejected',
      autoScore: result.score,
      autoFlags: result.flags,
    };
    await post.save();

    // Notify content creator
    try {
      const io = getIO();
      io.to(`user_${post.author}`).emit('content_moderation', {
        type: 'post',
        id: post._id,
        decision: post.status,
        score: result.score,
        flags: result.flags,
      });
    } catch (socketErr) {}

    res.json({
      success: true,
      post,
      moderationResult: result,
    });
  } catch (error) {
    console.error('Moderate post error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

module.exports = {
  getFeed,
  createPost,
  updatePost,
  deletePost,
  toggleLike,
  toggleSave,
  getSavedPosts,
  getPost,
  getNoticeboardPosts,
  moderatePost,
};
