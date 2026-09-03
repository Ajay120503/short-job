const Story = require('../models/Story');
const { uploadToCloudinary, deleteFromCloudinary } = require('../middlewares/upload.middleware');
const { getInitialModerationState, applyInitialRuleModeration } = require('../utils/adminSettings');
const { sortByPriorityAndNewest } = require('../utils/contentOrdering');

const USER_SIGNAL_SELECT = 'name profilePic badges role category institutionName institutionPic openToOpportunities isAdmin isSuperAdmin lastActiveAt activeDays followers profileThemeVariant';

// @desc    F13 — Create a story
// @route   POST /api/stories
const createStory = async (req, res) => {
  let uploadedStoryPublicId = '';
  let storyCreated = false;
  try {
    const { text } = req.body;
    if (!req.file && !text) {
      return res.status(400).json({ message: 'Story must have an image or text.' });
    }

    const moderationState = await getInitialModerationState('story');

    const storyData = {
      author: req.user._id,
      text: text || '',
      ...moderationState,
    };

    if (req.file) {
      const result = await uploadToCloudinary(req.file, 'ShortJob/stories');
      uploadedStoryPublicId = result.public_id;
      storyData.image = {
        url: result.secure_url,
        publicId: result.public_id,
      };
    }

    const moderatedState = await applyInitialRuleModeration(storyData, 'story', moderationState);
    storyData.status = moderatedState.status;
    storyData.moderationMeta = moderatedState.moderationMeta;

    const story = await Story.create(storyData);
    storyCreated = true;
    const populated = await Story.findById(story._id)
      .populate('author', USER_SIGNAL_SELECT);

    res.status(201).json({ success: true, story: populated });
  } catch (error) {
    if (!storyCreated && uploadedStoryPublicId) {
      await deleteFromCloudinary(uploadedStoryPublicId);
    }
    console.error('Create story error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    F13 — Get public approved stories and own pending stories
// @route   GET /api/stories
const getStories = async (req, res) => {
  try {
    const allowedAuthors = req.user ? [...(req.user.following || []), req.user._id] : [];
    const query = req.user
      ? {
          $or: [
            { status: 'approved', author: { $in: allowedAuthors } },
            { author: req.user._id },
          ],
        }
      : { status: 'approved' };

    const stories = await Story.find(query)
      .populate('author', USER_SIGNAL_SELECT)
      .sort({ createdAt: -1 });

    // Group by author
    const grouped = {};
    stories.forEach(story => {
      const authorId = story.author._id.toString();
      if (!grouped[authorId]) {
        grouped[authorId] = {
          author: story.author,
          stories: [],
          latestAt: story.createdAt,
        };
      }
      grouped[authorId].stories.push(story);
    });

    const orderedStories = sortByPriorityAndNewest(
      Object.values(grouped).map((group) => ({
        ...group,
        stories: [...group.stories].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
      })),
      req.user,
      (group) => group.author,
      (group) => group.latestAt
    ).map(({ latestAt, ...group }) => group);

    res.json({ success: true, stories: orderedStories });
  } catch (error) {
    console.error('Get stories error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    F13 — Mark a story as viewed
// @route   POST /api/stories/:id/view
const viewStory = async (req, res) => {
  try {
    const story = await Story.findByIdAndUpdate(
      req.params.id,
      { $addToSet: { viewers: req.user._id } },
      { returnDocument: 'after' }
    );

    if (!story) {
      return res.status(404).json({ message: 'Story not found.' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('View story error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    F13 — Delete a story
// @route   DELETE /api/stories/:id
const deleteStory = async (req, res) => {
  try {
    const story = await Story.findById(req.params.id);
    if (!story) {
      return res.status(404).json({ message: 'Story not found.' });
    }

    if (story.author.toString() !== req.user._id.toString() && !req.user.isAdmin && !req.user.isSuperAdmin) {
      return res.status(403).json({ message: 'You can only delete your own stories.' });
    }

    if (story.image?.publicId) {
      await deleteFromCloudinary(story.image.publicId);
    }

    await story.deleteOne();
    res.json({ success: true, message: 'Story deleted.' });
  } catch (error) {
    console.error('Delete story error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

const getStoryViewers = async (req, res) => {
  try {
    const story = await Story.findById(req.params.id).populate('viewers', USER_SIGNAL_SELECT);
    if (!story) return res.status(404).json({ message: 'Story not found.' });
    if (story.author.toString() !== req.user._id.toString()) return res.status(403).json({ message: 'Only the author can view this list.' });
    res.json({ success: true, viewers: story.viewers });
  } catch (error) {
    console.error('Get story viewers error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

module.exports = {
  createStory,
  getStories,
  viewStory,
  deleteStory,
  getStoryViewers,
};
