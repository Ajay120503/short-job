const URL_REGEX = /https?:\/\/|www\.|t\.me\/|bit\.ly|tinyurl|wa\.me|telegram|whatsapp/gi;
const EMAIL_REGEX = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PHONE_REGEX = /(?:\+?\d[\s-]?){8,}/g;
const MONEY_REGEX = /(?:₹|rs\.?|inr|\$|usd)\s?\d+|\d+\s?(?:rs|inr|usd|dollars?|rupees?)/gi;

const SPAM_PHRASES = [
  'work from home',
  'earn money fast',
  'instant earning',
  'guaranteed income',
  'daily income',
  'click this link',
  'join now',
  'limited seats',
  'urgent hiring',
  'registration fee',
  'security deposit',
  'pay first',
  'investment required',
  'no interview',
  'no experience required',
  'dm me',
  'message me on whatsapp',
  'telegram group',
  'free certificate',
  '100% placement',
  'guaranteed job',
  'fake marksheet',
  'exam answers',
  'leaked paper',
];

const RISKY_WORDS = [
  'scam',
  'hack',
  'leak',
  'fraud',
  'betting',
  'casino',
  'loan',
  'crypto',
  'adult',
  'drugs',
  'weapon',
  'violence',
  'hate',
];

const EDUCATION_TERMS = [
  'teacher',
  'student',
  'school',
  'college',
  'university',
  'class',
  'course',
  'subject',
  'skills',
  'qualification',
  'internship',
  'research',
  'project',
  'education',
  'academic',
  'faculty',
  'professor',
  'mentor',
  'training',
  'job',
  'role',
  'opportunity',
];

const JOB_REQUIRED_FIELDS = ['title', 'description', 'deadline', 'contactEmail'];

const normalize = (value = '') =>
  String(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}@.+:/₹$%-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const asArray = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
};

const countMatches = (text, regex) => (String(text).match(regex) || []).length;

const phraseHits = (text, phrases) =>
  phrases.filter((phrase) => text.includes(phrase));

const uniqueTokenRatio = (text) => {
  const tokens = text.split(/\s+/).filter((token) => token.length > 2);
  if (tokens.length < 8) return 1;
  return new Set(tokens).size / tokens.length;
};

const repeatedPatternCount = (rawText) => {
  const repeatedChars = countMatches(rawText, /(.)\1{5,}/g);
  const repeatedWords = countMatches(normalize(rawText), /\b(\w+)(?:\s+\1){3,}\b/g);
  return repeatedChars + repeatedWords;
};

const collectText = (content, type) => {
  if (!content) return '';

  const parts = [
    content.title,
    content.text,
    content.content,
    content.description,
    content.institutionName,
    content.requiredQualifications,
    ...asArray(content.skillsRequired),
    ...asArray(content.tags),
  ];

  if (type === 'story' && content.image?.url && !content.text) {
    parts.push('story image');
  }

  return parts.filter(Boolean).join(' ');
};

const addFlag = (flags, flag, weight, meta = {}) => {
  flags.push({ flag, weight, ...meta });
  return weight;
};

const scoreCommonSignals = ({ rawText, text, type, content, flags }) => {
  let score = 0;

  if (type !== 'story' && text.length < 12) {
    score += addFlag(flags, 'too_little_context', 18);
  }

  if (text.length > 5000) {
    score += addFlag(flags, 'excessive_length', 12);
  }

  const links = countMatches(rawText, URL_REGEX);
  if (links > 0) {
    score += addFlag(flags, 'external_link', Math.min(links * 10, 25), { count: links });
  }

  const emails = countMatches(rawText, EMAIL_REGEX);
  const phones = countMatches(rawText, PHONE_REGEX);
  if (type !== 'job' && emails + phones > 0) {
    score += addFlag(flags, 'contact_details_outside_job', Math.min((emails + phones) * 10, 25));
  }

  const spamHits = phraseHits(text, SPAM_PHRASES);
  if (spamHits.length > 0) {
    score += addFlag(flags, 'spam_or_scam_language', Math.min(18 + spamHits.length * 7, 40), {
      matches: spamHits.slice(0, 5),
    });
  }

  const riskyHits = phraseHits(text, RISKY_WORDS);
  if (riskyHits.length > 0) {
    score += addFlag(flags, 'unsafe_or_suspicious_terms', Math.min(riskyHits.length * 12, 35), {
      matches: riskyHits.slice(0, 5),
    });
  }

  const repeatedScore = repeatedPatternCount(rawText);
  if (repeatedScore > 0) {
    score += addFlag(flags, 'repeated_spam_pattern', Math.min(repeatedScore * 10, 25));
  }

  if (uniqueTokenRatio(text) < 0.45) {
    score += addFlag(flags, 'low_text_diversity', 14);
  }

  const capsLetters = String(rawText).replace(/[^A-Z]/g, '').length;
  const letters = String(rawText).replace(/[^a-zA-Z]/g, '').length;
  if (letters > 20 && capsLetters / letters > 0.65) {
    score += addFlag(flags, 'excessive_caps', 10);
  }

  if (phraseHits(text, EDUCATION_TERMS).length === 0 && type !== 'story') {
    score += addFlag(flags, 'weak_academic_relevance', 10);
  }

  if (content?.images?.length > 5) {
    score += addFlag(flags, 'too_many_images', 12);
  }

  return score;
};

