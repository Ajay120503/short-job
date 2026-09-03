const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/auth.middleware');
const { optionalAuth } = require('../middlewares/auth.middleware');
const { uploadImage } = require('../middlewares/upload.middleware');
const {
  getJobs,
  createJob,
  getJob,
  updateJob,
  deleteJob,
  applyToJob,
  getApplicants,
  updateApplicationStatus,
  getMyApplications,
  getMyJobs,
  getMyArchivedJobs,
  getMatchedJobs,
  incrementViewCount,
  getJobsMap,
  quickApply,
  addQnAQuestion,
  answerQnA,
  deleteQnA,
} = require('../controllers/job.controller');

// My jobs routes (MUST be before /:id to avoid route conflicts)
router.get('/my/list', authMiddleware, getMyJobs);
router.get('/my/archive', authMiddleware, getMyArchivedJobs);

// Application routes (MUST be before /:id to avoid route conflicts)
router.get('/applications/my', authMiddleware, getMyApplications);
router.put('/applications/:id/status', authMiddleware, updateApplicationStatus);

// Map view route (MUST be before /:id)
router.get('/map', getJobsMap);

// Matched jobs (MUST be before /:id)
router.get('/matched', authMiddleware, getMatchedJobs);

// Public routes
router.get('/', optionalAuth, getJobs);
router.get('/:id', optionalAuth, getJob);

// Protected routes - any signed-in user can create opportunities; owners can edit/delete.
router.post('/', authMiddleware, uploadImage.single('image'), createJob);
router.put('/:id', authMiddleware, uploadImage.single('image'), updateJob);
router.delete('/:id', authMiddleware, deleteJob);

// General user applicants
router.post('/:id/apply', authMiddleware, uploadImage.single('coverLetter'), applyToJob);

// Profile-strength based quick apply
router.post('/:id/quick-apply', authMiddleware, quickApply);

// View count
router.patch('/:id/view', authMiddleware, incrementViewCount);

// Job poster only - view applicants
router.get('/:id/applicants', authMiddleware, getApplicants);

// QnA routes
router.post('/:id/qna', authMiddleware, addQnAQuestion);
router.post('/:id/qna/:qnaId/answer', authMiddleware, answerQnA);
router.delete('/:id/qna/:qnaId', authMiddleware, deleteQnA);

module.exports = router;
