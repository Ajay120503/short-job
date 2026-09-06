const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { PERSON_NAME_MAX_LENGTH, isValidPersonName } = require('../utils/createValidation');

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Full name is required'],
      trim: true,
      minlength: [2, 'Name must contain at least 2 characters'],
      maxlength: [PERSON_NAME_MAX_LENGTH, `Name cannot exceed ${PERSON_NAME_MAX_LENGTH} characters`],
      match: [/^[\p{L}\p{M} .'-]+$/u, 'Name can contain only letters, spaces, apostrophes, periods, and hyphens'],
      validate: {
        validator: isValidPersonName,
        message: 'Name must contain at least 2 letters',
      },
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: [254, 'Email cannot exceed 254 characters'],
      match: [/^\S+@\S+\.\S+$/, 'Please enter a valid email'],
    },
    phone: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [6, 'Password must be at least 6 characters'],
      maxlength: [128, 'Password cannot exceed 128 characters'],
      select: false,
    },
    authMethod: {
      type: String,
      enum: ['email', 'google', 'phone'],
      default: 'email',
    },
    otp: { type: String, select: false },
    otpExpiry: { type: Date },
    otpAttempts: { type: Number, default: 0 },
    otpLastSentAt: { type: Date },
    otpResendCount: { type: Number, default: 0 },
    otpResendWindowStart: { type: Date },
    isActive: {
      type: Boolean,
      default: true,
    },
    isEmailVerified: {
      type: Boolean,
      default: false,
    },
    isPhoneVerified: {
      type: Boolean,
      default: false,
    },
    badges: [{
      type: {
        type: String,
        enum: [
          // Legacy identity
          'student', 'teacher', 'professor', 'principal', 'hod',
          'researcher', 'phd_scholar', 'lecturer',
          // Institution type
          'school_member', 'college_member', 'university_member', 'coaching_member',
          // Skills / domain
          'stem_expert', 'arts_expert', 'sports_coach', 'counselor',
          // Trust
          'verified_institution', 'top_contributor', 'email_verified', 'phone_verified',
          // Platform
        'platform owner', 'platform_owner'
        ]
      },
      grantedAt: { type: Date, default: Date.now },
      grantedBy: { type: String, enum: ['self', 'admin', 'system'], default: 'self' },
      isActive: { type: Boolean, default: true }
    }],
    category: {
      type: String,
      enum: ['student', 'school', 'college', 'platform owner', 'platform_owner'],
      default: 'student',
    },
    profilePic: {
      url: { type: String, default: '' },
      publicId: { type: String, default: '' },
    },
    institutionName: {
      type: String,
      trim: true,
      maxlength: [150, 'Organization name cannot exceed 150 characters'],
      default: '',
    },
    institutionPic: {
      url: { type: String, default: '' },
      publicId: { type: String, default: '' },
    },
    institutionType: {
      type: String,
      enum: ['school', 'college', 'university', 'coaching', 'none', ''],
      default: 'none',
    },
    bio: {
      type: String,
      maxlength: [200, 'Bio cannot exceed 200 characters'],
      default: '',
    },
    age: {
      type: Number,
      min: 18,
      max: 100,
    },
    currentLocation: {
      lat: Number,
      lng: Number,
      city: { type: String, default: '' },
      state: { type: String, default: '' },
      updatedAt: Date,
    },
    dateOfBirth: {
      type: Date,
    },
    educationLevel: {
      type: String,
      enum: ['10th', '12th', 'undergraduate', 'postgraduate', 'phd', ''],
      default: '',
    },
    subject: {
      type: String,
      trim: true,
      maxlength: [100, 'Subject cannot exceed 100 characters'],
      default: '',
    },
    experience: {
      type: Number,
      min: [0, 'Experience cannot be negative'],
      max: [80, 'Experience cannot exceed 80 years'],
      default: 0,
    },
    skills: [{ type: String, trim: true, maxlength: [50, 'Each skill must be 50 characters or fewer'] }],
    qualifications: [{ type: String, trim: true, maxlength: [100, 'Each qualification must be 100 characters or fewer'] }],
    address: {
      type: String,
      trim: true,
      maxlength: [300, 'Address cannot exceed 300 characters'],
      default: '',
    },
    city: {
      type: String,
      trim: true,
      maxlength: [100, 'City cannot exceed 100 characters'],
      default: '',
    },
    state: {
      type: String,
      trim: true,
      maxlength: [100, 'State cannot exceed 100 characters'],
      default: '',
    },
    linkedinUrl: {
      type: String,
      trim: true,
      maxlength: [500, 'LinkedIn URL cannot exceed 500 characters'],
      match: [/^(?:https?:\/\/)?(?:www\.)?linkedin\.com\/.+/i, 'Please enter a valid LinkedIn URL'],
      default: '',
    },
    resumeUrl: {
      type: String,
      default: '',
    },
    profession: {
      type: String,
      trim: true,
      maxlength: [120, 'Profession cannot exceed 120 characters'],
      default: '',
    },
    isCurrentlyWorking: { type: Boolean, default: false },
    currentPosition: { type: String, trim: true, maxlength: [120, 'Current position cannot exceed 120 characters'], default: '' },
    currentCompany: { type: String, trim: true, maxlength: [150, 'Current workplace cannot exceed 150 characters'], default: '' },
    previousWork: { type: String, trim: true, maxlength: [1000, 'Previous work cannot exceed 1000 characters'], default: '' },
    lastActiveAt: { type: Date },
    activeDays: [{ type: String }],
    interests: [{ type: String, trim: true, maxlength: [50, 'Each interest must be 50 characters or fewer'] }],
    followers: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    following: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    isVerified: {
      type: Boolean,
      default: false,
    },
    verifiedStatus: {
      type: String,
      enum: ['none', 'email', 'institution', 'top_contributor', 'platform_owner'],
      default: 'none',
    },
    verificationDocuments: [{
      url: { type: String },
      publicId: { type: String },
      uploadedAt: { type: Date, default: Date.now },
    }],
    openToOpportunities: { type: Boolean, default: false },
    showOnlineStatus: { type: Boolean, default: true },
    locationAccessEnabled: { type: Boolean, default: false },
    loginAuditEnabled: { type: Boolean, default: true },
    profileThemeVariant: {
      type: String,
      enum: ['teal', 'coral', 'emerald', 'amber', 'indigo', 'sky', 'deep-teal', 'rose', 'slate', 'violet', 'pink', 'premium'],
      default: 'teal',
    },
    isAdmin: { type: Boolean, default: false },
    isSuperAdmin: { type: Boolean, default: false },
    isBlocked: { type: Boolean, default: false },
    blockedAt: Date,
    blockedReason: String,
    adminNotes: { type: String, maxlength: [2000, 'Admin notes cannot exceed 2000 characters'], default: '' },
    profileStrength: { type: Number, default: 0 },
    skillEndorsements: {
      type: Map,
      of: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
      default: new Map(),
    },
    timeline: [{
      year: { type: String },
      endYear: { type: String, default: '' },
      title: { type: String, maxlength: [150, 'Milestone title cannot exceed 150 characters'] },
      institution: { type: String, maxlength: [150, 'Milestone organization cannot exceed 150 characters'] },
      type: { type: String, enum: ['school', 'college', 'course', 'certification', 'internship', 'work', 'promotion', 'project', 'volunteer', 'award', 'achievement'] },
      description: { type: String, maxlength: 500, default: '' },
      location: { type: String, maxlength: 120, default: '' },
      skills: [{ type: String, trim: true, maxlength: 50 }],
      link: { type: String, maxlength: 500, default: '' },
    }],
    verificationToken: String,
    verificationTokenExpires: Date,
    resetPasswordToken: String,
    resetPasswordExpires: Date,
  },
  {
    timestamps: true,
  }
);

// Index for search
userSchema.index({ name: 'text', institutionName: 'text', skills: 'text', subject: 'text' });

// Hash password before saving
userSchema.pre('save', async function () {
  if (!this.isModified('password')) return;
  this.password = await bcrypt.hash(this.password, 12);
});

// Compare password method
userSchema.methods.comparePassword = async function (candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
