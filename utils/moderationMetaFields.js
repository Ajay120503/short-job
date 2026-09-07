const mongoose = require('mongoose');

module.exports = {
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
  ocrStatus: {
    type: String,
    enum: ['not_applicable', 'completed', 'partial', 'failed'],
    default: 'not_applicable',
  },
  ocrText: { type: String, maxlength: 5000, default: '' },
  ocrConfidence: { type: Number, min: 0, max: 100, default: null },
  ocrImageCount: { type: Number, min: 0, max: 5, default: 0 },
  ocrProcessedAt: Date,
  ocrProcessingMs: { type: Number, min: 0, default: 0 },
  ocrError: { type: String, maxlength: 300, default: '' },
};
