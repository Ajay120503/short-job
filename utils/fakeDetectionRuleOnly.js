const SPAM_KEYWORDS = [
  'guaranteed job',
  '100% placement',
  'work from home 50k',
  'apply in 2 hours',
  'urgent hiring',
  'no experience needed high salary',
  'fast money',
  'easy money',
  'make money fast',
];

const runFakeDetectionRuleOnly = async (content, type) => {
  const flags = [];
  let score = 0;
  const author = content.author || content.postedBy;

  // Author Signal Scoring
  const accountAgeDays = author?.createdAt
    ? (Date.now() - author.createdAt) / (1000 * 60 * 60 * 24)
    : 0;
  if (accountAgeDays < 1) {
    score += 10;
    flags.push('new_account');
  }
  if (!author?.isEmailVerified && !author?.isVerified) {
    score += 10;
    flags.push('unverified_email');
  }
  if (!author?.profilePic?.url) {
    score += 5;
    flags.push('no_profile_pic');
  }
  if ((author?.followers || []).length === 0) {
    score += 5;
    flags.push('no_followers');
  }

  // Check for spam keywords in text
  const text = (content.text || content.description || '').toLowerCase();
  SPAM_KEYWORDS.forEach((kw) => {
    if (text.includes(kw)) {
      score += 35;
      flags.push('spam_keywords');
    }
  });

  // Institution check for job posts
  if (type === 'job' && !content.institutionName) {
    score += 10;
    flags.push('no_institution_detail');
  }

  // Phone number detection in text
  if (/\b\d{10}\b/.test(text)) {
    score += 15;
    flags.push('external_contact');
  }

  // Check for previous rejections
  const authorField = type === 'job' ? 'postedBy' : 'author';
  const rejections = await content.constructor?.countDocuments({
    [authorField]: author?._id,
    status: 'rejected',
  }) || 0;
  score += rejections * 20;
  if (rejections > 0) {
    flags.push(`previous_rejections_${rejections}`);
  }

  const approved = score < 60;
  return { approved, score: Math.round(score), flags: [...new Set(flags)], reason: 'Rule-based scoring (no external API)' };
};

module.exports = { runFakeDetectionRuleOnly };
