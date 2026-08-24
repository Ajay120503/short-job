const User = require('../models/User');
const Post = require('../models/Post');
const JobPost = require('../models/JobPost');
const Story = require('../models/Story');
const Application = require('../models/Application');
const Message = require('../models/Message');
const LoginRecord = require('../models/LoginRecord');
const Conversation = require('../models/Conversation');
const { deleteFromCloudinary } = require('../middlewares/upload.middleware');

const addAsset = (set, value) => {
  if (value) set.add(value);
};

const deleteCloudinaryAssets = async (assets = []) => {
  const unique = [...new Set(assets.filter(Boolean))];
  for (const asset of unique) {
    await deleteFromCloudinary(asset);
  }
};

const collectUserCloudinaryAssets = async (userId) => {
  const assets = new Set();
  const [user, posts, jobs, stories, applications, loginRecords, ownMessages, conversations] =
    await Promise.all([
      User.findById(userId),
      Post.find({ author: userId }).select('images'),
      JobPost.find({ postedBy: userId }).select('image institutionLogo'),
      Story.find({ author: userId }).select('image'),
      Application.find({
        $or: [{ applicant: userId }, { jobPost: { $in: await JobPost.find({ postedBy: userId }).distinct('_id') } }],
      }).select('coverLetterFile'),
      LoginRecord.find({ user: userId }).select('photo'),
      Message.find({ sender: userId }).select('filePublicId fileUrl'),
      Conversation.find({ participants: userId }).select('_id'),
    ]);

  addAsset(assets, user?.profilePic?.publicId);
  addAsset(assets, user?.institutionPic?.publicId);
  addAsset(assets, user?.resumeUrl);
  (user?.verificationDocuments || []).forEach((doc) => {
    addAsset(assets, doc.publicId || doc.url);
  });

  posts.forEach((post) =>
    (post.images || []).forEach((image) => addAsset(assets, image.publicId || image.url))
  );
  jobs.forEach((job) => {
    addAsset(assets, job.image?.publicId || job.image?.url);
  });
  stories.forEach((story) => addAsset(assets, story.image?.publicId || story.image?.url));
  applications.forEach((application) =>
    addAsset(assets, application.coverLetterFile?.publicId || application.coverLetterFile?.url)
  );
  loginRecords.forEach((record) => addAsset(assets, record.photo?.publicId || record.photo?.url));
  ownMessages.forEach((message) => addAsset(assets, message.filePublicId || message.fileUrl));

  const conversationIds = conversations.map((conversation) => conversation._id);
  if (conversationIds.length > 0) {
    const conversationMessages = await Message.find({
      conversation: { $in: conversationIds },
    }).select('filePublicId fileUrl');
    conversationMessages.forEach((message) =>
      addAsset(assets, message.filePublicId || message.fileUrl)
    );
  }

  return [...assets];
};

module.exports = {
  collectUserCloudinaryAssets,
  deleteCloudinaryAssets,
};
