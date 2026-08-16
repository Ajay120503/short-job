const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { validationResult } = require('express-validator');
const User = require('../models/User');
const Post = require('../models/Post');
const Comment = require('../models/Comment');
const Application = require('../models/Application');
const JobPost = require('../models/JobPost');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Notification = require('../models/Notification');
const { sendVerificationEmail, sendPasswordResetOTP, sendRegistrationOTP } = require('../utils/email');
const { getIO } = require('../config/socket');

// Generate JWT Token
const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRE || '7d',
  });
};

// Generate Refresh Token
const generateRefreshToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRE || '30d',
  });
};

// Set cookies (for web)
const setTokenCookies = (res, accessToken, refreshToken) => {
  res.cookie('token', accessToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  });

  res.cookie('refreshToken', refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  });
};

const OTP_EXPIRY_MS = 10 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const OTP_RESEND_WINDOW_MS = 60 * 60 * 1000;
const OTP_RESEND_LIMIT = 5;

const generateOtp = () => crypto.randomInt(100000, 1000000).toString();

const setRegistrationOtp = async (user) => {
  const otp = generateOtp();
  user.otp = await bcrypt.hash(otp, 10);
  user.otpExpiry = new Date(Date.now() + OTP_EXPIRY_MS);
  user.otpAttempts = 0;
  user.otpLastSentAt = new Date();

  const windowExpired =
    !user.otpResendWindowStart ||
    Date.now() - user.otpResendWindowStart.getTime() > OTP_RESEND_WINDOW_MS;
  if (windowExpired) {
    user.otpResendWindowStart = new Date();
    user.otpResendCount = 1;
  } else {
    user.otpResendCount = (user.otpResendCount || 0) + 1;
  }

  await user.save();
  return otp;
};

// @desc    Initiate registration with email OTP
// @route   POST /api/auth/register/initiate
const initiateRegister = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: errors.array()[0].msg });
    }

    const { name, email, password } = req.body;
    const normalizedEmail = email.toLowerCase().trim();
    const existingUser = await User.findOne({ email: normalizedEmail }).select('+otp');

    if (existingUser?.isActive) {
      return res.status(400).json({ message: 'User with this email already exists.' });
    }

    if (existingUser) {
      existingUser.name = name;
      existingUser.password = password;
      existingUser.authMethod = 'email';
      existingUser.isActive = false;
      existingUser.isVerified = false;
      existingUser.isEmailVerified = false;
      const otp = await setRegistrationOtp(existingUser);
      await sendRegistrationOTP(normalizedEmail, name, otp);
      return res.status(200).json({ success: true, message: 'OTP sent to your email.', email: normalizedEmail });
    }

    const user = await User.create({
      name,
      email: normalizedEmail,
      password,
      badges: [],
      authMethod: 'email',
      isActive: false,
      isVerified: false,
      isEmailVerified: false,
    });

    const otp = await setRegistrationOtp(user);
    await sendRegistrationOTP(normalizedEmail, name, otp);

    res.status(201).json({ success: true, message: 'OTP sent to your email.', email: normalizedEmail });
  } catch (error) {
    console.error('Initiate registration error:', error);
    res.status(500).json({ message: 'Server error during registration.' });
  }
};

// @desc    Verify registration OTP
// @route   POST /api/auth/register/verify-otp
const verifyRegisterOtp = async (req, res) => {
  try {
    const { email, otp } = req.body;
    const normalizedOtp = String(otp || '').trim();
    if (!email || !normalizedOtp) {
      return res.status(400).json({ message: 'Email and OTP are required.' });
    }

    const user = await User.findOne({ email: email.toLowerCase().trim(), isActive: false }).select('+otp +password');
    if (!user) {
      return res.status(404).json({ message: 'No pending registration found.' });
    }

    if (!user.otp || !user.otpExpiry || user.otpExpiry < new Date()) {
      return res.status(410).json({ message: 'OTP expired. Please request a new code.' });
    }

    const isValid = await bcrypt.compare(normalizedOtp, user.otp);
    if (!isValid) {
      user.otpAttempts = (user.otpAttempts || 0) + 1;
      if (user.otpAttempts >= 3) {
        user.otp = undefined;
        user.otpExpiry = undefined;
        await user.save();
        return res.status(403).json({ message: 'Too many invalid attempts. Please resend OTP.' });
      }
      await user.save();
      return res.status(401).json({ message: 'Invalid OTP.', attemptsLeft: 3 - user.otpAttempts });
    }

    user.isActive = true;
    user.isVerified = true;
    user.isEmailVerified = true;
    user.verifiedStatus = 'email';
    user.otp = undefined;
    user.otpExpiry = undefined;
    user.otpAttempts = 0;
    user.badges = [
      ...(user.badges || []).filter((badge) => badge.type !== 'email_verified'),
      { type: 'email_verified', grantedBy: 'system', grantedAt: new Date(), isActive: true },
    ];
    await user.save();

    const accessToken = generateToken(user._id);
    const refreshToken = generateRefreshToken(user._id);
    setTokenCookies(res, accessToken, refreshToken);

    const userData = user.toObject();
    delete userData.password;
    delete userData.otp;

    res.json({
      success: true,
      message: 'Account activated.',
      user: userData,
      accessToken,
      redirectTo: '/complete-profile',
    });
  } catch (error) {
    console.error('Verify registration OTP error:', error);
    res.status(500).json({ message: 'Server error during OTP verification.' });
  }
};

