const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/auth.middleware');
const { optionalAuth } = require('../middlewares/auth.middleware');
const { cacheResponse } = require('../middlewares/cache.middleware');
const {
  getComments,
  addComment,
  replyToComment,
  likeComment,
  deleteComment,
} = require('../controllers/comment.controller');

// Public route
router.get('/posts/:postId/comments', optionalAuth, cacheResponse({ ttl: 20, varyByUser: true }), getComments);

// Protected routes
router.post('/posts/:postId/comments', authMiddleware, addComment);
router.post('/comments/:commentId/reply', authMiddleware, replyToComment);
router.post('/comments/:commentId/like', authMiddleware, likeComment);
router.delete('/comments/:commentId', authMiddleware, deleteComment);

module.exports = router;
