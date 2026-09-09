const Post = require('../models/Post');
const { resolvePostImageRemoval } = require('../utils/postImageRemoval');
const JobPost = require('../models/JobPost');
const Comment = require('../models/Comment');
const Notification = require('../models/Notification');
const { getIO } = require('../config/socket');
const { uploadToCloudinary, deleteFromCloudinary } = require('../middlewares/upload.middleware');
const { runFakeDetectionRuleOnly } = require('../utils/fakeDetectionRuleOnly');
const { getInitialModerationState, applyInitialRuleModeration } = require('../utils/adminSettings');
const { extractTextFromImages, getContentImageSources } = require('../utils/ocrModeration');
const { pickPriorityPage, toId } = require('../utils/contentOrdering');
const {
  POST_TEXT_MIN_LENGTH,
  POST_TEXT_MAX_LENGTH,
  POST_TAG_MAX_ITEMS,
  LIST_ITEM_MIN_LENGTH,
  LIST_ITEM_MAX_LENGTH,
  cleanString,
  sendValidationError,
  sendCreateError,
  isHttpUrl,
} = require('../utils/createValidation');

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

const attachCommentCounts = async (posts) => {
  const items = Array.isArray(posts) ? posts : [posts];
  const ids = items.map((post) => post?._id).filter(Boolean);
  if (!ids.length) return Array.isArray(posts) ? [] : posts;

  const counts = await Comment.aggregate([
    { $match: { post: { $in: ids } } },
    { $group: { _id: '$post', count: { $sum: 1 } } },
  ]);
  const countByPost = new Map(counts.map((entry) => [entry._id.toString(), entry.count]));
  const result = items.map((post) => ({
    ...(typeof post.toObject === 'function' ? post.toObject() : post),
    commentsCount: countByPost.get(post._id.toString()) || 0,
  }));
  return Array.isArray(posts) ? result : result[0];
};

