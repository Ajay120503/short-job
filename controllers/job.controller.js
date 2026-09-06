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
const {
  MIN_STANDALONE_CONTENT_LENGTH,
  MAX_SHORT_CREATION_TEXT_LENGTH,
  cleanString,
  sendValidationError,
  sendCreateError,
  parseLocalDate,
} = require('../utils/createValidation');

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

const KNOWN_CITY_CENTERS = [
  ['Pune', 18.5204, 73.8567], ['Pimpri-Chinchwad', 18.6298, 73.7997],
  ['Chakan', 18.7606, 73.8635], ['Talegaon Dabhade', 18.735, 73.6752],
  ['Lonavala', 18.7546, 73.4062], ['Khopoli', 18.7856, 73.3459],
  ['Saswad', 18.3447, 74.031], ['Jejuri', 18.2769, 74.1607],
  ['Shirur', 18.8276, 74.3747], ['Daund', 18.464, 74.5789],
  ['Baramati', 18.1517, 74.5777], ['Bhor', 18.1486, 73.8434],
  ['Wai', 17.9528, 73.8906], ['Satara', 17.6805, 74.0183],
  ['Ahmednagar', 19.0948, 74.748], ['Mumbai', 19.076, 72.8777],
  ['Navi Mumbai', 19.033, 73.0297], ['Thane', 19.2183, 72.9781],
  ['Nashik', 19.9975, 73.7898], ['Aurangabad', 19.8762, 75.3433],
  ['Nagpur', 21.1458, 79.0882], ['Kolhapur', 16.705, 74.2433],
  ['Solapur', 17.6599, 75.9064], ['Sangli', 16.8524, 74.5815],
  ['Delhi', 28.6139, 77.209], ['Noida', 28.5355, 77.391],
  ['Gurugram', 28.4595, 77.0266], ['Ghaziabad', 28.6692, 77.4538],
  ['Faridabad', 28.4089, 77.3178], ['Bengaluru', 12.9716, 77.5946],
  ['Mysuru', 12.2958, 76.6394], ['Chennai', 13.0827, 80.2707],
  ['Hyderabad', 17.385, 78.4867], ['Kolkata', 22.5726, 88.3639],
  ['Ahmedabad', 23.0225, 72.5714], ['Surat', 21.1702, 72.8311],
  ['Jaipur', 26.9124, 75.7873], ['Lucknow', 26.8467, 80.9462],
  ['Kochi', 9.9312, 76.2673], ['Thiruvananthapuram', 8.5241, 76.9366],
];

const getKnownNearbyCities = (lat, lng, radiusKm) => KNOWN_CITY_CENTERS
  .map(([name, cityLat, cityLng]) => ({
    name,
    distanceKm: distanceKm(lat, lng, cityLat, cityLng),
  }))
  .filter((city) => city.distanceKm <= radiusKm);

const KNOWN_AREA_CENTERS = [
  ['Kothrud', 18.5074, 73.8077], ['Karve Nagar', 18.4898, 73.8214],
  ['Erandwane', 18.5062, 73.8313], ['Warje', 18.4829, 73.7934],
  ['Bavdhan', 18.5186, 73.7707], ['Deccan Gymkhana', 18.5165, 73.8419],
  ['Shivajinagar', 18.5308, 73.8475], ['Model Colony', 18.5357, 73.8376],
  ['Pashan', 18.5386, 73.7950], ['Aundh', 18.5580, 73.8075],
  ['Baner', 18.5590, 73.7868], ['Balewadi', 18.5707, 73.7747],
  ['Wakad', 18.5993, 73.7638], ['Hinjawadi', 18.5913, 73.7389],
  ['Sadashiv Peth', 18.5103, 73.8502], ['Swargate', 18.5018, 73.8636],
  ['Camp', 18.5132, 73.8797], ['Koregaon Park', 18.5362, 73.8939],
  ['Kalyani Nagar', 18.5481, 73.9033], ['Viman Nagar', 18.5679, 73.9143],
  ['Kharadi', 18.5515, 73.9348], ['Hadapsar', 18.5089, 73.9259],
  ['Kondhwa', 18.4695, 73.8907], ['Bibwewadi', 18.4698, 73.8630],
  ['Dhankawadi', 18.4655, 73.8547], ['Katraj', 18.4529, 73.8652],
  ['Sinhagad Road', 18.4775, 73.8214], ['Nanded City', 18.4553, 73.7915],
  ['Dhayari', 18.4473, 73.8070], ['Ambegaon', 18.4451, 73.8422],
  ['Yerawada', 18.5526, 73.8797], ['Khadki', 18.5633, 73.8513],
  ['Pimpri', 18.6298, 73.7997], ['Chinchwad', 18.6279, 73.8009],
];

