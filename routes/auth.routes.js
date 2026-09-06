const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const {
  register,
  initiateRegister,
  verifyRegisterOtp,
  resendRegistrationOtp,
  login,
  completeLoginAudit,
  logout,
  verifyEmail,
  forgotPassword,
  resetPassword,
  getMe,
  refreshToken,
  deleteAccount,
} = require('../controllers/auth.controller');
const authMiddleware = require('../middlewares/auth.middleware');
const { uploadImage } = require('../middlewares/upload.middleware');

// Validation rules
const registerValidation = [
  body('name').trim().notEmpty().withMessage('Name is required').isLength({ max: 100 }),
  body('email').isEmail().withMessage('Please enter a valid email').isLength({ max: 254 }).withMessage('Email cannot exceed 254 characters'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters').isLength({ max: 128 }).withMessage('Password cannot exceed 128 characters'),
];

const loginValidation = [
  body('email').isEmail().withMessage('Please enter a valid email').isLength({ max: 254 }).withMessage('Email cannot exceed 254 characters'),
  body('password').notEmpty().withMessage('Password is required').isLength({ max: 128 }).withMessage('Password cannot exceed 128 characters'),
];

const forgotPasswordValidation = [
  body('email').isEmail().withMessage('Please enter a valid email').isLength({ max: 254 }).withMessage('Email cannot exceed 254 characters'),
];

const resetPasswordValidation = [
  body('email').isEmail().withMessage('Valid email is required'),
  body('otp').notEmpty().withMessage('OTP is required'),
  body('newPassword').isLength({ min: 6 }).withMessage('Password must be at least 6 characters').isLength({ max: 128 }).withMessage('Password cannot exceed 128 characters'),
];

// Public routes
router.post('/register/initiate', registerValidation, initiateRegister);
router.post('/register/verify-otp', verifyRegisterOtp);
router.post('/otp/resend', resendRegistrationOtp);
router.post('/register', registerValidation, register);
router.post('/login', loginValidation, login);
router.post('/login/complete-audit', uploadImage.single('photo'), completeLoginAudit);
router.post('/logout', logout);
router.get('/verify-email/:token', verifyEmail);
router.post('/forgot-password', forgotPasswordValidation, forgotPassword);
router.post('/reset-password', resetPasswordValidation, resetPassword);
router.post('/refresh-token', refreshToken);

// Protected routes
router.get('/me', authMiddleware, getMe);
router.delete('/me', authMiddleware, deleteAccount);

module.exports = router;
