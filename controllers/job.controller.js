const JobPost = require('../models/JobPost');
const Post = require('../models/Post');
const Application = require('../models/Application');
const Notification = require('../models/Notification');
const User = require('../models/User');
const { getIO } = require('../config/socket');
const { uploadToCloudinary, deleteFromCloudinary } = require('../middlewares/upload.middleware');
const { getInitialModerationState, applyInitialRuleModeration } = require('../utils/adminSettings');
const { pickPriorityPage, toId } = require('../utils/contentOrdering');
const { getProfileCompletionStatus } = require('../utils/profileCompletion');

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

const getJobDeadlineCutoff = () => {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  return todayStart;
};

const isJobExpired = (job) =>
  Boolean(job?.deadline && new Date(job.deadline) < getJobDeadlineCutoff());

const normalizeMatchText = (value = '') =>
  String(value)
    .toLowerCase()
    .replace(/[^a-z0-9+#.\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const toUniqueTerms = (values = []) => {
  const items = Array.isArray(values) ? values : [values];
  return [
    ...new Set(
      items
        .flatMap((value) => String(value || '').split(/[,;\n|•]+/))
        .map(normalizeMatchText)
        .filter((value) => value.length > 1)
    ),
  ];
};

const normalizeListInput = (value = []) => {
  const items = Array.isArray(value) ? value : String(value || '').split(',');
  return [
    ...new Set(
      items
        .map((item) => String(item || '').trim())
        .filter(Boolean)
    ),
  ];
};

const termMatchStrength = (source, target) => {
  if (!source || !target) return 0;
  if (source === target) return 1;
  if (source.includes(target) || target.includes(source)) return 0.72;

  const sourceTokens = new Set(source.split(/\s+/).filter((token) => token.length > 2));
  const targetTokens = target.split(/\s+/).filter((token) => token.length > 2);
  if (!sourceTokens.size || !targetTokens.length) return 0;

  const overlap = targetTokens.filter((token) => sourceTokens.has(token)).length;
  return overlap ? Math.min(0.58, overlap / targetTokens.length) : 0;
};

const bestTermMatch = (target, sources) =>
  sources.reduce((best, source) => Math.max(best, termMatchStrength(source, target)), 0);

const scoreTermGroup = (targets, sources, maxScore) => {
  if (!targets.length || !sources.length) return 0;
  const totalStrength = targets.reduce(
    (sum, target) => sum + bestTermMatch(target, sources),
    0
  );
  return Math.min(maxScore, (totalStrength / targets.length) * maxScore);
};

const countContentHits = (content, terms) =>
  terms.filter((term) => term.length > 2 && content.includes(term)).length;

const scoreLocationMatch = (job, user) => {
  if (job.location === 'remote') return 10;
  if (job.location === 'hybrid') return user.city || user.state ? 8 : 6;

  const userCity = normalizeMatchText(user.city);
  const userState = normalizeMatchText(user.state);
  const jobLocationText = normalizeMatchText(
    [
      job.workplaceName,
      job.workplaceAddress,
      job.workplaceCity,
      job.workplaceState,
      job.workplaceCountry,
      job.institutionName,
      job.location,
      job.description,
    ].filter(Boolean).join(' ')
  );

  if (userCity && jobLocationText.includes(userCity)) return 10;
  if (userState && jobLocationText.includes(userState)) return 7;
  return userCity || userState ? 3 : 1;
};

const scoreDeadlineHealth = (deadline) => {
  if (!deadline) return 1;
  const daysLeft = Math.ceil((new Date(deadline).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  if (daysLeft < 0) return 0;
  if (daysLeft <= 3) return 2;
  if (daysLeft <= 14) return 5;
  return 4;
};

const parseCoordinate = (value) => {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const getJobCoordinatesFromBody = (body) => {
  const lat = parseCoordinate(body.coordinateLat ?? body.lat ?? body.coordinates?.lat);
  const lng = parseCoordinate(body.coordinateLng ?? body.lng ?? body.coordinates?.lng);
  if (lat === undefined && lng === undefined) return undefined;
  if (lat === undefined || lng === undefined) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
};

const requireAdult = (user, action, res) => {
  if (user.age === undefined || user.age === null) {
    res.status(403).json({ error: 'profile_incomplete', missingField: 'age', message: `Add your age to your profile before ${action}.` });
    return false;
  }
  if (Number(user.age) < 18) {
    res.status(403).json({ error: 'age_restricted', message: `You must be 18 or older to ${action} on ShorJob.` });
    return false;
  }
  return true;
};

const geocodeJobAddress = async (body) => {
  const query = [body.workplaceAddress, body.workplaceCity, body.workplaceState, body.workplaceCountry, body.institutionName]
    .filter(Boolean).join(', ');
  if (!query) return undefined;
  try {
    const response = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': 'ShorJob/1.0 (jobs@shorjob.app)' },
      signal: AbortSignal.timeout(7000),
    });
    if (!response.ok) return undefined;
    const [place] = await response.json();
    if (!place) return undefined;
    return { lat: Number(place.lat), lng: Number(place.lon) };
  } catch (_) { return undefined; }
};

const distanceKm = (aLat, aLng, bLat, bLng) => {
  const rad = (value) => value * Math.PI / 180;
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
};

// @desc    Get all active jobs
// @route   GET /api/jobs
const getJobs = async (req, res) => {
  try {
    const {
      paid, isPaid, location, roleType, shortJobType, city, state,
      lat, lng, radiusKm, search, page: pageStr, limit: limitStr,
    } = req.query;
    const page = parseInt(pageStr) || 1;
    const limit = parseInt(limitStr) || 10;
    const skip = (page - 1) * limit;

    const filters = { isActive: true, deadline: { $gte: getJobDeadlineCutoff() } };

    const paidFilter = isPaid ?? paid;
    if (paidFilter !== undefined) {
      filters.isPaid = paidFilter === 'true';
    }

    if (location) {
      filters.location = location;
    }

    if (roleType) {
      filters.roleType = roleType;
    }

    if (shortJobType) {
      const values = String(shortJobType).split(',').filter(Boolean);
      filters.shortJobType = values.length > 1 ? { $in: values } : values[0];
    }
    if (city) filters.workplaceCity = new RegExp(String(city).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    if (state) filters.workplaceState = new RegExp(`^${String(state).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');

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

    const geoLat = parseCoordinate(lat);
    const geoLng = parseCoordinate(lng);
    const geoRadius = Number(radiusKm);
    const geoActive = geoLat !== undefined && geoLng !== undefined && Number.isFinite(geoRadius) && geoRadius > 0;
    if (geoActive) {
      query.location_point = { $geoWithin: { $centerSphere: [[geoLng, geoLat], geoRadius / 6371] } };
    }

    const orderedJobPage = req.user && !geoActive
      ? await JobPost.find(query)
          .select('_id postedBy createdAt updatedAt')
          .lean()
          .then((rows) =>
            pickPriorityPage(
              rows,
              req.user,
              (job) => job.postedBy,
              skip,
              limit,
              (job) => job.updatedAt || job.createdAt
            )
          )
      : null;

    const jobsQuery = req.user && !geoActive
      ? JobPost.find({ _id: { $in: orderedJobPage.map((job) => job._id) } })
      : JobPost.find(query).sort({ createdAt: -1 });

    if (!req.user || geoActive) jobsQuery.skip(skip).limit(limit);

    const jobs = await jobsQuery
      .populate('postedBy', 'name profilePic role category institutionName institutionPic openToOpportunities badges isAdmin isSuperAdmin lastActiveAt activeDays followers profileThemeVariant');

    if (req.user && !geoActive) {
      const order = new Map(orderedJobPage.map((job, index) => [toId(job._id), index]));
      jobs.sort((a, b) => (order.get(toId(a._id)) ?? 0) - (order.get(toId(b._id)) ?? 0));
    }
    if (geoActive) {
      jobs.forEach((job) => {
        const point = job.location_point?.coordinates;
        if (point?.length === 2) job.set('distanceKm', distanceKm(geoLat, geoLng, point[1], point[0]), { strict: false });
      });
      jobs.sort((a, b) => (a.get('distanceKm') ?? Infinity) - (b.get('distanceKm') ?? Infinity));
    }

    const total = await JobPost.countDocuments(query);

    const responseJobs = jobs.map((job) => {
      const plain = job.toObject ? job.toObject() : job;
      if (geoActive) {
        const point = plain.location_point?.coordinates;
        if (point?.length === 2) plain.distanceKm = distanceKm(geoLat, geoLng, point[1], point[0]);
      }
      return plain;
    });

    res.json({
      success: true,
      jobs: responseJobs,
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
  let uploadedJobImagePublicId = '';
  let jobCreated = false;
  try {
    if (!requireAdult(req.user, 'posting a job', res)) return;
    const {
      title, description, institutionName, roleType, isPaid,
      stipend, currency, location, requiredQualifications, skillsRequired,
      deadline, contactEmail, maxApplicants,
      workplaceName, workplaceAddress, workplaceCity, workplaceState,
      workplaceCountry, shortJobType, durationUnit, durationValue, startTime, endTime,
    } = req.body;

    if (!title || !description || !deadline || !contactEmail) {
      return res.status(400).json({ message: 'Title, description, deadline, and contact email are required.' });
    }
    const duration = req.body.duration && typeof req.body.duration === 'object'
      ? req.body.duration : { unit: durationUnit, value: Number(durationValue) };
    if (!shortJobType || !['hours', 'days'].includes(duration.unit) || !Number.isInteger(Number(duration.value)) || Number(duration.value) < 1) {
      return res.status(400).json({ message: 'Short job type and a positive whole-number duration are required.' });
    }
    const validTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
    if (!validTime.test(startTime || '') || !validTime.test(endTime || '') || startTime === endTime) {
      return res.status(400).json({ message: 'Valid and different start and end times are required.' });
    }

    let coordinates = getJobCoordinatesFromBody(req.body);
    if (coordinates === null) {
      return res.status(400).json({ message: 'Please provide valid workplace coordinates.' });
    }
    if (!coordinates && location !== 'remote') coordinates = await geocodeJobAddress(req.body);

    const moderationState = await getInitialModerationState('job');

    const jobData = {
      postedBy: req.user._id,
      institutionName: institutionName || req.user.institutionName || '',
      institutionLogo: req.user.institutionPic || { url: '', publicId: '' },
      title,
      description,
      roleType: roleType || 'other',
      shortJobType,
      duration: { unit: duration.unit, value: Number(duration.value) },
      startTime,
      endTime,
      isPaid: isPaid === 'true' || isPaid === true,
      currency: currency || 'INR',
      stipend: stipend || 0,
      location: location || 'onsite',
      workplaceName: workplaceName || '',
      workplaceAddress: workplaceAddress || '',
      workplaceCity: workplaceCity || '',
      workplaceState: workplaceState || '',
      workplaceCountry: workplaceCountry || '',
      requiredQualifications: requiredQualifications || '',
      skillsRequired: normalizeListInput(skillsRequired),
      deadline: new Date(deadline),
      contactEmail,
      maxApplicants: maxApplicants || 0,
      ...moderationState,
    };

    // Upload job image if provided
    if (req.file) {
      const result = await uploadToCloudinary(req.file, 'ShortJob/job-images');
      uploadedJobImagePublicId = result.public_id;
      jobData.image = {
        url: result.secure_url,
        publicId: result.public_id,
      };
    }
    if (coordinates) {
      jobData.coordinates = coordinates;
      jobData.location_point = { type: 'Point', coordinates: [coordinates.lng, coordinates.lat] };
    }

    const moderatedState = await applyInitialRuleModeration(jobData, 'job', moderationState);
    jobData.status = moderatedState.status;
    jobData.moderationMeta = moderatedState.moderationMeta;

    const job = await JobPost.create(jobData);
    jobCreated = true;
    const populatedJob = await JobPost.findById(job._id)
      .populate('postedBy', 'name profilePic role category institutionName openToOpportunities badges isAdmin isSuperAdmin lastActiveAt activeDays followers profileThemeVariant');

    // Create a feed post linked to this job (uses Post.jobPost field)
    await Post.create({
      author: req.user._id,
      type: 'job',
      text: populatedJob.title,
      jobPost: populatedJob._id,
      status: populatedJob.status,
      moderationMeta: populatedJob.moderationMeta,
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
    if (!jobCreated && uploadedJobImagePublicId) {
      await deleteFromCloudinary(uploadedJobImagePublicId);
    }
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
      'title', 'description', 'institutionName', 'roleType', 'isPaid', 'stipend', 'currency',
      'location', 'requiredQualifications', 'skillsRequired',
      'deadline', 'contactEmail', 'maxApplicants', 'isActive',
      'workplaceName', 'workplaceAddress', 'workplaceCity',
      'workplaceState', 'workplaceCountry',
      'shortJobType', 'startTime', 'endTime',
    ];

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        job[field] = req.body[field];
      }
    }

    if (req.body.skillsRequired !== undefined) {
      job.skillsRequired = normalizeListInput(req.body.skillsRequired);
    }
    if (req.body.duration || req.body.durationUnit || req.body.durationValue) {
      const duration = req.body.duration && typeof req.body.duration === 'object' ? req.body.duration : { unit: req.body.durationUnit, value: Number(req.body.durationValue) };
      if (!['hours', 'days'].includes(duration.unit) || !Number.isInteger(Number(duration.value)) || Number(duration.value) < 1) return res.status(400).json({ message: 'Duration must be a positive whole number of hours or days.' });
      job.duration = { unit: duration.unit, value: Number(duration.value) };
    }
    if (!job.shortJobType) job.shortJobType = 'short_term';
    if (!job.duration?.value) job.duration = { unit: 'days', value: 1 };
    if (req.body.startTime !== undefined || req.body.endTime !== undefined) {
      const validTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
      if (!validTime.test(job.startTime || '') || !validTime.test(job.endTime || '') || job.startTime === job.endTime) {
        return res.status(400).json({ message: 'Valid and different start and end times are required.' });
      }
    }

    const coordinates = getJobCoordinatesFromBody(req.body);
    if (coordinates === null) {
      return res.status(400).json({ message: 'Please provide valid workplace coordinates.' });
    }
    if (coordinates) {
      job.coordinates = coordinates;
      job.location_point = { type: 'Point', coordinates: [coordinates.lng, coordinates.lat] };
    } else if (req.body.clearCoordinates === 'true' || req.body.clearCoordinates === true) {
      job.coordinates = undefined;
      job.location_point = undefined;
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

    const applications = await Application.find({ jobPost: job._id }).select('coverLetterFile');
    for (const application of applications) {
      if (application.coverLetterFile?.publicId || application.coverLetterFile?.url) {
        await deleteFromCloudinary(
          application.coverLetterFile.publicId || application.coverLetterFile.url
        );
      }
    }

    const linkedPosts = await Post.find({ jobPost: job._id }).select('images');
    for (const post of linkedPosts) {
      for (const image of post.images || []) {
        await deleteFromCloudinary(image.publicId || image.url);
      }
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
  let uploadedCoverLetterPublicId = '';
  let applicationCreated = false;
  try {
    if (!requireAdult(req.user, 'apply', res)) return;
    const completion = getProfileCompletionStatus(req.user);
    if (!completion.isComplete) {
      return res.status(403).json({ error: 'profile_incomplete', missingFields: completion.missingMandatory, message: 'Complete your profile before applying to jobs.' });
    }
    const job = await JobPost.findById(req.params.id);

    if (!job) {
      return res.status(404).json({ message: 'Job not found.' });
    }

    if (job.postedBy.toString() === req.user._id.toString()) {
      return res.status(400).json({ message: 'You cannot apply to your own opportunity.' });
    }

    if (!job.isActive || job.status !== 'approved' || isJobExpired(job)) {
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
      uploadedCoverLetterPublicId = result.public_id;
      applicationData.coverLetterFile = {
        url: result.secure_url,
        publicId: result.public_id,
      };
    }

    const application = await Application.create(applicationData);
    applicationCreated = true;

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
    if (!applicationCreated && uploadedCoverLetterPublicId) {
      await deleteFromCloudinary(uploadedCoverLetterPublicId);
    }
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
        'name profilePic skills qualifications email phone educationLevel city state bio age experience subject profession currentPosition currentCompany institutionName linkedinUrl resumeUrl interests openToOpportunities badges isAdmin isSuperAdmin lastActiveAt activeDays followers profileThemeVariant'
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

    const populatedApplication = await Application.findById(application._id)
      .populate(
        'applicant',
        'name profilePic skills qualifications email phone educationLevel city state bio age experience subject profession currentPosition currentCompany institutionName linkedinUrl resumeUrl interests openToOpportunities badges isAdmin isSuperAdmin lastActiveAt activeDays followers profileThemeVariant'
      )
      .populate('jobPost', 'postedBy title');

    res.json({ success: true, application: populatedApplication });
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
        select: 'title institutionName location workplaceName workplaceAddress workplaceCity workplaceState workplaceCountry coordinates roleType shortJobType duration startTime endTime isPaid stipend deadline',
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

// @desc    Get expired jobs posted by current user
// @route   GET /api/jobs/my/archive
const getMyArchivedJobs = async (req, res) => {
  try {
    const jobs = await JobPost.find({
      postedBy: req.user._id,
      deadline: { $lt: getJobDeadlineCutoff() },
    })
      .populate('postedBy', 'name profilePic role category institutionName openToOpportunities badges isAdmin isSuperAdmin lastActiveAt activeDays followers profileThemeVariant')
      .sort({ deadline: -1, createdAt: -1 });

    const jobsWithCounts = await Promise.all(
      jobs.map(async (job) => {
        const applicationCount = await Application.countDocuments({ jobPost: job._id });
        return {
          ...job.toObject(),
          applicationCount,
          archiveReason: 'Deadline passed',
        };
      })
    );

    res.json({ success: true, jobs: jobsWithCounts });
  } catch (error) {
    console.error('Get my archived jobs error:', error);
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

    const jobs = await JobPost.find({
      isActive: true,
      status: 'approved',
      postedBy: { $ne: req.user._id },
      deadline: { $gte: getJobDeadlineCutoff() },
    })
      .populate('postedBy', 'name profilePic role category institutionName institutionPic openToOpportunities badges isAdmin isSuperAdmin lastActiveAt activeDays followers profileThemeVariant');

    const userSkills = toUniqueTerms(student.skills);
    const userQualifications = toUniqueTerms([
      ...(student.qualifications || []),
      student.educationLevel,
      student.profession,
      student.currentPosition,
      student.currentCompany,
      student.previousWork,
    ]);
    const userInterests = toUniqueTerms(student.interests);
    const profileTerms = toUniqueTerms([
      ...userSkills,
      ...userQualifications,
      ...userInterests,
      student.subject,
      student.bio,
    ]);

    const scored = jobs.map(job => {
      const jobSkills = toUniqueTerms(job.skillsRequired);
      const jobQualifications = toUniqueTerms(job.requiredQualifications);
      const contentText = normalizeMatchText(
        [
          job.title,
          job.description,
          job.institutionName,
          job.roleType,
          job.requiredQualifications,
          ...(job.skillsRequired || []),
        ].join(' ')
      );
      const matchedSkills = jobSkills.filter((skill) => bestTermMatch(skill, userSkills) >= 0.72);
      const missingSkills = jobSkills.filter((skill) => bestTermMatch(skill, userSkills) < 0.58);

      const skillScore = jobSkills.length
        ? scoreTermGroup(jobSkills, userSkills, 45)
        : Math.min(18, countContentHits(contentText, userSkills) * 6);
      const qualificationScore = jobQualifications.length
        ? scoreTermGroup(jobQualifications, userQualifications, 25)
        : Math.min(10, countContentHits(contentText, userQualifications) * 3);
      const contentScore = Math.min(15, countContentHits(contentText, profileTerms) * 2.5);
      const locationScore = scoreLocationMatch(job, student);
      const deadlineScore = scoreDeadlineHealth(job.deadline);
      const paidScore = job.isPaid ? 2 : 0;
      const totalScore = Math.min(
        100,
        skillScore + qualificationScore + contentScore + locationScore + deadlineScore + paidScore
      );

      return {
        job,
        score: Math.round(totalScore),
        matchedSkills,
        missingSkills,
        scoreBreakdown: {
          skills: Math.round(skillScore),
          qualifications: Math.round(qualificationScore),
          content: Math.round(contentScore),
          location: Math.round(locationScore),
          deadline: Math.round(deadlineScore),
          paid: paidScore,
        },
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
    let query = {
      isActive: true,
      status: 'approved',
      deadline: { $gte: getJobDeadlineCutoff() },
    };

    const jobs = await JobPost.find(query)
      .select('title institutionName institutionLogo isPaid roleType coordinates location workplaceName workplaceAddress workplaceCity workplaceState workplaceCountry postedBy')
      .populate('postedBy', 'name institutionName city state');

    // Filter by city/state if provided (from user profile or query params)
    let filtered = jobs;
    if (city || state) {
      filtered = jobs.filter(job => {
        const poster = job.postedBy;
        const jobCity = job.workplaceCity || poster?.city || '';
        const jobState = job.workplaceState || poster?.state || '';
        const cityMatch = city ? (jobCity.toLowerCase() === city.toLowerCase()) : true;
        const stateMatch = state ? (jobState.toLowerCase() === state.toLowerCase()) : true;
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
    if (!requireAdult(req.user, 'apply', res)) return;
    const completion = getProfileCompletionStatus(req.user);
    if (!completion.isComplete) {
      return res.status(403).json({ error: 'profile_incomplete', missingFields: completion.missingMandatory, message: 'Complete your profile before applying to jobs.' });
    }
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

    if (!job.isActive || job.status !== 'approved' || isJobExpired(job)) {
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
  getMyArchivedJobs,
  getMatchedJobs,
  incrementViewCount,
  getJobsMap,
  quickApply,
  addQnAQuestion,
  answerQnA,
  deleteQnA,
};
