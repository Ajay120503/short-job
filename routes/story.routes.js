const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/auth.middleware');
const { optionalAuth } = require('../middlewares/auth.middleware');
const { uploadImage } = require('../middlewares/upload.middleware');
const {
  createStory,
  getStories,
  viewStory,
  deleteStory,
} = require('../controllers/story.controller');

// Stories are public after approval; auth adds own pending stories and view state.
router.get('/', optionalAuth, getStories);
router.post('/', authMiddleware, uploadImage.single('image'), createStory);
router.post('/:id/view', authMiddleware, viewStory);
router.delete('/:id', authMiddleware, deleteStory);

module.exports = router;