const getExpiredJobPostFilter = async () => {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const expiredJobIds = await JobPost.find({ deadline: { $lt: todayStart } }).distinct('_id');

  return {
    $or: [
      { jobPost: null },
      { jobPost: { $exists: false } },
      { jobPost: { $nin: expiredJobIds } },
    ],
  };
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

    const liveJobPostFilter = await getExpiredJobPostFilter();
    query = { $and: [query, liveJobPostFilter] };

    const orderedPostPage = req.user
      ? await Post.find(query)
          .select('_id author createdAt')
          .lean()
          .then((rows) => pickPriorityPage(rows, req.user, (post) => post.author, skip, limit))
      : null;

    const postsQuery = req.user
      ? Post.find({ _id: { $in: orderedPostPage.map((post) => post._id) } })
      : Post.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit);

    const posts = await postsQuery
      .populate('author', USER_SIGNAL_SELECT)
      .populate({
        path: 'jobPost',
        select: 'title institutionName institutionLogo roleType shortJobType duration workingHoursPerDay jobDate startTime endTime isPaid stipend currency location workplaceName workplaceAddress workplaceCity workplaceState workplaceCountry coordinates deadline description image skillsRequired applicants postedBy',
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

    if (req.user) {
      const order = new Map(orderedPostPage.map((post, index) => [toId(post._id), index]));
      posts.sort((a, b) => (order.get(toId(a._id)) ?? 0) - (order.get(toId(b._id)) ?? 0));
    }
    const total = await Post.countDocuments(query);

    res.json({
      success: true,
      posts: await attachCommentCounts(posts),
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
    const { eventDate, resourceFileType } = req.body;
    const text = cleanString(req.body.text);
    const type = cleanString(req.body.type) || 'general';
    const eventLocation = cleanString(req.body.eventLocation);
    const resourceUrl = cleanString(req.body.resourceUrl);
    const allowedTypes = ['general', 'announcement', 'achievement', 'noticeboard', 'question', 'poll', 'event', 'resource_share', 'celebration', 'discussion'];
    const errors = {};

    if (!allowedTypes.includes(type)) errors.type = 'Choose a valid post type.';
    if (!text) errors.text = 'Post text is required.';
    else if (text.length < POST_TEXT_MIN_LENGTH) errors.text = `Post text must contain at least ${POST_TEXT_MIN_LENGTH} characters.`;
    else if (text.length > POST_TEXT_MAX_LENGTH) errors.text = `Post text cannot exceed ${POST_TEXT_MAX_LENGTH} characters.`;
    if (type === 'noticeboard' && !isInstitutionMember(req.user)) {
      errors.type = 'Noticeboard posts are available only to verified institution members.';
    }

    const rawTags = Array.isArray(req.body.tags) ? req.body.tags : String(req.body.tags || '').split(',');
    const normalizedTags = [...new Set(rawTags.map(cleanString).filter(Boolean))];
    if (normalizedTags.length > POST_TAG_MAX_ITEMS) errors.tags = `Use no more than ${POST_TAG_MAX_ITEMS} tags.`;
    if (normalizedTags.some((tag) => tag.length < LIST_ITEM_MIN_LENGTH || tag.length > LIST_ITEM_MAX_LENGTH)) errors.tags = `Each tag must contain ${LIST_ITEM_MIN_LENGTH} to ${LIST_ITEM_MAX_LENGTH} characters.`;

    if (Object.keys(errors).length) return sendValidationError(res, errors);

    const moderationState = await getInitialModerationState('post');

    const postData = {
      author: req.user._id,
      text,
      type,
      tags: normalizedTags,
      images: [],
      ...moderationState,
    };

    if (type === 'poll') {
      let options;
      try { options = JSON.parse(req.body.pollOptions || '[]'); } catch (_) { options = []; }
      if (!Array.isArray(options)) options = [];
      options = options.map((option) => String(option).trim()).filter(Boolean);
      if (options.length < 2 || options.length > 6) return sendValidationError(res, { pollOptions: 'Polls require 2 to 6 options.' });
      if (options.some((option) => option.length > 100)) return sendValidationError(res, { pollOptions: 'Each poll option must be 100 characters or fewer.' });
      if (new Set(options.map((option) => option.toLowerCase())).size !== options.length) return sendValidationError(res, { pollOptions: 'Poll options must be different from each other.' });
      postData.pollOptions = options.map((option) => ({ text: option, votes: [] }));
    }
    if (type === 'event') {
      const parsedEventDate = new Date(eventDate);
      const eventErrors = {};
      if (!eventDate || Number.isNaN(parsedEventDate.getTime())) eventErrors.eventDate = 'Choose a valid event date and time.';
      else if (parsedEventDate <= new Date()) eventErrors.eventDate = 'Event date must be in the future.';
      if (!eventLocation) eventErrors.eventLocation = 'Event location is required.';
      else if (eventLocation.length > 200) eventErrors.eventLocation = 'Event location cannot exceed 200 characters.';
      if (Object.keys(eventErrors).length) return sendValidationError(res, eventErrors);
      postData.eventDetails = { date: parsedEventDate, location: eventLocation, rsvps: [] };
    }
    if (type === 'resource_share') {
      if (!resourceUrl) return sendValidationError(res, { resourceUrl: 'A resource link is required.' });
      if (resourceUrl.length > 1000 || !isHttpUrl(resourceUrl)) return sendValidationError(res, { resourceUrl: 'Enter a valid http:// or https:// resource link.' });
      postData.resourceUrl = resourceUrl;
      postData.resourceFileType = resourceFileType === 'link' ? resourceFileType : 'link';
    }

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
      postData.moderationMeta = {
        ...postData.moderationMeta,
        ...await extractTextFromImages(req.files),
      };
    }

    const moderatedState = await applyInitialRuleModeration(postData, 'post', moderationState);
    postData.status = moderatedState.status;
    postData.moderationMeta = moderatedState.moderationMeta;

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
    return sendCreateError(res, error, 'The post could not be created. Please try again.');
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
    const allowedTypes = ['general', 'announcement', 'achievement', 'noticeboard', 'question', 'poll', 'event', 'resource_share', 'celebration', 'discussion'];
    const nextType = type === undefined ? undefined : cleanString(type);

    if (nextType !== undefined && !allowedTypes.includes(nextType)) {
      return sendValidationError(res, { type: 'Choose a valid post type.' });
    }
    if (nextType === 'noticeboard' && !isInstitutionMember(req.user)) {
      return sendValidationError(res, { type: 'Noticeboard posts are available only to verified institution members.' });
    }

    // Update text
    if (text !== undefined) {
      post.text = cleanString(text);
      if (!post.text || post.text.length < POST_TEXT_MIN_LENGTH || post.text.length > POST_TEXT_MAX_LENGTH) {
        return sendValidationError(res, {
          text: `Post text must contain ${POST_TEXT_MIN_LENGTH} to ${POST_TEXT_MAX_LENGTH} characters.`,
        });
      }
    }

    // Update type
    if (nextType !== undefined) {
      post.type = nextType;
      if (nextType === 'noticeboard') {
        // F11 — Refresh expiry when marked as noticeboard
        post.noticeboardExpiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48 hours
      } else if (post.noticeboardExpiresAt) {
        // Clearing expiry when type changes away from noticeboard
        post.noticeboardExpiresAt = undefined;
      }
    }

    // Update tags
    if (tags !== undefined) {
      const rawTags = Array.isArray(tags) ? tags : String(tags).split(',');
      const normalizedTags = [...new Set(rawTags.map(cleanString).filter(Boolean))];
      if (normalizedTags.length > POST_TAG_MAX_ITEMS) return sendValidationError(res, { tags: `Use no more than ${POST_TAG_MAX_ITEMS} tags.` });
      if (normalizedTags.some((tag) => tag.length < LIST_ITEM_MIN_LENGTH || tag.length > LIST_ITEM_MAX_LENGTH)) {
        return sendValidationError(res, { tags: `Each tag must contain ${LIST_ITEM_MIN_LENGTH} to ${LIST_ITEM_MAX_LENGTH} characters.` });
      }
      post.tags = normalizedTags;
    }

    // Remove images marked for deletion (comma-separated or JSON array of publicIds)
    let removedPublicIds = [];
    if (req.body.removeImages) {
      try {
        removedPublicIds = resolvePostImageRemoval(req.body.removeImages, post.images);
      } catch (error) {
        return sendValidationError(res, { removeImages: error.message });
      }
      if (removedPublicIds.length > 0) {
        post.images = post.images.filter(img => !removedPublicIds.includes(img.publicId));
      }
    }

    // Upload new images
    if (req.files && req.files.length > 0) {
      const remainingSlots = 4 - post.images.length;
      if (req.files.length > remainingSlots) {
        return sendValidationError(res, { images: 'Maximum 4 images allowed per post. Remove an existing image first.' });
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

    post.text = cleanString(post.text);
    if (
      post.text
      && post.text.length < POST_TEXT_MIN_LENGTH
    ) {
      return sendValidationError(res, {
        text: `Post text must contain at least ${POST_TEXT_MIN_LENGTH} characters.`,
      });
    }

    if (removedPublicIds.length > 0 || (req.files && req.files.length > 0)) {
      post.moderationMeta = {
        ...(post.moderationMeta?.toObject?.() || post.moderationMeta || {}),
        ...await extractTextFromImages(getContentImageSources(post, 'post')),
      };
    }
    const moderationState = await getInitialModerationState('post');
    const moderatedState = await applyInitialRuleModeration(post.toObject(), 'post', moderationState);
    post.status = moderatedState.status;
    post.moderationMeta = moderatedState.moderationMeta;

    await post.save();

    for (const publicId of removedPublicIds) await deleteFromCloudinary(publicId);

    const populatedPost = await Post.findById(post._id)
      .populate('author', USER_SIGNAL_SELECT)
      .populate({
        path: 'jobPost',
        select: 'title institutionName institutionLogo roleType shortJobType duration workingHoursPerDay jobDate startTime endTime isPaid stipend currency location workplaceName workplaceAddress workplaceCity workplaceState workplaceCountry coordinates deadline description image skillsRequired applicants postedBy',
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
    return sendCreateError(res, error, 'The post could not be updated. Please try again.');
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

    await Post.updateOne(
      { _id: post._id },
      isLiked
        ? { $pull: { likes: req.user._id } }
        : { $addToSet: { likes: req.user._id } }
    );

    if (!isLiked) {
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

    const updatedPost = await Post.findById(post._id).select('likes');
    const likes = updatedPost?.likes || [];

    res.json({
      success: true,
      isLiked: !isLiked,
      liked: !isLiked,
      likes,
      likesCount: likes.length,
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

    await Post.updateOne(
      { _id: post._id },
      isSaved
        ? { $pull: { saves: req.user._id } }
        : { $addToSet: { saves: req.user._id } }
    );
    const updatedPost = await Post.findById(post._id).select('saves');

    res.json({
      success: true,
      saved: !isSaved,
      saves: updatedPost?.saves || [],
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
        select: 'title institutionName institutionLogo roleType shortJobType duration workingHoursPerDay jobDate startTime endTime isPaid stipend currency location workplaceName workplaceAddress workplaceCity workplaceState workplaceCountry coordinates deadline description image skillsRequired applicants postedBy',
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

    res.json({ success: true, posts: await attachCommentCounts(posts) });
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
        select: 'title institutionName institutionLogo roleType shortJobType duration workingHoursPerDay jobDate startTime endTime isPaid stipend currency location workplaceName workplaceAddress workplaceCity workplaceState workplaceCountry coordinates deadline description image skillsRequired applicants postedBy',
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

    res.json({ success: true, post: await attachCommentCounts(post) });
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

    const ocrMeta = await extractTextFromImages(getContentImageSources(post, 'post'));
    post.moderationMeta = {
      ...(post.moderationMeta?.toObject?.() || post.moderationMeta || {}),
      ...ocrMeta,
    };

    // Run OCR-aware rule-based fake detection
    const result = await runFakeDetectionRuleOnly(post, 'post');

    // Apply decision
    const nextStatus = result.approved ? 'approved' : 'rejected';
    const moderationMeta = {
      ...(post.moderationMeta?.toObject?.() || post.moderationMeta || {}),
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
    await Post.updateOne(
      { _id: post._id },
      { $set: { status: nextStatus, moderationMeta } }
    );
    post.status = nextStatus;
    post.moderationMeta = moderationMeta;

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

const votePoll = async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    const optionIndex = Number(req.body.optionIndex);
    if (!post || post.type !== 'poll') return res.status(404).json({ message: 'Poll not found.' });
    if (!Number.isInteger(optionIndex) || !post.pollOptions[optionIndex]) return res.status(400).json({ message: 'Invalid poll option.' });
    await Post.updateOne(
      { _id: post._id },
      { $pull: { 'pollOptions.$[].votes': req.user._id } }
    );
    await Post.updateOne(
      { _id: post._id },
      { $addToSet: { [`pollOptions.${optionIndex}.votes`]: req.user._id } }
    );
    const updatedPost = await Post.findById(post._id).select('pollOptions');
    res.json({ success: true, pollOptions: updatedPost?.pollOptions || [] });
  } catch (error) {
    console.error('Vote poll error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

const toggleRsvp = async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post || post.type !== 'event') return res.status(404).json({ message: 'Event not found.' });
    const attending = post.eventDetails.rsvps.some((id) => id.toString() === req.user._id.toString());
    await Post.updateOne(
      { _id: post._id },
      attending
        ? { $pull: { 'eventDetails.rsvps': req.user._id } }
        : { $addToSet: { 'eventDetails.rsvps': req.user._id } }
    );
    const updatedPost = await Post.findById(post._id).select('eventDetails.rsvps');
    res.json({ success: true, attending: !attending, count: updatedPost?.eventDetails?.rsvps?.length || 0 });
  } catch (error) {
    console.error('RSVP error:', error);
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
  votePoll,
  toggleRsvp,
};