const scoreJobSignals = ({ content, rawText, text, flags }) => {
  let score = 0;

  const missing = JOB_REQUIRED_FIELDS.filter((field) => !content?.[field]);
  if (missing.length > 0) {
    score += addFlag(flags, 'missing_required_job_fields', missing.length * 14, { fields: missing });
  }

  if (countMatches(content?.contactEmail || '', EMAIL_REGEX) === 0) {
    score += addFlag(flags, 'invalid_contact_email', 18);
  }

  const paymentHits = phraseHits(text, ['registration fee', 'security deposit', 'pay first', 'investment required']);
  if (paymentHits.length > 0) {
    score += addFlag(flags, 'job_requests_upfront_payment', 42, { matches: paymentHits });
  }

  const stipend = Number(content?.stipend || 0);
  if (countMatches(rawText, MONEY_REGEX) >= 3 || stipend > 500000) {
    score += addFlag(flags, 'unusual_compensation_claim', stipend > 500000 ? 28 : 14);
  }

  if (asArray(content?.skillsRequired).length === 0) {
    score += addFlag(flags, 'job_missing_skills', 8);
  }

  if (String(content?.description || '').trim().length < 40) {
    score += addFlag(flags, 'job_description_too_short', 16);
  }

  if (content?.deadline && new Date(content.deadline).getTime() < Date.now() - 24 * 60 * 60 * 1000) {
    score += addFlag(flags, 'expired_deadline', 18);
  }

  return score;
};

const scorePostSignals = ({ content, text, flags }) => {
  let score = 0;

  if (content?.type === 'achievement') {
    const proofTerms = ['won', 'completed', 'certified', 'selected', 'published', 'rank', 'award', 'project'];
    if (phraseHits(text, proofTerms).length === 0 && !content?.images?.length) {
      score += addFlag(flags, 'achievement_lacks_context', 12);
    }
  }

  if (content?.type === 'job' && !content?.jobPost) {
    const jobTerms = ['role', 'apply', 'salary', 'stipend', 'hiring', 'opening'];
    if (phraseHits(text, jobTerms).length >= 2) {
      score += addFlag(flags, 'job_like_post_needs_review', 10);
    }
  }

  return score;
};

const scoreStorySignals = ({ content, rawText, text, flags }) => {
  let score = 0;

  if (!content?.image?.url && text.length < 6) {
    score += addFlag(flags, 'empty_or_low_context_story', 18);
  }

  if (countMatches(rawText, URL_REGEX) > 0) {
    score += addFlag(flags, 'story_contains_link', 20);
  }

  return score;
};

const getDecision = (score, flags) => {
  const critical = flags.some((item) =>
    ['job_requests_upfront_payment', 'unsafe_or_suspicious_terms'].includes(item.flag) &&
    item.weight >= 30
  );
  const riskyStoryLink =
    flags.some((item) => item.flag === 'story_contains_link') &&
    flags.some((item) => item.flag === 'spam_or_scam_language');

  if (critical || riskyStoryLink || score >= 58) {
    return {
      approved: false,
      reason: critical || riskyStoryLink
        ? 'Rejected by rule-based safety checks for high-risk content.'
        : 'Rejected by rule-based safety checks due to multiple suspicious signals.',
    };
  }

  return {
    approved: true,
    reason:
      score >= 34
        ? 'Approved with caution by rule-based checks; keep available for admin audit.'
        : 'Approved by rule-based safety checks.',
  };
};

const runFakeDetectionRuleOnly = async (content, type = 'post') => {
  const rawText = collectText(content, type);
  const text = normalize(rawText);
  const flags = [];

  let score = scoreCommonSignals({ rawText, text, type, content, flags });

  if (type === 'job') {
    score += scoreJobSignals({ content, rawText, text, flags });
  } else if (type === 'story') {
    score += scoreStorySignals({ content, rawText, text, flags });
  } else {
    score += scorePostSignals({ content, text, flags });
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const decision = getDecision(score, flags);

  return {
    ...decision,
    score,
    flags: flags.map(({ flag, weight, ...meta }) => ({ flag, weight, ...meta })),
  };
};

module.exports = { runFakeDetectionRuleOnly };
