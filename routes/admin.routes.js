const express = require('express');
const router = express.Router();
const {
  getAllUsers,
  getUserDetail,
  blockUser,
  unblockUser,
  updateUserNotes,
  updateUserLoginAudit,
  deleteUser,
  grantBadge,
  revokeBadge,
  makeAdmin,
  removeAdmin,
  getModerationQueue,
  getModerationArchive,
  getContentDetail,
  runContentRuleCheck,
  approveContent,
  rejectContent,
  getAdminSettings,
  updateAdminSettings,
  getLoginRecords,
  getLoginRecordDetail,
  getUserLoginRecords,
  deleteLoginRecord,
} = require('../controllers/admin.controller');
const authMiddleware = require('../middlewares/auth.middleware');
const { requireAdmin, requireSuperAdmin } = require('../middlewares/role.middleware');

router.get('/users', authMiddleware, requireAdmin, getAllUsers);
router.get('/users/:id', authMiddleware, requireAdmin, getUserDetail);
router.put('/users/:id/block', authMiddleware, requireSuperAdmin, blockUser);
router.put('/users/:id/unblock', authMiddleware, requireSuperAdmin, unblockUser);
router.put('/users/:id/notes', authMiddleware, requireAdmin, updateUserNotes);
router.put('/users/:id/login-audit', authMiddleware, requireSuperAdmin, updateUserLoginAudit);
router.put('/users/:id/grant-badge', authMiddleware, requireSuperAdmin, grantBadge);
router.put('/users/:id/revoke-badge', authMiddleware, requireSuperAdmin, revokeBadge);
router.put('/users/:id/make-admin', authMiddleware, requireSuperAdmin, makeAdmin);
router.put('/users/:id/remove-admin', authMiddleware, requireSuperAdmin, removeAdmin);
router.delete('/users/:id', authMiddleware, requireSuperAdmin, deleteUser);
router.get('/settings', authMiddleware, requireAdmin, getAdminSettings);
router.put('/settings', authMiddleware, requireSuperAdmin, updateAdminSettings);
router.get('/login-records', authMiddleware, requireAdmin, getLoginRecords);
router.get('/login-records/user/:userId', authMiddleware, requireAdmin, getUserLoginRecords);
router.get('/login-records/:id', authMiddleware, requireAdmin, getLoginRecordDetail);
router.delete('/login-records/:id', authMiddleware, requireSuperAdmin, deleteLoginRecord);
router.get('/queue', authMiddleware, requireAdmin, getModerationQueue);
router.get('/archive', authMiddleware, requireAdmin, getModerationArchive);
router.get('/content/:type/:id', authMiddleware, requireAdmin, getContentDetail);
router.put('/content/:type/:id/run-check', authMiddleware, requireAdmin, runContentRuleCheck);
router.put('/content/:type/:id/approve', authMiddleware, requireAdmin, approveContent);
router.put('/content/:type/:id/reject', authMiddleware, requireAdmin, rejectContent);
router.put('/queue/:type/:id/approve', authMiddleware, requireAdmin, approveContent);
router.put('/queue/:type/:id/reject', authMiddleware, requireAdmin, rejectContent);

module.exports = router;