const getKnownNearbyAreas = (lat, lng, radiusKm) => KNOWN_AREA_CENTERS
  .map(([name, areaLat, areaLng]) => ({
    name,
    distanceKm: distanceKm(lat, lng, areaLat, areaLng),
  }))
  .filter((area) => area.distanceKm <= radiusKm);

const getJobAreaName = (job) => {
  const addressPart = String(job.workplaceAddress || '').split(',')[0].trim();
  return addressPart || String(job.workplaceName || '').trim() || String(job.workplaceCity || '').trim();
};

// @desc    Get distinct job cities within 100 km of a location
// @route   GET /api/jobs/nearby-cities
const getNearbyJobCities = async (req, res) => {
  try {
    const lat = parseCoordinate(req.query.lat);
    const lng = parseCoordinate(req.query.lng);
    if (
      lat === undefined || lng === undefined
      || lat < -90 || lat > 90 || lng < -180 || lng > 180
    ) {
      return res.status(400).json({ message: 'Valid latitude and longitude are required.' });
    }

    const radiusKm = 100;
    const jobs = await JobPost.find({
        isActive: true,
        status: 'approved',
        deadline: { $gte: getJobDeadlineCutoff() },
        workplaceCity: { $exists: true, $nin: ['', null] },
        location_point: {
          $geoWithin: { $centerSphere: [[lng, lat], radiusKm / 6371] },
        },
      }).select('workplaceCity location_point').lean();
    const nearbyPlaces = getKnownNearbyCities(lat, lng, radiusKm);

    const cities = new Map();
    jobs.forEach((job) => {
      const name = job.workplaceCity?.trim();
      const point = job.location_point?.coordinates;
      if (!name || point?.length !== 2) return;
      const distance = distanceKm(lat, lng, point[1], point[0]);
      const key = name.toLowerCase();
      if (!cities.has(key) || distance < cities.get(key).distanceKm) {
        cities.set(key, { name, distanceKm: Math.round(distance * 10) / 10 });
      }
    });
    nearbyPlaces.forEach(({ name, distanceKm: distance }) => {
      const key = name.toLowerCase();
      if (!cities.has(key) || distance < cities.get(key).distanceKm) {
        cities.set(key, { name, distanceKm: Math.round(distance * 10) / 10 });
      }
    });

    res.json({
      success: true,
      radiusKm,
      cities: [...cities.values()].sort((a, b) => a.distanceKm - b.distanceKm),
    });
  } catch (error) {
    console.error('Get nearby job cities error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Get nearby job localities/areas for the active distance filter
// @route   GET /api/jobs/nearby-areas
const getNearbyJobAreas = async (req, res) => {
  try {
    const lat = parseCoordinate(req.query.lat);
    const lng = parseCoordinate(req.query.lng);
    const requestedRadius = Number(req.query.radiusKm);
    if (lat === undefined || lng === undefined || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({ message: 'Valid latitude and longitude are required.' });
    }
    const radiusKm = Number.isFinite(requestedRadius)
      ? Math.min(1000, Math.max(1, requestedRadius))
      : 5;
    const jobs = await JobPost.find({
      isActive: true,
      status: 'approved',
      deadline: { $gte: getJobDeadlineCutoff() },
      location_point: { $geoWithin: { $centerSphere: [[lng, lat], radiusKm / 6371] } },
    }).select('workplaceName workplaceAddress workplaceCity location_point').lean();

    const areas = new Map();
    const addArea = (name, distance) => {
      const cleanName = String(name || '').trim();
      if (!cleanName) return;
      const key = cleanName.toLowerCase();
      const roundedDistance = Math.round(distance * 10) / 10;
      if (!areas.has(key) || roundedDistance < areas.get(key).distanceKm) {
        areas.set(key, { name: cleanName, distanceKm: roundedDistance });
      }
    };
    jobs.forEach((job) => {
      const point = job.location_point?.coordinates;
      if (point?.length === 2) addArea(getJobAreaName(job), distanceKm(lat, lng, point[1], point[0]));
    });
    getKnownNearbyAreas(lat, lng, radiusKm).forEach((area) => addArea(area.name, area.distanceKm));

    res.json({
      success: true,
      radiusKm,
      areas: [...areas.values()].sort((a, b) => a.distanceKm - b.distanceKm),
    });
  } catch (error) {
    console.error('Get nearby job areas error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Get all active jobs
// @route   GET /api/jobs
const getJobs = async (req, res) => {
  try {
    const {
      paid, isPaid, location, roleType, shortJobType, city, state, area,
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
    if (area) {
      const areaPattern = new RegExp(String(area).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filters.$and = [{
        $or: [
          { workplaceName: areaPattern },
          { workplaceAddress: areaPattern },
          { workplaceCity: areaPattern },
        ],
      }];
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
    const title = cleanString(req.body.title);
    const description = cleanString(req.body.description);
    const institutionName = cleanString(req.body.institutionName) || cleanString(req.user.institutionName);
    const roleType = cleanString(req.body.roleType) || 'other';
    const shortJobType = cleanString(req.body.shortJobType);
    const durationUnit = cleanString(req.body.durationUnit);
    const durationValue = req.body.durationValue;
    const jobDate = cleanString(req.body.jobDate);
    const startTime = cleanString(req.body.startTime);
    const endTime = cleanString(req.body.endTime);
    const deadline = cleanString(req.body.deadline);
    const contactEmail = cleanString(req.body.contactEmail).toLowerCase();
    const location = cleanString(req.body.location) || 'onsite';
    const workplaceName = cleanString(req.body.workplaceName);
    const workplaceAddress = cleanString(req.body.workplaceAddress);
    const workplaceCity = cleanString(req.body.workplaceCity);
    const workplaceState = cleanString(req.body.workplaceState);
    const workplaceCountry = cleanString(req.body.workplaceCountry);
    const requiredQualifications = cleanString(req.body.requiredQualifications);
    const currency = cleanString(req.body.currency) || 'INR';
    const isPaid = req.body.isPaid === 'true' || req.body.isPaid === true;
    const stipend = Number(req.body.stipend);
    const maxApplicants = req.body.maxApplicants === '' || req.body.maxApplicants == null
      ? 0 : Number(req.body.maxApplicants);
    const skills = normalizeListInput(req.body.skillsRequired);
    const errors = {};

    if (title.length < MIN_STANDALONE_CONTENT_LENGTH) {
      errors.title = `Job title must contain at least ${MIN_STANDALONE_CONTENT_LENGTH} characters.`;
    } else if (title.length > MAX_SHORT_CREATION_TEXT_LENGTH) {
      errors.title = `Job title cannot exceed ${MAX_SHORT_CREATION_TEXT_LENGTH} characters.`;
    }
    if (description.length < MIN_STANDALONE_CONTENT_LENGTH) {
      errors.description = `Description must contain at least ${MIN_STANDALONE_CONTENT_LENGTH} characters.`;
    }
    else if (description.length > 5000) errors.description = 'Description cannot exceed 5000 characters.';
    if (!institutionName) errors.institutionName = 'Organization name is required.';
    else if (institutionName.length > 150) errors.institutionName = 'Organization name cannot exceed 150 characters.';

    const roleTypes = ['teacher', 'professor', 'hod', 'principal', 'intern', 'volunteer', 'assistant', 'research', 'other'];
    const shortJobTypes = ['one_day_gig', 'few_hours', 'weekend_only', 'short_term', 'ongoing_part_time', 'full_time', 'internship', 'volunteer'];
    if (!roleTypes.includes(roleType)) errors.roleType = 'Choose a valid role type.';
    if (!shortJobTypes.includes(shortJobType)) errors.shortJobType = 'Choose a valid short job type.';

    const duration = req.body.duration && typeof req.body.duration === 'object'
      ? req.body.duration : { unit: durationUnit, value: Number(durationValue) };
    const numericDuration = Number(duration.value);
    if (!['hours', 'days'].includes(duration.unit)) errors.durationUnit = 'Duration unit must be hours or days.';
    if (!Number.isFinite(numericDuration) || numericDuration < 0.25) errors.durationValue = 'Duration must be at least 0.25.';
    else if ((duration.unit === 'hours' && numericDuration > 24) || (duration.unit === 'days' && numericDuration > 365)) {
      errors.durationValue = `Duration cannot exceed ${duration.unit === 'hours' ? '24 hours' : '365 days'}.`;
    }

    const validTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
    if (!validTime.test(startTime)) errors.startTime = 'Choose a valid start time.';
    if (!validTime.test(endTime)) errors.endTime = 'Choose a valid end time.';
    else if (startTime === endTime) errors.endTime = 'End time must be different from the start time.';

    const parsedJobDate = parseLocalDate(jobDate);
    const parsedDeadline = parseLocalDate(deadline);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (!parsedJobDate) errors.jobDate = 'Choose a valid job date.';
    else if (parsedJobDate < today) errors.jobDate = 'Job date cannot be in the past.';
    if (!parsedDeadline) errors.deadline = 'Choose a valid application deadline.';
    else if (parsedDeadline < today) errors.deadline = 'Application deadline cannot be in the past.';
    else if (!errors.jobDate && parsedDeadline > parsedJobDate) errors.deadline = 'Application deadline cannot be after the job date.';

    if (!/^\S+@\S+\.\S+$/.test(contactEmail) || contactEmail.length > 254) errors.contactEmail = 'Enter a valid contact email address.';
    if (!['onsite', 'remote', 'hybrid'].includes(location)) errors.location = 'Choose on-site, remote, or hybrid.';
    if (!['INR', 'USD'].includes(currency)) errors.currency = 'Choose a supported currency.';
    if (isPaid && (!Number.isFinite(stipend) || stipend <= 0)) errors.stipend = 'Enter a paid amount greater than zero.';
    if (!Number.isInteger(maxApplicants) || maxApplicants < 0 || maxApplicants > 100000) errors.maxApplicants = 'Applicant limit must be a whole number between 0 and 100,000.';

    const lengthLimits = {
      workplaceName: [workplaceName, 150], workplaceAddress: [workplaceAddress, 300],
      workplaceCity: [workplaceCity, 100], workplaceState: [workplaceState, 100],
      workplaceCountry: [workplaceCountry, 100], requiredQualifications: [requiredQualifications, 2000],
    };
    for (const [field, [value, limit]] of Object.entries(lengthLimits)) {
      if (value.length > limit) errors[field] = `${field.replace(/([A-Z])/g, ' $1')} cannot exceed ${limit} characters.`;
    }
    if (location !== 'remote' && !workplaceCity) errors.workplaceCity = 'City is required for on-site and hybrid jobs.';
    if (skills.length > 20) errors.skillsRequired = 'Add no more than 20 skills.';
    else if (skills.some((skill) => skill.length > 50)) errors.skillsRequired = 'Each skill must be 50 characters or fewer.';

    if (Object.keys(errors).length) return sendValidationError(res, errors);

    let coordinates = getJobCoordinatesFromBody(req.body);
    if (coordinates === null) {
      return sendValidationError(res, { coordinates: 'Latitude must be -90 to 90 and longitude must be -180 to 180.' });
    }
    if (!coordinates && location !== 'remote') coordinates = await geocodeJobAddress(req.body);

    const moderationState = await getInitialModerationState('job');

    const jobData = {
      postedBy: req.user._id,
      institutionName,
      institutionLogo: req.user.institutionPic || { url: '', publicId: '' },
      title,
      description,
      roleType,
      shortJobType,
      duration: { unit: duration.unit, value: numericDuration },
      jobDate: parsedJobDate,
      startTime,
      endTime,
      isPaid,
      currency,
      stipend: isPaid ? stipend : 0,
      location,
      workplaceName,
      workplaceAddress,
      workplaceCity,
      workplaceState,
      workplaceCountry,
      requiredQualifications,
      skillsRequired: skills,
      deadline: parsedDeadline,
      contactEmail,
      maxApplicants,
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
      .populate('postedBy', 'name profilePic role category institutionName openToOpportunities badges isAdmin isSuperAdmin lastActiveAt activeDays followers profileThemeVariant') || job;

    // Auxiliary feed/notification failures must not report a successfully saved job as failed.
    try {
      await Post.create({
        author: req.user._id,
        type: 'job',
        text: populatedJob.title,
        jobPost: populatedJob._id,
        status: populatedJob.status,
        moderationMeta: populatedJob.moderationMeta,
      });
    } catch (feedError) {
      console.error('Create job feed post error:', feedError);
    }

    // Notify followers about new job post
    const followers = req.user.followers || [];
    if (followers.length) {
      try {
        await Notification.insertMany(followers.map((followerId) => ({
          recipient: followerId,
          sender: req.user._id,
          type: 'job_applied',
          message: `${req.user.name} posted a new job: ${title}`,
          link: `/jobs/${job._id}`,
        })));
      } catch (notificationError) {
        console.error('Create job notifications error:', notificationError);
      }

      try {
        const io = getIO();
        followers.forEach((followerId) => io.to(followerId.toString()).emit('notification', {
          type: 'job_applied', message: `${req.user.name} posted a new job: ${title}`, link: `/jobs/${job._id}`,
        }));
      } catch (socketErr) {}
    }

    res.status(201).json({ success: true, job: populatedJob });
  } catch (error) {
    if (!jobCreated && uploadedJobImagePublicId) {
      await deleteFromCloudinary(uploadedJobImagePublicId);
    }
    console.error('Create job error:', error);
    return sendCreateError(res, error, 'The job could not be created. Please try again.');
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
      'shortJobType', 'jobDate', 'startTime', 'endTime',
    ];

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        job[field] = req.body[field];
      }
    }

    job.title = cleanString(job.title);
    job.description = cleanString(job.description);
    if (job.title.length < MIN_STANDALONE_CONTENT_LENGTH || job.title.length > MAX_SHORT_CREATION_TEXT_LENGTH) {
      return sendValidationError(res, {
        title: `Job title must contain ${MIN_STANDALONE_CONTENT_LENGTH} to ${MAX_SHORT_CREATION_TEXT_LENGTH} characters.`,
      });
    }
    if (job.description.length < MIN_STANDALONE_CONTENT_LENGTH) {
      return sendValidationError(res, {
        description: `Description must contain at least ${MIN_STANDALONE_CONTENT_LENGTH} characters.`,
      });
    }

    if (req.body.skillsRequired !== undefined) {
      job.skillsRequired = normalizeListInput(req.body.skillsRequired);
    }
    if (req.body.duration || req.body.durationUnit || req.body.durationValue) {
      const duration = req.body.duration && typeof req.body.duration === 'object' ? req.body.duration : { unit: req.body.durationUnit, value: Number(req.body.durationValue) };
      if (!['hours', 'days'].includes(duration.unit) || !Number.isFinite(Number(duration.value)) || Number(duration.value) <= 0) return res.status(400).json({ message: 'Duration must be a positive number of hours or days.' });
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
    if (req.body.jobDate !== undefined) {
      const parsedJobDate = new Date(req.body.jobDate);
      if (Number.isNaN(parsedJobDate.getTime())) return res.status(400).json({ message: 'Please provide a valid job date.' });
      job.jobDate = parsedJobDate;
    }
    if (job.jobDate && job.deadline && new Date(job.deadline) > new Date(job.jobDate)) {
      return res.status(400).json({ message: 'Application deadline cannot be after the job date.' });
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
    return sendCreateError(res, error, 'The job could not be updated. Please try again.');
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
        select: 'title institutionName location workplaceName workplaceAddress workplaceCity workplaceState workplaceCountry coordinates roleType shortJobType duration jobDate startTime endTime isPaid stipend deadline',
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
    const question = cleanString(req.body.question);
    const { isAnonymous } = req.body;
    if (!question) return sendValidationError(res, { question: 'Question is required.' });
    if (question.length > 500) return sendValidationError(res, { question: 'Question cannot exceed 500 characters.' });

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
    try {
      await Notification.create({
        recipient: job.postedBy, sender: req.user._id, type: 'job_qna',
        message: `A new question was asked on your job: ${job.title}`, link: `/jobs/${job._id}`,
      });
    } catch (notificationError) {
      console.error('QnA notification error:', notificationError);
    }

    const populated = await JobPost.findById(job._id)
      .populate('qna.askedBy', 'name profilePic openToOpportunities');

    res.status(201).json({ success: true, qna: populated.qna });
  } catch (error) {
    console.error('Add QnA question error:', error);
    return sendCreateError(res, error, 'The question could not be posted. Please try again.');
  }
};

// @desc    F12 — Answer a QnA question
// @route   POST /api/jobs/:id/qna/:qnaId/answer
const answerQnA = async (req, res) => {
  try {
    const answer = cleanString(req.body.answer);
    if (!answer) return sendValidationError(res, { answer: 'Answer is required.' });
    if (answer.length > 2000) return sendValidationError(res, { answer: 'Answer cannot exceed 2000 characters.' });

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
      try {
        await Notification.create({
          recipient: qnaItem.askedBy, sender: req.user._id, type: 'job_qna',
          message: `Your question on "${job.title}" was answered.`, link: `/jobs/${job._id}`,
        });
      } catch (notificationError) {
        console.error('QnA answer notification error:', notificationError);
      }
    }

    const populated = await JobPost.findById(job._id)
      .populate('qna.askedBy', 'name profilePic openToOpportunities');

    res.json({ success: true, qna: populated.qna });
  } catch (error) {
    console.error('Answer QnA error:', error);
    return sendCreateError(res, error, 'The answer could not be posted. Please try again.');
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
  getNearbyJobCities,
  getNearbyJobAreas,
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
