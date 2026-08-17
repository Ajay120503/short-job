const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/auth.middleware');
const { optionalAuth } = require('../middlewares/auth.middleware');
const { uploadProfile } = require('../middlewares/upload.middleware');
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
} = require('../controllers/user.controller');

// Static routes MUST be before /:id
router.patch('/me/opportunity-status', authMiddleware, toggleOpportunityStatus);
router.post('/me/badges', authMiddleware, updateMyBadges);
router.post('/request-verification', authMiddleware, uploadProfile.single('document'), requestVerification);

// Public routes
router.get('/search', optionalAuth, searchUsers);
router.get('/:id', optionalAuth, getUserProfile);
router.get('/:id/posts', optionalAuth, getUserPosts);
router.get('/:id/jobs', optionalAuth, getUserJobs);
router.get('/:id/followers', getFollowers);
router.get('/:id/following', getFollowing);
router.get('/:id/badges', getUserBadges);

// Protected routes
router.put('/:id', authMiddleware, uploadProfile.fields([
  { name: 'profilePic', maxCount: 1 },
  { name: 'institutionPic', maxCount: 1 },
  { name: 'resume', maxCount: 1 }
]), updateProfile);
router.post('/:id/follow', authMiddleware, followUser);

// F07 — Verified badge
router.put('/admin/:id/verify', authMiddleware, verifyUser);

// F09 — Skill endorsements
router.post('/:id/skills/:skillName/endorse', authMiddleware, endorseSkill);
router.delete('/:id/skills/:skillName/endorse', authMiddleware, endorseSkill);

// F08 — Timeline
router.put('/:id/timeline', authMiddleware, updateTimeline);

module.exports = router;
