const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const authMiddleware = require('../middlewares/auth.middleware');
const { optionalAuth } = require('../middlewares/auth.middleware');
const { requireSuperAdmin } = require('../middlewares/role.middleware');
const { uploadProfile } = require('../middlewares/upload.middleware');
const { cacheResponse } = require('../middlewares/cache.middleware');
const {
  getUserProfile,
  updateProfile,
  followUser,
  searchUsers,
  getUserPosts,
  getUserJobs,
  getFollowers,
  getFollowing,
  verifyUser,
  requestVerification,
  endorseSkill,
  toggleOpportunityStatus,
  updateTimeline,
  updateMyBadges,
  getUserBadges,
  getOnlineUserIds,
  getMyLoginHistory,
  deleteMyLoginRecord,
  updateMyLoginAuditPreference,
  updateCurrentLocation,
} = require('../controllers/user.controller');

router.param('id', (req, res, next, id) => {
  if (!mongoose.isObjectIdOrHexString(id)) {
    return res.status(400).json({ message: 'Invalid user ID.' });
  }
  next();
});

// Static routes MUST be before /:id
router.patch('/me/opportunity-status', authMiddleware, toggleOpportunityStatus);
router.post('/me/badges', authMiddleware, updateMyBadges);
router.post('/request-verification', authMiddleware, uploadProfile.single('document'), requestVerification);
router.get('/online', authMiddleware, getOnlineUserIds);
router.patch('/me/login-audit', authMiddleware, updateMyLoginAuditPreference);
router.patch('/me/location', authMiddleware, updateCurrentLocation);
router.get('/me/login-history', authMiddleware, getMyLoginHistory);
router.delete('/me/login-history/:id', authMiddleware, deleteMyLoginRecord);

// Public routes
router.get('/search', optionalAuth, cacheResponse({ ttl: 30, varyByUser: true }), searchUsers);
router.get('/:id', optionalAuth, cacheResponse({ ttl: 60, varyByUser: true }), getUserProfile);
router.get('/:id/posts', optionalAuth, cacheResponse({ ttl: 30, varyByUser: true }), getUserPosts);
router.get('/:id/jobs', optionalAuth, cacheResponse({ ttl: 30, varyByUser: true }), getUserJobs);
router.get('/:id/followers', cacheResponse({ ttl: 30 }), getFollowers);
router.get('/:id/following', cacheResponse({ ttl: 30 }), getFollowing);
router.get('/:id/badges', cacheResponse({ ttl: 60 }), getUserBadges);

// Protected routes
router.put('/:id', authMiddleware, uploadProfile.fields([
  { name: 'profilePic', maxCount: 1 },
  { name: 'institutionPic', maxCount: 1 },
  { name: 'resume', maxCount: 1 }
]), updateProfile);
router.post('/:id/follow', authMiddleware, followUser);

// F07 — Verified badge
router.put('/admin/:id/verify', authMiddleware, requireSuperAdmin, verifyUser);

// F09 — Skill endorsements
router.post('/:id/skills/:skillName/endorse', authMiddleware, endorseSkill);
router.delete('/:id/skills/:skillName/endorse', authMiddleware, endorseSkill);

// F08 — Timeline
router.put('/:id/timeline', authMiddleware, updateTimeline);

module.exports = router;
