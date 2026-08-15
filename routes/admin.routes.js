const express = require('express');
const router = express.Router();
const {
  getAllUsers,
  getUserDetail,
  blockUser,
  unblockUser,
  updateUserNotes,
  deleteUser,
  grantBadge,
  revokeBadge,
  getModerationQueue,
  getContentDetail,
  approveContent,
  rejectContent,
  getAdminSettings,
  updateAdminSettings,
} = require('../controllers/admin.controller');
const authMiddleware = require('../middlewares/auth.middleware');

// Admin middleware to check isAdmin
const adminMiddleware = (req, res, next) => {
  const hasTopContributorBadge = req.user?.badges?.some(
    (badge) => badge.type === 'top_contributor' && badge.isActive !== false
  );
  if (req.user && (req.user.isAdmin || hasTopContributorBadge || (req.user.category === 'school' && req.user.verifiedStatus === 'top_contributor'))) {
    next();
  } else {
    return res.status(403).json({ message: 'Access denied. Admin only.' });
  }
};

router.get('/users', authMiddleware, adminMiddleware, getAllUsers);
router.get('/users/:id', authMiddleware, adminMiddleware, getUserDetail);
router.put('/users/:id/block', authMiddleware, adminMiddleware, blockUser);
router.put('/users/:id/unblock', authMiddleware, adminMiddleware, unblockUser);
router.put('/users/:id/notes', authMiddleware, adminMiddleware, updateUserNotes);
router.put('/users/:id/grant-badge', authMiddleware, adminMiddleware, grantBadge);
router.put('/users/:id/revoke-badge', authMiddleware, adminMiddleware, revokeBadge);
router.delete('/users/:id', authMiddleware, adminMiddleware, deleteUser);
router.get('/settings', authMiddleware, adminMiddleware, getAdminSettings);
router.put('/settings', authMiddleware, adminMiddleware, updateAdminSettings);
router.get('/queue', authMiddleware, adminMiddleware, getModerationQueue);
router.get('/content/:type/:id', authMiddleware, adminMiddleware, getContentDetail);
router.put('/content/:type/:id/approve', authMiddleware, adminMiddleware, approveContent);
router.put('/content/:type/:id/reject', authMiddleware, adminMiddleware, rejectContent);
router.put('/queue/:type/:id/approve', authMiddleware, adminMiddleware, approveContent);
router.put('/queue/:type/:id/reject', authMiddleware, adminMiddleware, rejectContent);

module.exports = router;
