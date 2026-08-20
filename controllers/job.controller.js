const JobPost = require('../models/JobPost');
const Post = require('../models/Post');
const Application = require('../models/Application');
const Notification = require('../models/Notification');
const User = require('../models/User');
const { getIO } = require('../config/socket');
const { uploadToCloudinary, deleteFromCloudinary } = require('../middlewares/upload.middleware');
const { getInitialModerationState } = require('../utils/adminSettings');

const hasActiveBadge = (user, badgeType) =>
  (user.badges || []).some((badge) => badge.type === badgeType && badge.isActive !== false);

const canApplyToJobs = (user) => Boolean(user);

const canViewJob = (job, user) => {
  if (!job.status || job.status === 'approved') return true;
  if (!user) return false;
  if (user.isAdmin || user.isSuperAdmin) return true;
  const postedBy = job.postedBy?._id || job.postedBy;
  return postedBy?.toString?.() === user._id.toString();
};

// @desc    Get all active jobs
// @route   GET /api/jobs
const getJobs = async (req, res) => {
  try {
    const { paid, location, roleType, search, page: pageStr, limit: limitStr } = req.query;
    const page = parseInt(pageStr) || 1;
    const limit = parseInt(limitStr) || 10;
    const skip = (page - 1) * limit;

    const filters = { isActive: true };

    if (paid !== undefined) {
      filters.isPaid = paid === 'true';
    }

    if (location) {
      filters.location = location;
    }

    if (roleType) {
      filters.roleType = roleType;
    }

    if (search) {
      filters.$text = { $search: search };
    }

    const query = req.user
      ? {
          ...filters,
          $or: [
            { status: 'approved' },
            { postedBy: req.user._id },
          ],
        }
      : { ...filters, status: 'approved' };

    const jobs = await JobPost.find(query)
      .populate('postedBy', 'name profilePic role category institutionName institutionPic openToOpportunities badges isAdmin isSuperAdmin lastActiveAt activeDays followers profileThemeVariant')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await JobPost.countDocuments(query);

    res.json({
      success: true,
      jobs,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Get jobs error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Create a job post
// @route   POST /api/jobs
const createJob = async (req, res) => {
  try {
    const {
      title, description, institutionName, roleType, isPaid,
      stipend, currency, location, requiredQualifications, skillsRequired,
      deadline, contactEmail, maxApplicants,
    } = req.body;

    if (!title || !description || !deadline || !contactEmail) {
      return res.status(400).json({ message: 'Title, description, deadline, and contact email are required.' });
    }

    const moderationState = await getInitialModerationState('job');

    const jobData = {
      postedBy: req.user._id,
      institutionName: institutionName || req.user.institutionName || '',
      institutionLogo: req.user.institutionPic || { url: '', publicId: '' },
      title,
      description,
      roleType: roleType || 'teacher',
      isPaid: isPaid === 'true' || isPaid === true,
      currency: currency || 'INR',
      stipend: stipend || 0,
      location: location || 'onsite',
      requiredQualifications: requiredQualifications || '',
      skillsRequired: skillsRequired ? (typeof skillsRequired === 'string' ? skillsRequired.split(',').map(s => s.trim()) : skillsRequired) : [],
      deadline: new Date(deadline),
      contactEmail,
      maxApplicants: maxApplicants || 0,
      ...moderationState,
    };

    // Upload job image if provided
    if (req.file) {
      const result = await uploadToCloudinary(req.file, 'ShortJob/job-images');
      jobData.image = {
        url: result.secure_url,
        publicId: result.public_id,
      };
    }

    const job = await JobPost.create(jobData);
    const populatedJob = await JobPost.findById(job._id)
      .populate('postedBy', 'name profilePic role category institutionName openToOpportunities badges isAdmin isSuperAdmin lastActiveAt activeDays followers profileThemeVariant');

    // Create a feed post linked to this job (uses Post.jobPost field)
    await Post.create({
      author: req.user._id,
      type: 'job',
      text: populatedJob.title,
      jobPost: populatedJob._id,
      status: moderationState.status,
      moderationMeta: moderationState.moderationMeta,
    });

    // Notify followers about new job post
    const followers = req.user.followers || [];
    for (const followerId of followers) {
      await Notification.create({
        recipient: followerId,
        sender: req.user._id,
        type: 'job_applied',
        message: `${req.user.name} posted a new job: ${title}`,
        link: `/jobs/${job._id}`,
      });

      try {
        const io = getIO();
        io.to(followerId.toString()).emit('notification', {
          type: 'job_applied',
          message: `${req.user.name} posted a new job: ${title}`,
          link: `/jobs/${job._id}`,
        });
      } catch (socketErr) {}
    }

    res.status(201).json({ success: true, job: populatedJob });
  } catch (error) {
    console.error('Create job error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Get single job
// @route   GET /api/jobs/:id
const getJob = async (req, res) => {
  try {
    const job = await JobPost.findById(req.params.id)
      .populate('postedBy', 'name profilePic role category institutionName profilePic openToOpportunities badges isAdmin isSuperAdmin lastActiveAt activeDays followers profileThemeVariant')
      .populate('applicants', 'name profilePic skills openToOpportunities badges isAdmin isSuperAdmin lastActiveAt activeDays followers profileThemeVariant');

    if (!job) {
      return res.status(404).json({ message: 'Job not found.' });
    }

    if (!canViewJob(job, req.user)) {
      return res.status(404).json({ message: 'Job not found.' });
    }

    res.json({ success: true, job });
  } catch (error) {
    console.error('Get job error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Update a job post
// @route   PUT /api/jobs/:id
const updateJob = async (req, res) => {
  try {
    const job = await JobPost.findById(req.params.id);

    if (!job) {
      return res.status(404).json({ message: 'Job not found.' });
    }

    if (job.postedBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'You can only update your own job posts.' });
    }

    const allowedFields = [
      'title', 'description', 'roleType', 'isPaid', 'stipend',
      'location', 'requiredQualifications', 'skillsRequired',
      'deadline', 'contactEmail', 'maxApplicants', 'isActive',
    ];

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        job[field] = req.body[field];
      }
    }

    if (req.body.skillsRequired && typeof req.body.skillsRequired === 'string') {
      job.skillsRequired = req.body.skillsRequired.split(',').map(s => s.trim());
    }

    // If a new image was uploaded, replace the old one on Cloudinary
    if (req.file) {
      if (job.image?.publicId) {
        try {
          await deleteFromCloudinary(job.image.publicId);
        } catch (imgErr) {
          console.error('Failed to delete old job image:', imgErr.message);
        }
      }
      const result = await uploadToCloudinary(req.file, 'ShortJob/job-images');
      job.image = {
        url: result.secure_url,
        publicId: result.public_id,
      };
    }

    await job.save();

    // Keep linked feed post text in sync with job title
    await Post.updateMany({ jobPost: job._id }, { text: job.title });

    res.json({ success: true, job });
  } catch (error) {
    console.error('Update job error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Delete a job post
// @route   DELETE /api/jobs/:id
const deleteJob = async (req, res) => {
  try {
    const job = await JobPost.findById(req.params.id);

    if (!job) {
      return res.status(404).json({ message: 'Job not found.' });
    }

    if (job.postedBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'You can only delete your own job posts.' });
    }

    // Delete job image from Cloudinary
    if (job.image?.publicId) {
      await deleteFromCloudinary(job.image.publicId);
    }

    // Delete associated applications
    await Application.deleteMany({ jobPost: job._id });

    // Delete linked feed post (type: 'job' with jobPost ref)
    await Post.deleteMany({ jobPost: job._id });

    await job.deleteOne();

    res.json({ success: true, message: 'Job post deleted.' });
  } catch (error) {
    console.error('Delete job error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Apply to a job
// @route   POST /api/jobs/:id/apply
const applyToJob = async (req, res) => {
  try {
    const job = await JobPost.findById(req.params.id);

    if (!job) {
      return res.status(404).json({ message: 'Job not found.' });
    }

    if (job.postedBy.toString() === req.user._id.toString()) {
      return res.status(400).json({ message: 'You cannot apply to your own opportunity.' });
    }

    if (!job.isActive || job.status !== 'approved') {
      return res.status(400).json({ message: 'This job is no longer accepting applications.' });
    }

    // Check if already applied
    const existingApplication = await Application.findOne({
      jobPost: job._id,
      applicant: req.user._id,
    });

    if (existingApplication) {
      return res.status(400).json({ message: 'You have already applied to this job.' });
    }

    // Check max applicants
    if (job.maxApplicants > 0 && job.applicants.length >= job.maxApplicants) {
      return res.status(400).json({ message: 'Maximum number of applicants reached.' });
    }

    const { coverLetter } = req.body;

    const applicationData = {
      jobPost: job._id,
      applicant: req.user._id,
      coverLetter: coverLetter || '',
    };

    // Upload cover letter PDF if provided
    if (req.file) {
      const result = await uploadToCloudinary(req.file, 'ShortJob/resumes');
      applicationData.coverLetterFile = {
        url: result.secure_url,
        publicId: result.public_id,
      };
    }

    const application = await Application.create(applicationData);

    // Add applicant to job
    job.applicants.push(req.user._id);
    await job.save();

    // Notify job poster
    await Notification.create({
      recipient: job.postedBy,
      sender: req.user._id,
      type: 'job_applied',
      message: `${req.user.name} applied for your job: ${job.title}`,
      link: `/jobs/${job._id}`,
    });

    try {
      const io = getIO();
      io.to(job.postedBy.toString()).emit('notification', {
        type: 'job_applied',
        message: `${req.user.name} applied for your job: ${job.title}`,
        link: `/jobs/${job._id}/applicants`,
      });
    } catch (socketErr) {}

    res.status(201).json({ success: true, application });
  } catch (error) {
    console.error('Apply to job error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Get applicants for a job
// @route   GET /api/jobs/:id/applicants
const getApplicants = async (req, res) => {
  try {
    const job = await JobPost.findById(req.params.id);

    if (!job) {
      return res.status(404).json({ message: 'Job not found.' });
    }

    if (job.postedBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'You can only view applicants for your own job posts.' });
    }

    const { status } = req.query;

    let query = { jobPost: req.params.id };
    if (status) {
      query.status = status;
    }

    const applications = await Application.find(query)
      .populate(
        'applicant',
        'name profilePic skills qualifications email educationLevel city state bio age experience subject profession institutionName linkedinUrl resumeUrl interests openToOpportunities badges isAdmin isSuperAdmin lastActiveAt activeDays followers profileThemeVariant'
      )
      .sort({ createdAt: -1 });

    res.json({ success: true, applications });
  } catch (error) {
    console.error('Get applicants error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Update application status
// @route   PUT /api/applications/:id/status
const updateApplicationStatus = async (req, res) => {
  try {
    const { status } = req.body;

    if (!['applied', 'reviewed', 'shortlisted', 'rejected', 'selected'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status.' });
    }

    const application = await Application.findById(req.params.id)
      .populate('jobPost', 'postedBy title');

    if (!application) {
      return res.status(404).json({ message: 'Application not found.' });
    }

    // Only job poster can update status
    if (application.jobPost.postedBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'You can only update applications for your own job posts.' });
    }

    application.status = status;
    application.notes = req.body.notes || application.notes;
    await application.save();

    // Notify applicant
    await Notification.create({
      recipient: application.applicant,
      sender: req.user._id,
      type: 'application_status',
      message: `Your application for "${application.jobPost.title}" has been ${status}.`,
      link: `/jobs/${application.jobPost._id}`,
    });

    try {
      const io = getIO();
      io.to(application.applicant.toString()).emit('notification', {
        type: 'application_status',
        message: `Your application status updated to: ${status}`,
        link: `/jobs/${application.jobPost._id}`,
      });
    } catch (socketErr) {}

    res.json({ success: true, application });
  } catch (error) {
    console.error('Update application status error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Get user's applications (student's dashboard)
// @route   GET /api/applications/my
const getMyApplications = async (req, res) => {
  try {
    const { status } = req.query;

    let query = { applicant: req.user._id };
    if (status) {
      query.status = status;
    }

    const applications = await Application.find(query)
      .populate({
        path: 'jobPost',
        select: 'title institutionName location roleType isPaid stipend deadline',
        populate: {
          path: 'postedBy',
          select: 'name profilePic openToOpportunities badges isAdmin isSuperAdmin lastActiveAt activeDays followers profileThemeVariant',
        },
      })
      .sort({ createdAt: -1 });

    res.json({ success: true, applications });
  } catch (error) {
    console.error('Get my applications error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Get jobs posted by current user
// @route   GET /api/jobs/my/list
const getMyJobs = async (req, res) => {
  try {
    const jobs = await JobPost.find({ postedBy: req.user._id })
      .populate('postedBy', 'name profilePic role category institutionName openToOpportunities badges isAdmin isSuperAdmin lastActiveAt activeDays followers profileThemeVariant')
      .sort({ createdAt: -1 });

    // Get application counts for each job
    const jobsWithCounts = await Promise.all(
      jobs.map(async (job) => {
        const applicationCount = await Application.countDocuments({ jobPost: job._id });
        return {
          ...job.toObject(),
          applicationCount,
        };
      })
    );

    res.json({ success: true, jobs: jobsWithCounts });
  } catch (error) {
    console.error('Get my jobs error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    F01 — Get matched jobs for student based on profile
// @route   GET /api/jobs/matched
const getMatchedJobs = async (req, res) => {
  try {
    const student = await User.findById(req.user._id);
    if (!student || !canApplyToJobs(student)) {
      return res.status(403).json({ message: 'This account cannot use matched jobs.' });
    }

    const jobs = await JobPost.find({ isActive: true, status: 'approved' })
      .populate('postedBy', 'name profilePic role category institutionName institutionPic openToOpportunities badges isAdmin isSuperAdmin lastActiveAt activeDays followers profileThemeVariant');

    const studentSkills = (student.skills || []).map(s => s.toLowerCase().trim());
    const studentQualifications = (student.qualifications || []).map(q => q.toLowerCase().trim());

    const scored = jobs.map(job => {
      const jobSkills = (job.skillsRequired || []).map(s => s.toLowerCase().trim());
      const matched = studentSkills.filter(s => jobSkills.includes(s));
      const missing = jobSkills.filter(s => !studentSkills.includes(s));

      const skillScore = jobSkills.length
        ? (matched.length / jobSkills.length) * 60 : 0;

      const reqQuals = job.requiredQualifications
        ? job.requiredQualifications.split(',').map(q => q.trim().toLowerCase())
        : [];
      const eduScore = reqQuals.some(q => studentQualifications.some(sq => sq.includes(q) || q.includes(sq))) ? 30 : 0;

      const locScore = job.location === 'onsite' && student.city ? 10 : 5;

      return {
        job,
        score: Math.round(skillScore + eduScore + locScore),
        matchedSkills: matched,
        missingSkills: missing,
      };
    });

    const top5 = scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    res.json({ success: true, matched: top5 });
  } catch (error) {
    console.error('Get matched jobs error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    F06 — Increment view count for a job
// @route   PATCH /api/jobs/:id/view
const incrementViewCount = async (req, res) => {
  try {
    await JobPost.findByIdAndUpdate(req.params.id, { $inc: { viewCount: 1 } });
    res.json({ success: true });
  } catch (error) {
    console.error('Increment view count error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    F03 — Get jobs for map view
// @route   GET /api/jobs/map
const getJobsMap = async (req, res) => {
  try {
    const { city, state } = req.query;
    let query = { isActive: true, status: 'approved' };

    const jobs = await JobPost.find(query)
      .select('title institutionName institutionLogo isPaid roleType coordinates location postedBy')
      .populate('postedBy', 'name institutionName city state');

    // Filter by city/state if provided (from user profile or query params)
    let filtered = jobs;
    if (city || state) {
      filtered = jobs.filter(job => {
        const poster = job.postedBy;
        const cityMatch = city ? (poster?.city?.toLowerCase() === city.toLowerCase()) : true;
        const stateMatch = state ? (poster?.state?.toLowerCase() === state.toLowerCase()) : true;
        return cityMatch && stateMatch;
      });
    }

    res.json({ success: true, jobs: filtered });
  } catch (error) {
    console.error('Get jobs map error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    F14 — Quick Apply to a job
// @route   POST /api/jobs/:id/quick-apply
const quickApply = async (req, res) => {
  try {
    if (!canApplyToJobs(req.user)) {
      return res.status(403).json({ message: 'This account cannot quick apply.' });
    }

    const job = await JobPost.findById(req.params.id);
    if (!job) {
      return res.status(404).json({ message: 'Job not found.' });
    }

    if (job.postedBy.toString() === req.user._id.toString()) {
      return res.status(400).json({ message: 'You cannot apply to your own opportunity.' });
    }

    if (!job.isActive || job.status !== 'approved') {
      return res.status(400).json({ message: 'This job is no longer accepting applications.' });
    }

    // Check if already applied
    const existingApplication = await Application.findOne({
      jobPost: job._id,
      applicant: req.user._id,
    });

    if (existingApplication) {
      return res.status(400).json({ message: 'You have already applied to this job.' });
    }

    // Profile strength check
    const student = await User.findById(req.user._id);
    let score = 0;
    if (student.name) score += 10;
    if (student.profilePic?.url) score += 15;
    if (student.bio) score += 10;
    if (student.age) score += 5;
    if (student.address) score += 5;
    if (student.resumeUrl) score += 20;
    if (student.skills?.length >= 3) score += 15;
    if (student.qualifications?.length >= 1) score += 10;
    if (student.educationLevel) score += 10;

    if (score < 80) {
      return res.status(400).json({ message: 'Complete your profile to unlock Quick Apply. Profile strength must be at least 80%.' });
    }

    const application = await Application.create({
      jobPost: job._id,
      applicant: req.user._id,
      coverLetter: 'Applied via Quick Apply',
    });

    job.applicants.push(req.user._id);
    await job.save();

    // Notify job poster
    await Notification.create({
      recipient: job.postedBy,
      sender: req.user._id,
      type: 'job_applied',
      message: `${req.user.name} applied for your job: ${job.title}`,
      link: `/jobs/${job._id}`,
    });

    try {
      const io = getIO();
      io.to(job.postedBy.toString()).emit('notification', {
        type: 'job_applied',
        message: `${req.user.name} applied for your job: ${job.title}`,
        link: `/jobs/${job._id}/applicants`,
      });
    } catch (socketErr) {}

    res.status(201).json({ success: true, application, message: 'Applied successfully!' });
  } catch (error) {
    console.error('Quick apply error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    F12 — Add a question to a job QnA
// @route   POST /api/jobs/:id/qna
const addQnAQuestion = async (req, res) => {
  try {
    const { question, isAnonymous } = req.body;
    if (!question) {
      return res.status(400).json({ message: 'Question is required.' });
    }

    const job = await JobPost.findById(req.params.id);
    if (!job) {
      return res.status(404).json({ message: 'Job not found.' });
    }

    if (!canViewJob(job, req.user)) {
      return res.status(404).json({ message: 'Job not found.' });
    }

    job.qna.push({
      question,
      askedBy: req.user._id,
      isAnonymous: isAnonymous === true || isAnonymous === 'true',
    });

    await job.save();

    // Notify job poster
    await Notification.create({
      recipient: job.postedBy,
      sender: req.user._id,
      type: 'job_qna',
      message: `A new question was asked on your job: ${job.title}`,
      link: `/jobs/${job._id}`,
    });

    const populated = await JobPost.findById(job._id)
      .populate('qna.askedBy', 'name profilePic openToOpportunities');

    res.status(201).json({ success: true, qna: populated.qna });
  } catch (error) {
    console.error('Add QnA question error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    F12 — Answer a QnA question
// @route   POST /api/jobs/:id/qna/:qnaId/answer
const answerQnA = async (req, res) => {
  try {
    const { answer } = req.body;
    if (!answer) {
      return res.status(400).json({ message: 'Answer is required.' });
    }

    const job = await JobPost.findById(req.params.id);
    if (!job) {
      return res.status(404).json({ message: 'Job not found.' });
    }

    if (job.postedBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Only the job poster can answer questions.' });
    }

    const qnaItem = job.qna.id(req.params.qnaId);
    if (!qnaItem) {
      return res.status(404).json({ message: 'Question not found.' });
    }

    qnaItem.answer = answer;
    qnaItem.answeredBy = req.user._id;
    qnaItem.answeredAt = new Date();
    await job.save();

    // Notify question asker
    if (qnaItem.askedBy && qnaItem.askedBy.toString() !== req.user._id.toString()) {
      await Notification.create({
        recipient: qnaItem.askedBy,
        sender: req.user._id,
        type: 'job_qna',
        message: `Your question on "${job.title}" was answered.`,
        link: `/jobs/${job._id}`,
      });
    }

    const populated = await JobPost.findById(job._id)
      .populate('qna.askedBy', 'name profilePic openToOpportunities');

    res.json({ success: true, qna: populated.qna });
  } catch (error) {
    console.error('Answer QnA error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    F12 — Delete a QnA question
// @route   DELETE /api/jobs/:id/qna/:qnaId
const deleteQnA = async (req, res) => {
  try {
    const job = await JobPost.findById(req.params.id);
    if (!job) {
      return res.status(404).json({ message: 'Job not found.' });
    }

    const qnaItem = job.qna.id(req.params.qnaId);
    if (!qnaItem) {
      return res.status(404).json({ message: 'Question not found.' });
    }

    if (qnaItem.askedBy.toString() !== req.user._id.toString() && job.postedBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized to delete this question.' });
    }

    qnaItem.deleteOne();
    await job.save();

    res.json({ success: true, message: 'Question deleted.' });
  } catch (error) {
    console.error('Delete QnA error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

module.exports = {
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
  getMatchedJobs,
  incrementViewCount,
  getJobsMap,
  quickApply,
  addQnAQuestion,
  answerQnA,
  deleteQnA,
};
