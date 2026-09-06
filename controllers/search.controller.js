const User = require('../models/User');
const JobPost = require('../models/JobPost');
const Post = require('../models/Post');

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const buildTokenSearch = (query, fields) => {
  const tokens = [...new Set(String(query).trim().split(/\s+/).filter(Boolean))].slice(0, 6);
  return tokens.map((token) => {
    const pattern = new RegExp(escapeRegex(token), 'i');
    return { $or: fields.map((field) => ({ [field]: pattern })) };
  });
};

const globalSearch = async (req, res) => {
  try {
    const query = String(req.query.q || '').trim();
    if (query.length < 2) {
      return res.json({ success: true, query, results: { users: [], jobs: [], posts: [] } });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [users, jobs, posts] = await Promise.all([
      User.find({
        isActive: { $ne: false },
        isBlocked: { $ne: true },
        _id: { $ne: req.user._id },
        $and: buildTokenSearch(query, ['name', 'role', 'category', 'institutionName', 'city', 'state', 'skills']),
      })
        .select('name profilePic role category institutionName city state badges isAdmin isSuperAdmin')
        .limit(8)
        .lean(),
      JobPost.find({
        isActive: true,
        deadline: { $gte: today },
        $and: [
          { $or: [{ status: 'approved' }, { postedBy: req.user._id }] },
          ...buildTokenSearch(query, [
            'title', 'description', 'institutionName', 'roleType', 'shortJobType',
            'skillsRequired', 'workplaceName', 'workplaceAddress', 'workplaceCity', 'workplaceState',
          ]),
        ],
      })
        .select('title institutionName workplaceName workplaceCity location image institutionLogo postedBy')
        .populate('postedBy', 'name')
        .limit(8)
        .lean(),
      Post.find({
        $and: [
          { $or: [{ status: 'approved' }, { author: req.user._id }] },
          ...buildTokenSearch(query, ['text', 'type', 'tags', 'eventDetails.location']),
        ],
      })
        .select('text type tags images author createdAt')
        .populate('author', 'name profilePic')
        .sort({ createdAt: -1 })
        .limit(8)
        .lean(),
    ]);

    res.json({ success: true, query, results: { users, jobs, posts } });
  } catch (error) {
    console.error('Global search error:', error);
    res.status(500).json({ message: 'Unable to search right now.' });
  }
};

module.exports = { globalSearch };
