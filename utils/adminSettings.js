const AdminSettings = require('../models/AdminSettings');
const { runFakeDetectionRuleOnly } = require('./fakeDetectionRuleOnly');

const DEFAULT_ADMIN_SETTINGS = {
  autoApprove: false,
  moderationEnabled: true,
  autoModerationEnabled: false,
  manualReviewWindowMinutes: 1440,
  requireRejectReason: true,
  notifyCreators: true,
  autoBlockThreshold: 3,
  emailNotifications: true,
  loginAuditEnabled: false,
  requireReviewNewUsers: false,
  contentModerationRules: true,
  moderationContentTypes: {
    posts: true,
    jobs: true,
    stories: true,
  },
};

const clampNumber = (value, fallback, min, max) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
};

const normalizeSettings = (settings = {}) => ({
  ...DEFAULT_ADMIN_SETTINGS,
  ...settings,
  autoBlockThreshold: clampNumber(
    settings.autoBlockThreshold,
    DEFAULT_ADMIN_SETTINGS.autoBlockThreshold,
    1,
    50
  ),
  manualReviewWindowMinutes: clampNumber(
    settings.manualReviewWindowMinutes,
    DEFAULT_ADMIN_SETTINGS.manualReviewWindowMinutes,
    1,
    10080
  ),
  moderationContentTypes: {
    ...DEFAULT_ADMIN_SETTINGS.moderationContentTypes,
    ...(settings.moderationContentTypes || {}),
  },
});

const serializeSettings = (doc) => {
  const raw = doc?.toObject ? doc.toObject() : doc || {};
  const normalized = normalizeSettings(raw);
  delete normalized._id;
  delete normalized.__v;
  delete normalized.key;
  return normalized;
};

const getAdminSettings = async () => {
  const doc = await AdminSettings.findOneAndUpdate(
    { key: 'platform' },
    { $setOnInsert: { key: 'platform', ...DEFAULT_ADMIN_SETTINGS } },
    { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true }
  );
  return serializeSettings(doc);
};

const updateAdminSettings = async (patch = {}) => {
  const current = await getAdminSettings();
  const next = normalizeSettings({ ...current, ...patch });
  const doc = await AdminSettings.findOneAndUpdate(
    { key: 'platform' },
    { $set: next },
    { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true }
  );
  return serializeSettings(doc);
};

const contentTypeKeyMap = {
  post: 'posts',
  job: 'jobs',
  story: 'stories',
};

const shouldQueueForReview = (settings, type) => {
  const normalized = normalizeSettings(settings);
  const typeKey = contentTypeKeyMap[type];
  return Boolean(
    normalized.moderationEnabled &&
      !normalized.autoApprove &&
      typeKey &&
      normalized.moderationContentTypes[typeKey]
  );
};

const getInitialModerationState = async (type) => {
  const settings = await getAdminSettings();
  const queued = shouldQueueForReview(settings, type);

  if (!queued) {
    return {
      status: 'approved',
      moderationMeta: {
        reviewedAt: new Date(),
        reviewMethod: settings.autoApprove ? 'auto_approved' : 'admin_manual',
        reviewNotes: settings.autoApprove
          ? 'Auto-approved by admin settings'
          : 'Moderation disabled for this content type',
      },
    };
  }

  return {
    status: 'pending_review',
    moderationMeta: {
      adminWindowExpiredAt: new Date(
        Date.now() + settings.manualReviewWindowMinutes * 60 * 1000
      ),
    },
  };
};

const applyInitialRuleModeration = async (contentData, type, moderationState = null) => {
  const settings = await getAdminSettings();
  const state = moderationState || await getInitialModerationState(type);
  const typeKey = contentTypeKeyMap[type];
  const rulesEnabled = Boolean(
    settings.contentModerationRules &&
      typeKey &&
      settings.moderationContentTypes?.[typeKey] !== false
  );

  if (!rulesEnabled) {
    return { ...state, moderationResult: null };
  }

  const result = await runFakeDetectionRuleOnly(contentData, type);
  const now = new Date();
  const moderationMeta = {
    ...(state.moderationMeta || {}),
    autoScore: result.score,
    autoFlags: result.flags,
    autoReason: result.reason,
    autoDecision: result.decision,
    autoSeverity: result.severity,
    autoReviewedAt: now,
  };

  let status = state.status;
  if (settings.moderationEnabled && settings.autoModerationEnabled && !result.approved) {
    status = 'rejected';
    moderationMeta.reviewedAt = now;
    moderationMeta.reviewMethod = 'auto_rejected';
    moderationMeta.reviewNotes = result.reason;
  } else if (status === 'approved' && result.approved) {
    moderationMeta.reviewedAt = moderationMeta.reviewedAt || now;
    moderationMeta.reviewMethod = moderationMeta.reviewMethod || 'auto_approved';
    moderationMeta.reviewNotes = moderationMeta.reviewNotes || result.reason;
  }

  return {
    status,
    moderationMeta,
    moderationResult: result,
  };
};

module.exports = {
  DEFAULT_ADMIN_SETTINGS,
  getAdminSettings,
  updateAdminSettings,
  shouldQueueForReview,
  getInitialModerationState,
  applyInitialRuleModeration,
};
