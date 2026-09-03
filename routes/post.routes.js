const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/auth.middleware');
const { optionalAuth } = require('../middlewares/auth.middleware');
const { uploadPostImages } = require('../middlewares/upload.middleware');
const { cacheResponse } = require('../middlewares/cache.middleware');
const {
  getFeed,
  createPost,
  updatePost,
  deletePost,
  toggleLike,
  toggleSave,
  getSavedPosts,
  getPost,
  getNoticeboardPosts,
  votePoll,
  toggleRsvp,
} = require('../controllers/post.controller');

// Static routes before /:id
router.get('/noticeboard', cacheResponse({ ttl: 30 }), getNoticeboardPosts);

// Public routes (feed can be viewed without auth but with optional auth for personalized feed)
router.get('/', optionalAuth, cacheResponse({ ttl: 20, varyByUser: true }), getFeed);
router.get('/saved', authMiddleware, getSavedPosts);
router.get('/:id', optionalAuth, cacheResponse({ ttl: 30, varyByUser: true }), getPost);

// Protected routes
router.post('/', authMiddleware, uploadPostImages.array('images', 5), createPost);
router.put('/:id', authMiddleware, uploadPostImages.array('images', 5), updatePost);
router.delete('/:id', authMiddleware, deletePost);
router.post('/:id/like', authMiddleware, toggleLike);
router.post('/:id/save', authMiddleware, toggleSave);
router.post('/:id/vote', authMiddleware, votePoll);
router.post('/:id/rsvp', authMiddleware, toggleRsvp);

module.exports = router;