// @desc    Resend registration OTP
// @route   POST /api/auth/otp/resend
const resendRegistrationOtp = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ message: 'Email is required.' });
    }

    const user = await User.findOne({ email: email.toLowerCase().trim(), isActive: false }).select('+otp');
    if (!user) {
      return res.status(404).json({ message: 'No pending registration found.' });
    }

    if (user.otpLastSentAt && Date.now() - user.otpLastSentAt.getTime() < OTP_RESEND_COOLDOWN_MS) {
      return res.status(429).json({ message: 'Please wait before requesting another OTP.' });
    }

    const inWindow =
      user.otpResendWindowStart &&
      Date.now() - user.otpResendWindowStart.getTime() <= OTP_RESEND_WINDOW_MS;
    if (inWindow && (user.otpResendCount || 0) >= OTP_RESEND_LIMIT) {
      return res.status(429).json({ message: 'OTP resend limit reached. Please try again later.' });
    }

    const otp = await setRegistrationOtp(user);
    await sendRegistrationOTP(user.email, user.name, otp);

    res.json({ success: true, message: 'OTP resent to your email.', email: user.email });
  } catch (error) {
    console.error('Resend registration OTP error:', error);
    res.status(500).json({ message: 'Server error while resending OTP.' });
  }
};

// @desc    Register a new user
// @route   POST /api/auth/register
const register = async (req, res) => {
  try {
    // Check validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: errors.array()[0].msg });
    }

    const { name, email, password } = req.body;

    // Check if user exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: 'User with this email already exists.' });
    }

    // Generate verification token
    const verificationToken = crypto.randomBytes(32).toString('hex');

    // Create user WITHOUT role - badges will be selected later in profile completion
    const user = await User.create({
      name,
      email,
      password,
      badges: [], // Start with no badges - user selects them in profile wizard
      verificationToken,
      verificationTokenExpires: Date.now() + 60 * 60 * 1000, // 1 hour
    });

    // Send verification email (fire-and-forget: don't block the response)
    sendVerificationEmail(email, name, verificationToken).catch((emailError) => {
      console.error('Email sending failed:', emailError);
      // Don't fail registration if email fails - user can resend verification
    });

    // Generate tokens
    const accessToken = generateToken(user._id);
    const refreshToken = generateRefreshToken(user._id);

    // Set cookies
    setTokenCookies(res, accessToken, refreshToken);

    // Return user data (without password)
    const userData = user.toObject();
    delete userData.password;

    res.status(201).json({
      success: true,
      message: 'Registration successful. Please verify your email.',
      user: userData,
      accessToken,
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ message: 'Server error during registration.' });
  }
};

// @desc    Login user
// @route   POST /api/auth/login
const login = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: errors.array()[0].msg });
    }

    const { email, password } = req.body;

    // Find user with password
    const user = await User.findOne({ email }).select('+password');
    if (!user) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    // Check password
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    if (user.isActive === false) {
      return res.status(403).json({ message: 'Please verify your email before logging in.' });
    }

    if (user.isBlocked) {
      return res.status(403).json({
        error: 'account_suspended',
        message: 'Your account has been suspended.',
        reason: user.blockedReason,
      });
    }

    // Generate tokens
    const accessToken = generateToken(user._id);
    const refreshToken = generateRefreshToken(user._id);

    // Set cookies
    setTokenCookies(res, accessToken, refreshToken);

    // Return user data
    const userData = user.toObject();
    delete userData.password;

    res.json({
      success: true,
      message: 'Login successful.',
      user: userData,
      accessToken,
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Server error during login.' });
  }
};

// @desc    Logout user
// @route   POST /api/auth/logout
const logout = async (req, res) => {
  res.cookie('token', '', {
    httpOnly: true,
    expires: new Date(0),
  });
  res.cookie('refreshToken', '', {
    httpOnly: true,
    expires: new Date(0),
  });

  res.json({ success: true, message: 'Logged out successfully.' });
};

