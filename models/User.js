const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Full name is required'],
      trim: true,
      maxlength: [100, 'Name cannot exceed 100 characters'],
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
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
      default: '',
    },
    experience: {
      type: Number,
      default: 0,
    },
    skills: [{ type: String, trim: true }],
    qualifications: [{ type: String, trim: true }],
    address: {
      type: String,
      trim: true,
      default: '',
    },
    city: {
      type: String,
      trim: true,
      default: '',
    },
    state: {
      type: String,
      trim: true,
      default: '',
    },
    linkedinUrl: {
      type: String,
      trim: true,
      default: '',
    },
    resumeUrl: {
      type: String,
      default: '',
    },
    profession: {
      type: String,
      trim: true,
      default: '',
    },
    isCurrentlyWorking: { type: Boolean, default: false },
    currentPosition: { type: String, trim: true, default: '' },
    currentCompany: { type: String, trim: true, default: '' },
    previousWork: { type: String, trim: true, default: '' },
    lastActiveAt: { type: Date },
    activeDays: [{ type: String }],
    interests: [{ type: String, trim: true }],
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
    adminNotes: { type: String, default: '' },
    profileStrength: { type: Number, default: 0 },
    skillEndorsements: {
      type: Map,
      of: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
      default: new Map(),
    },
    timeline: [{
      year: { type: String },
      title: { type: String },
      institution: { type: String },
      type: { type: String, enum: ['school', 'college', 'work', 'achievement'] },
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
