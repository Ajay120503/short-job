const mongoose = require('mongoose');

const postSchema = new mongoose.Schema(
  {
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    type: {
      type: String,
      enum: ['general', 'job', 'announcement', 'achievement', 'noticeboard'],
      default: 'general',
    },
    text: {
      type: String,
      maxlength: [2000, 'Post text cannot exceed 2000 characters'],
      default: '',
    },
    images: [
      {
        url: { type: String, required: true },
        publicId: { type: String, required: true },
      },
    ],
    tags: [{ type: String, trim: true }],
    likes: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    saves: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    comments: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Comment',
      },
    ],
    jobPost: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JobPost',
      default: null,
    },
    noticeboardExpiresAt: { type: Date },
    status: {
      type: String,
      enum: ['pending_review', 'approved', 'rejected', 'flagged'],
      default: 'approved',
    },
    moderationMeta: {
      reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      reviewedAt: Date,
      reviewMethod: {
        type: String,
        enum: ['admin_manual', 'auto_approved', 'auto_rejected', 'auto_flagged'],
      },
      reviewNotes: String,
      autoScore: Number,
      autoFlags: [mongoose.Schema.Types.Mixed],
      adminWindowExpiredAt: Date,
    },
  },
  {
    timestamps: true,
  }
);

// Index for feed queries
postSchema.index({ author: 1, createdAt: -1 });
postSchema.index({ type: 1 });
postSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('Post', postSchema);
