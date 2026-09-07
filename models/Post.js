const mongoose = require('mongoose');
const moderationMetaFields = require('../utils/moderationMetaFields');

const postSchema = new mongoose.Schema(
  {
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    type: {
      type: String,
      enum: ['general', 'job', 'announcement', 'achievement', 'noticeboard', 'question', 'poll', 'event', 'resource_share', 'celebration', 'discussion'],
      default: 'general',
    },
    text: {
      type: String,
      maxlength: [500, 'Post text cannot exceed 500 characters'],
      validate: {
        validator(value) {
          const length = String(value || '').trim().length;
          return length >= 3;
        },
        message: 'Post text must contain at least 3 characters',
      },
      default: '',
    },
    images: [
      {
        url: { type: String, required: true },
        publicId: { type: String, required: true },
      },
    ],
    tags: [{ type: String, trim: true, minlength: [3, 'Each tag must contain at least 3 characters'], maxlength: [20, 'Each tag must be 20 characters or fewer'] }],
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
    pollOptions: [{
      text: { type: String, trim: true, maxlength: [100, 'Each poll option must be 100 characters or fewer'] },
      votes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    }],
    eventDetails: {
      date: Date,
      location: { type: String, trim: true, maxlength: [200, 'Event location cannot exceed 200 characters'] },
      rsvps: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    },
    resourceUrl: { type: String, trim: true, maxlength: [1000, 'Resource link cannot exceed 1000 characters'] },
    resourceFileType: { type: String, trim: true },
    status: {
      type: String,
      enum: ['pending_review', 'approved', 'rejected', 'flagged'],
      default: 'approved',
    },
    moderationMeta: moderationMetaFields,
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
