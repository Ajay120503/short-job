const mongoose = require('mongoose');

const jobPostSchema = new mongoose.Schema(
  {
    postedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    institutionName: {
      type: String,
      required: [true, 'Organization name is required'],
      trim: true,
    },
    institutionLogo: {
      url: { type: String, default: '' },
      publicId: { type: String, default: '' },
    },
    title: {
      type: String,
      required: [true, 'Job title is required'],
      trim: true,
      maxlength: [200, 'Title cannot exceed 200 characters'],
    },
    description: {
      type: String,
      required: [true, 'Description is required'],
      maxlength: [5000, 'Description cannot exceed 5000 characters'],
    },
    roleType: {
      type: String,
      enum: ['teacher', 'professor', 'hod', 'principal', 'intern', 'volunteer', 'assistant', 'research', 'other'],
      default: 'teacher',
    },
    isPaid: {
      type: Boolean,
      default: false,
    },
    currency: {
      type: String,
      enum: ['INR', 'USD'],
      default: 'INR',
    },
    stipend: {
      type: Number,
      default: 0,
    },
    location: {
      type: String,
      enum: ['onsite', 'remote', 'hybrid'],
      default: 'onsite',
    },
    requiredQualifications: {
      type: String,
      default: '',
    },
    skillsRequired: [{ type: String, trim: true }],
    deadline: {
      type: Date,
      required: [true, 'Application deadline is required'],
    },
    contactEmail: {
      type: String,
      required: [true, 'Contact email is required'],
      match: [/^\S+@\S+\.\S+$/, 'Please enter a valid email'],
    },
    image: {
      url: { type: String, default: '' },
      publicId: { type: String, default: '' },
    },
    maxApplicants: {
      type: Number,
      default: 0,
    },
    applicants: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    isActive: {
      type: Boolean,
      default: true,
    },
    viewCount: { type: Number, default: 0 },
    coordinates: {
      lat: { type: Number },
      lng: { type: Number },
    },
    qna: [{
      question: { type: String, required: true },
      askedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      isAnonymous: { type: Boolean, default: false },
      answer: { type: String, default: '' },
      answeredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      answeredAt: { type: Date },
      createdAt: { type: Date, default: Date.now },
    }],
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
      autoFlags: [String],
      adminWindowExpiredAt: Date,
    },
  },
  {
    timestamps: true,
  }
);

// Index for job search
jobPostSchema.index({ title: 'text', description: 'text', skillsRequired: 'text' });
jobPostSchema.index({ postedBy: 1, createdAt: -1 });
jobPostSchema.index({ isActive: 1, deadline: 1 });
jobPostSchema.index({ location: 1, isPaid: 1 });
jobPostSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('JobPost', jobPostSchema);
