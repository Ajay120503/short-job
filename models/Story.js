const mongoose = require('mongoose');

const storySchema = new mongoose.Schema(
  {
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    image: {
      url: { type: String, default: '' },
      publicId: { type: String, default: '' },
    },
    text: {
      type: String,
      maxlength: 200,
      default: '',
    },
    viewers: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    status: {
      type: String,
      enum: ['pending_review', 'approved', 'rejected', 'flagged'],
      default: 'pending_review',
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
      autoReason: String,
      autoDecision: String,
      autoSeverity: String,
      autoReviewedAt: Date,
      adminWindowExpiredAt: Date,
    },
    createdAt: {
      type: Date,
      default: Date.now,
      expires: 86400, // TTL: 24 hours auto-delete
    },
  }
);

storySchema.index({ author: 1, createdAt: -1 });
storySchema.index({ status: 1, createdAt: -1 });
// TTL index is already defined via expires: 86400 on the createdAt field

module.exports = mongoose.model('Story', storySchema);
