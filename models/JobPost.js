const mongoose = require('mongoose');

const locationPointSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['Point'],
      required: true,
    },
    coordinates: {
      type: [Number],
      required: true,
      validate: {
        validator: (coordinates) =>
          Array.isArray(coordinates) &&
          coordinates.length === 2 &&
          coordinates.every(Number.isFinite),
        message: 'Location point must contain valid longitude and latitude coordinates',
      },
    },
  },
  { _id: false },
);

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
      minlength: [3, 'Organization name must contain at least 3 characters'],
      maxlength: [50, 'Organization name cannot exceed 50 characters'],
    },
    institutionLogo: {
      url: { type: String, default: '' },
      publicId: { type: String, default: '' },
    },
    title: {
      type: String,
      required: [true, 'Job title is required'],
      trim: true,
      minlength: [3, 'Job title must contain at least 3 characters'],
      maxlength: [50, 'Job title cannot exceed 50 characters'],
    },
    description: {
      type: String,
      maxlength: [200, 'Description cannot exceed 200 characters'],
      default: '',
    },
    roleType: {
      type: String,
      enum: ['teacher', 'professor', 'hod', 'principal', 'intern', 'volunteer', 'assistant', 'research', 'other'],
      default: 'other',
    },
    shortJobType: {
      type: String,
      // Legacy values remain readable so older records can still be migrated or edited;
      // the create/update controllers only accept the four current short-job types.
      enum: ['few_hours', 'one_day_gig', 'weekend_only', 'short_term', 'ongoing_part_time', 'full_time', 'internship', 'volunteer'],
      required: [true, 'Short job type is required'],
    },
    duration: {
      unit: { type: String, enum: ['hours', 'days'], required: true },
      value: { type: Number, required: true, min: [0.25, 'Duration must be at least 0.25'] },
    },
    workingHoursPerDay: {
      type: Number,
      min: [0.25, 'Working hours per day must be at least 0.25'],
      max: [24, 'Working hours per day cannot exceed 24'],
      default: undefined,
    },
    jobDate: {
      type: Date,
    },
    startTime: {
      type: String,
      match: [/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Start time must use HH:mm format'],
      default: '',
    },
    endTime: {
      type: String,
      match: [/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'End time must use HH:mm format'],
      default: '',
    },
    isPaid: {
      type: Boolean,
      default: true,
    },
    currency: {
      type: String,
      enum: ['INR', 'USD'],
      default: 'INR',
    },
    stipend: {
      type: Number,
      required: [true, 'Payout / salary is required'],
      min: [0.01, 'Payout / salary must be at least 0.01'],
      max: [1000000000, 'Payout / salary cannot exceed 1,000,000,000'],
      validate: {
        validator: (value) => Math.abs(value - Math.round(value * 100) / 100) < 1e-9,
        message: 'Payout / salary can have no more than 2 decimal places',
      },
    },
    location: {
      type: String,
      enum: ['onsite', 'remote', 'hybrid'],
      default: 'onsite',
    },
    workplaceName: {
      type: String,
      required: function requireWorkplaceName() { return this.location !== 'remote'; },
      trim: true,
      minlength: [3, 'Workplace name must contain at least 3 characters'],
      maxlength: [50, 'Workplace name cannot exceed 50 characters'],
    },
    workplaceAddress: {
      type: String,
      required: function requireWorkplaceAddress() { return this.location !== 'remote'; },
      trim: true,
      minlength: [3, 'Street address must contain at least 3 characters'],
      maxlength: [100, 'Street address cannot exceed 100 characters'],
    },
    workplaceCity: {
      type: String,
      required: function requireWorkplaceCity() { return this.location !== 'remote'; },
      trim: true,
      minlength: [3, 'City must contain at least 3 characters'],
      maxlength: [50, 'City cannot exceed 50 characters'],
    },
    workplaceState: {
      type: String,
      required: function requireWorkplaceState() { return this.location !== 'remote'; },
      trim: true,
      minlength: [3, 'State must contain at least 3 characters'],
      maxlength: [50, 'State cannot exceed 50 characters'],
    },
    workplaceCountry: {
      type: String,
      required: function requireWorkplaceCountry() { return this.location !== 'remote'; },
      trim: true,
      minlength: [3, 'Country must contain at least 3 characters'],
      maxlength: [50, 'Country cannot exceed 50 characters'],
    },
    requiredQualifications: {
      type: String,
      maxlength: [258, 'Required qualifications cannot exceed 5 entries of 50 characters'],
      default: '',
    },
    skillsRequired: {
      type: [{ type: String, trim: true, minlength: [3, 'Each skill must contain at least 3 characters'], maxlength: [50, 'Each skill must be 50 characters or fewer'] }],
      validate: {
        validator: (items) => (items || []).length <= 5,
        message: 'Add no more than 5 skills',
      },
      default: [],
    },
    deadline: {
      type: Date,
      required: [true, 'Application deadline is required'],
    },
    contactEmail: {
      type: String,
      required: [true, 'Contact email is required'],
      maxlength: [254, 'Contact email cannot exceed 254 characters'],
      match: [/^\S+@\S+\.\S+$/, 'Please enter a valid email'],
      validate: {
        validator: (value) => {
          const local = String(value || '').split('@')[0];
          return local.length >= 2 && local.length <= 20;
        },
        message: 'Email must contain 2 to 20 characters before @',
      },
    },
    image: {
      url: { type: String, default: '' },
      publicId: { type: String, default: '' },
    },
    maxApplicants: {
      type: Number,
      min: [0, 'Applicant limit cannot be negative'],
      max: [100, 'Applicant limit cannot exceed 100'],
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
    // Keep this field absent when geocoding is unavailable. A partial GeoJSON
    // point (for example, `{ type: 'Point' }`) is rejected by the 2dsphere index.
    location_point: {
      type: locationPointSchema,
      default: undefined,
    },
    qna: [{
      question: { type: String, required: true, trim: true, maxlength: [500, 'Question cannot exceed 500 characters'] },
      askedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      isAnonymous: { type: Boolean, default: false },
      answer: { type: String, trim: true, maxlength: [2000, 'Answer cannot exceed 2000 characters'], default: '' },
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
      autoFlags: [mongoose.Schema.Types.Mixed],
      autoReason: String,
      autoDecision: String,
      autoSeverity: String,
      autoReviewedAt: Date,
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
jobPostSchema.index({ workplaceCity: 1, workplaceState: 1 });
jobPostSchema.index({ status: 1, createdAt: -1 });
jobPostSchema.index({ location_point: '2dsphere' });

module.exports = mongoose.model('JobPost', jobPostSchema);
