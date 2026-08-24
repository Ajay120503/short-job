const mongoose = require('mongoose');

const adminSettingsSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      default: 'platform',
      unique: true,
      immutable: true,
    },
    autoApprove: { type: Boolean, default: false },
    moderationEnabled: { type: Boolean, default: true },
    autoModerationEnabled: { type: Boolean, default: false },
    manualReviewWindowMinutes: { type: Number, default: 1440, min: 1, max: 10080 },
    requireRejectReason: { type: Boolean, default: true },
    notifyCreators: { type: Boolean, default: true },
    autoBlockThreshold: { type: Number, default: 3, min: 1, max: 50 },
    emailNotifications: { type: Boolean, default: true },
    loginAuditEnabled: { type: Boolean, default: false },
    requireReviewNewUsers: { type: Boolean, default: false },
    contentModerationRules: { type: Boolean, default: true },
    moderationContentTypes: {
      posts: { type: Boolean, default: true },
      jobs: { type: Boolean, default: true },
      stories: { type: Boolean, default: true },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AdminSettings', adminSettingsSchema);
