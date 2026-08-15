const Comment = require('../models/Comment');
const Post = require('../models/Post');
const Notification = require('../models/Notification');
const { getIO } = require('../config/socket');

const canViewPost = (post, user) => {
  if (!post.status || post.status === 'approved') return true;
  if (!user) return false;
  if (user.isAdmin || user.isSuperAdmin) return true;
  return post.author?.toString?.() === user._id.toString();
};

// @desc    Get comments for a post
// @route   GET /api/posts/:postId/comments
const getComments = async (req, res) => {
  try {
    const { postId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const post = await Post.findById(postId).select('author status');
    if (!post || !canViewPost(post, req.user)) {
      return res.status(404).json({ message: 'Post not found.' });
    }

    // Get top-level comments only (parentComment is null)
    const comments = await Comment.find({ post: postId, parentComment: null })
      .populate('author', 'name profilePic role openToOpportunities')
      .populate({
        path: 'replies',
        populate: {
          path: 'author',
          select: 'name profilePic role openToOpportunities',
        },
      })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await Comment.countDocuments({ post: postId, parentComment: null });

    res.json({
      success: true,
      comments,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Get comments error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Add a comment to a post
// @route   POST /api/posts/:postId/comments
const addComment = async (req, res) => {
  try {
    const { postId } = req.params;
    const { text } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ message: 'Comment text is required.' });
    }

    const post = await Post.findById(postId);
    if (!post) {
      return res.status(404).json({ message: 'Post not found.' });
    }

    if (!canViewPost(post, req.user)) {
      return res.status(404).json({ message: 'Post not found.' });
    }

    const comment = await Comment.create({
      post: postId,
      author: req.user._id,
      text: text.trim(),
    });

    // Add comment reference to post
    post.comments.push(comment._id);
    await post.save();

    const populatedComment = await Comment.findById(comment._id)
      .populate('author', 'name profilePic role openToOpportunities');

    // Notify post author (if not self)
    if (post.author.toString() !== req.user._id.toString()) {
      await Notification.create({
        recipient: post.author,
        sender: req.user._id,
        type: 'post_comment',
        message: `${req.user.name} commented on your post.`,
        link: `/post/${postId}`,
      });

      try {
        const io = getIO();
        // Notify post author (badge + toast)
        io.to(post.author.toString()).emit('notification', {
          type: 'post_comment',
          message: `${req.user.name} commented on your post.`,
          link: `/post/${postId}`,
        });
        // Emit new_comment event for real-time comment count updates
        io.to(post.author.toString()).emit('new_comment', {
          postId,
          comment: populatedComment,
        });
      } catch (socketErr) {}
    }

    res.status(201).json({ success: true, comment: populatedComment });
  } catch (error) {
    console.error('Add comment error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Reply to a comment
// @route   POST /api/comments/:commentId/reply
const replyToComment = async (req, res) => {
  try {
    const { commentId } = req.params;
    const { text } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ message: 'Reply text is required.' });
    }

    const parentComment = await Comment.findById(commentId);
    if (!parentComment) {
      return res.status(404).json({ message: 'Comment not found.' });
    }

    const reply = await Comment.create({
      post: parentComment.post,
      author: req.user._id,
      text: text.trim(),
      parentComment: commentId,
    });

    // Add reply reference to parent comment
    parentComment.replies.push(reply._id);
    await parentComment.save();

    const populatedReply = await Comment.findById(reply._id)
      .populate('author', 'name profilePic role openToOpportunities');

    // Notify parent comment author
    if (parentComment.author.toString() !== req.user._id.toString()) {
      await Notification.create({
        recipient: parentComment.author,
        sender: req.user._id,
        type: 'comment_reply',
        message: `${req.user.name} replied to your comment.`,
        link: `/post/${parentComment.post}`,
      });

      try {
        const io = getIO();
        io.to(parentComment.author.toString()).emit('notification', {
          type: 'comment_reply',
          message: `${req.user.name} replied to your comment.`,
          link: `/post/${parentComment.post}`,
        });
      } catch (socketErr) {}
    }

    res.status(201).json({ success: true, comment: populatedReply });
  } catch (error) {
    console.error('Reply to comment error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Like / Unlike a comment
// @route   POST /api/comments/:commentId/like
const likeComment = async (req, res) => {
  try {
    const comment = await Comment.findById(req.params.commentId);

    if (!comment) {
      return res.status(404).json({ message: 'Comment not found.' });
    }

    const isLiked = comment.likes.includes(req.user._id);

    if (isLiked) {
      comment.likes.pull(req.user._id);
    } else {
      comment.likes.push(req.user._id);

      // Notify comment author
      if (comment.author.toString() !== req.user._id.toString()) {
        await Notification.create({
          recipient: comment.author,
          sender: req.user._id,
          type: 'comment_like',
          message: `${req.user.name} liked your comment.`,
          link: `/post/${comment.post}`,
        });

        try {
        const io = getIO();
        io.to(comment.author.toString()).emit('notification', {
          type: 'comment_like',
          message: `${req.user.name} liked your comment.`,
          link: `/post/${comment.post}`,
        });
        } catch (socketErr) {}
      }
    }

    await comment.save();

    res.json({
      success: true,
      isLiked: !isLiked,
      likesCount: comment.likes.length,
    });
  } catch (error) {
    console.error('Like comment error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Delete a comment
// @route   DELETE /api/comments/:commentId
const deleteComment = async (req, res) => {
  try {
    const comment = await Comment.findById(req.params.commentId);

    if (!comment) {
      return res.status(404).json({ message: 'Comment not found.' });
    }

    // Check ownership
    if (comment.author.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'You can only delete your own comments.' });
    }

    // Remove from parent comment's replies
    if (comment.parentComment) {
      await Comment.findByIdAndUpdate(comment.parentComment, {
        $pull: { replies: comment._id },
      });
    }

    // Remove from post's comments
    await Post.findByIdAndUpdate(comment.post, {
      $pull: { comments: comment._id },
    });

    // Delete all nested replies recursively
    await Comment.deleteMany({ parentComment: comment._id });

    await comment.deleteOne();

    res.json({ success: true, message: 'Comment deleted.' });
  } catch (error) {
    console.error('Delete comment error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

module.exports = {
  getComments,
  addComment,
  replyToComment,
  likeComment,
  deleteComment,
};
