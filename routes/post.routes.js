const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/auth.middleware');
const { optionalAuth } = require('../middlewares/auth.middleware');
const { uploadPostImages } = require('../middlewares/upload.middleware');
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
} = require('../controllers/post.controller');

// Static routes before /:id
router.get('/noticeboard', getNoticeboardPosts);

// Public routes (feed can be viewed without auth but with optional auth for personalized feed)
router.get('/', optionalAuth, getFeed);
router.get('/saved', authMiddleware, getSavedPosts);
router.get('/:id', optionalAuth, getPost);

// Protected routes
router.post('/', authMiddleware, uploadPostImages.array('images', 5), createPost);
router.put('/:id', authMiddleware, uploadPostImages.array('images', 5), updatePost);
router.delete('/:id', authMiddleware, deletePost);
router.post('/:id/like', authMiddleware, toggleLike);
router.post('/:id/save', authMiddleware, toggleSave);

module.exports = router;