// @desc    Verify email
// @route   GET /api/auth/verify-email/:token
const verifyEmail = async (req, res) => {
  try {
    const { token } = req.params;

    const user = await User.findOne({
      verificationToken: token,
      verificationTokenExpires: { $gt: Date.now() },
    });

    if (!user) {
      return res.status(400).json({ message: 'Invalid or expired verification token.' });
    }

    user.isVerified = true;
    user.isEmailVerified = true;
    user.verifiedStatus = user.verifiedStatus === 'none' ? 'email' : user.verifiedStatus;
    const hasEmailBadge = user.badges?.some((badge) => badge.type === 'email_verified' && badge.isActive !== false);
    if (!hasEmailBadge) {
      user.badges.push({ type: 'email_verified', grantedBy: 'system', grantedAt: new Date(), isActive: true });
    }
    user.verificationToken = undefined;
    user.verificationTokenExpires = undefined;
    await user.save();

    res.json({ success: true, message: 'Email verified successfully.' });
  } catch (error) {
    console.error('Verify email error:', error);
    res.status(500).json({ message: 'Server error during email verification.' });
  }
};

// @desc    Forgot password - send OTP
// @route   POST /api/auth/forgot-password
const forgotPassword = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: errors.array()[0].msg });
    }

    const { email } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: 'No user found with this email.' });
    }

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    // console.log(otp);

    user.resetPasswordToken = otp;
    user.resetPasswordExpires = Date.now() + 15 * 60 * 1000; // 15 minutes
    await user.save();

    // Send OTP email
    try {
      await sendPasswordResetOTP(email, otp);
    } catch (emailError) {
      console.error('Email sending failed:', emailError);
    }

    res.json({ success: true, message: 'Password reset OTP sent to your email.' });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Reset password with OTP
// @route   POST /api/auth/reset-password
const resetPassword = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: errors.array()[0].msg });
    }

    const { email, otp, newPassword } = req.body;

    const user = await User.findOne({
      email,
      resetPasswordToken: otp,
      resetPasswordExpires: { $gt: Date.now() },
    });

    if (!user) {
      return res.status(400).json({ message: 'Invalid or expired OTP.' });
    }

    user.password = newPassword;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    res.json({ success: true, message: 'Password reset successful. You can now log in.' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Get current user
// @route   GET /api/auth/me
const getMe = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    res.json({ success: true, user });
  } catch (error) {
    console.error('Get me error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Refresh access token
// @route   POST /api/auth/refresh-token
const refreshToken = async (req, res) => {
  try {
    const refreshToken = req.cookies?.refreshToken;

    if (!refreshToken) {
      return res.status(401).json({ message: 'No refresh token.' });
    }

    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    const user = await User.findById(decoded.id);

    if (!user) {
      return res.status(401).json({ message: 'User not found.' });
    }

    const newAccessToken = generateToken(user._id);
    setTokenCookies(res, newAccessToken, refreshToken);

    res.json({ success: true, accessToken: newAccessToken });
  } catch (error) {
    return res.status(401).json({ message: 'Invalid refresh token.' });
  }
};

// @desc    Delete user account and all related data
// @route   DELETE /api/auth/me
const deleteAccount = async (req, res) => {
  try {
    const userId = req.user._id;

    // First, get all comment IDs made by this user to clean up Post references
    const userCommentIds = await Comment.find({ user: userId }).distinct('_id');

    // Run all deletions and cleanups in parallel
    await Promise.all([
      // Delete user's own documents
      User.findByIdAndDelete(userId),
      Post.deleteMany({ user: userId }),
      Comment.deleteMany({ user: userId }),
      Application.deleteMany({ user: userId }),
      JobPost.deleteMany({ postedBy: userId }),
      Conversation.deleteMany({ participants: userId }),
      Message.deleteMany({ sender: userId }),
      Notification.deleteMany({ recipient: userId }),

      // Remove user's likes from all posts
      Post.updateMany({ likes: userId }, { $pull: { likes: userId } }),
      // Remove user's saves from all posts
      Post.updateMany({ savedBy: userId }, { $pull: { savedBy: userId } }),
      // Remove user's comment references from posts
      Post.updateMany({ comments: { $in: userCommentIds } }, { $pull: { comments: { $in: userCommentIds } } }),

      // Remove user from followers/following lists of other users
      User.updateMany({ followers: userId }, { $pull: { followers: userId } }),
      User.updateMany({ following: userId }, { $pull: { following: userId } }),
    ]);

    // Clear cookies
    res.cookie('token', '', { httpOnly: true, expires: new Date(0) });
    res.cookie('refreshToken', '', { httpOnly: true, expires: new Date(0) });

    res.json({ success: true, message: 'Account deleted successfully.' });
  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({ message: 'Server error during account deletion.' });
  }
};

module.exports = {
  initiateRegister,
  verifyRegisterOtp,
  resendRegistrationOtp,
  register,
  login,
  logout,
  verifyEmail,
  forgotPassword,
  resetPassword,
  getMe,
  refreshToken,
  deleteAccount,
};
