const URL_REGEX =
  /(?:https?:\/\/|www\.|t\.me\/|telegram\.me\/|bit\.ly|tinyurl|shorturl|cutt\.ly|wa\.me|whatsapp|discord\.gg|forms\.gle|docs\.google\.com\/forms)/gi;
const EMAIL_REGEX = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PHONE_REGEX = /(?:\+?\d[\s().-]?){8,}/g;
const MONEY_REGEX =
  /(?:₹|rs\.?|inr|\$|usd)\s?\d+(?:[,.]\d+)*(?:\s?(?:k|lakh|lac|cr|crore))?|\d+(?:[,.]\d+)*(?:\s?(?:k|lakh|lac|cr|crore))?\s?(?:rs|inr|usd|dollars?|rupees?)/gi;

const CRITICAL_PHRASES = [
  'registration fee',
  'security deposit',
  'pay first',
  'payment before joining',
  'investment required',
  'refundable deposit',
  'processing fee',
  'training fee',
  'exam answers',
  'leaked paper',
  'fake marksheet',
  'fake certificate',
  'password required',
  'bank details',
  'upi pin',
  'aadhaar card',
  'pan card',
  'send otp',
  'crypto investment',
  'betting app',
];

const HIGH_RISK_PHRASES = [
  'earn money fast',
  'instant earning',
  'guaranteed income',
  'daily income',
  'guaranteed job',
  '100% placement',
  'no interview',
  'limited seats',
  'join now',
  'dm me',
  'message me on whatsapp',
  'whatsapp only',
  'telegram group',
  'click this link',
  'work from home easy money',
  'copy paste job',
  'part time income',
  'refer and earn',
  'multi level marketing',
];

const UNSAFE_TOPICS = [
  'hack',
  'fraud',
  'scam',
  'casino',
  'adult',
  'drugs',
  'weapon',
  'violence',
  'hate speech',
  'blackmail',
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
  'campus',
  'institution',
];

const JOB_REQUIRED_FIELDS = ['title', 'description', 'deadline', 'contactEmail'];
const TRUSTED_EMAIL_DOMAINS = ['.edu', '.ac.in', '.org', '.gov', '.school'];
const PERSONAL_EMAIL_DOMAINS = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'proton.me'];

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
const phraseHits = (text, phrases) => phrases.filter((phrase) => text.includes(phrase));

const uniqueTokenRatio = (text) => {
  const tokens = text.split(/\s+/).filter((token) => token.length > 2);
  if (tokens.length < 8) return 1;
  return new Set(tokens).size / tokens.length;
};

const repeatedPatternCount = (rawText) => {
  const repeatedChars = countMatches(rawText, /(.)\1{5,}/g);
  const repeatedWords = countMatches(normalize(rawText), /\b(\w+)(?:\s+\1){3,}\b/g);
  const repeatedPunctuation = countMatches(rawText, /[!?.,]{5,}/g);
  return repeatedChars + repeatedWords + repeatedPunctuation;
};

const getEmailDomain = (email = '') => String(email).split('@')[1]?.toLowerCase() || '';

const parseMoneyValues = (rawText) =>
  (String(rawText).match(MONEY_REGEX) || [])
    .map((match) => {
      const clean = match.toLowerCase().replace(/[,₹$]/g, '');
      const base = Number(clean.match(/\d+(?:\.\d+)?/)?.[0] || 0);
      if (!base) return 0;
      if (clean.includes('crore') || clean.includes(' cr')) return base * 10000000;
      if (clean.includes('lakh') || clean.includes(' lac')) return base * 100000;
      if (/\bk\b/.test(clean)) return base * 1000;
      return base;
    })
    .filter(Boolean);

const collectText = (content, type) => {
  if (!content) return '';

  const parts = [
    content.title,
    content.text,
    content.content,
    content.description,
    content.institutionName,
    content.requiredQualifications,
    content.roleType,
    content.location,
    content.contactEmail,
    ...asArray(content.skillsRequired),
    ...asArray(content.tags),
  ];

  if (type === 'story' && content.image?.url && !content.text) {
    parts.push('story image');
  }

  return parts.filter(Boolean).join(' ');
};

const addFlag = (flags, flag, weight, severity = 'medium', meta = {}) => {
  flags.push({ flag, weight, severity, ...meta });
  return weight;
};

const scoreCommonSignals = ({ rawText, text, type, content, flags }) => {
  let score = 0;
  const rawLength = String(rawText).trim().length;

  if (type !== 'story' && rawLength < 18) {
    score += addFlag(flags, 'too_little_context', 18, 'medium');
  }

  if (rawLength > 5000) {
    score += addFlag(flags, 'excessive_length', 10, 'low');
  }

  const links = countMatches(rawText, URL_REGEX);
  if (links > 0) {
    score += addFlag(flags, 'external_or_shortened_link', Math.min(links * 12, 30), links > 1 ? 'high' : 'medium', {
      count: links,
    });
  }

  const emails = countMatches(rawText, EMAIL_REGEX);
  const phones = countMatches(rawText, PHONE_REGEX);
  if (type !== 'job' && emails + phones > 0) {
    score += addFlag(flags, 'contact_details_outside_job', Math.min((emails + phones) * 11, 28), 'medium', {
      count: emails + phones,
    });
  }

  const criticalHits = phraseHits(text, CRITICAL_PHRASES);
  if (criticalHits.length > 0) {
    score += addFlag(flags, 'critical_scam_or_abuse_pattern', Math.min(38 + criticalHits.length * 10, 65), 'critical', {
      matches: criticalHits.slice(0, 6),
    });
  }

  const highRiskHits = phraseHits(text, HIGH_RISK_PHRASES);
  if (highRiskHits.length > 0) {
    score += addFlag(flags, 'spam_or_scam_language', Math.min(18 + highRiskHits.length * 8, 45), 'high', {
      matches: highRiskHits.slice(0, 6),
    });
  }

  const unsafeHits = phraseHits(text, UNSAFE_TOPICS);
  if (unsafeHits.length > 0) {
    score += addFlag(flags, 'unsafe_or_suspicious_terms', Math.min(20 + unsafeHits.length * 12, 50), 'high', {
      matches: unsafeHits.slice(0, 6),
    });
  }

  const repeatedScore = repeatedPatternCount(rawText);
  if (repeatedScore > 0) {
    score += addFlag(flags, 'repeated_spam_pattern', Math.min(repeatedScore * 10, 25), 'medium');
  }

  if (uniqueTokenRatio(text) < 0.45) {
    score += addFlag(flags, 'low_text_diversity', 14, 'medium');
  }

  const capsLetters = String(rawText).replace(/[^A-Z]/g, '').length;
  const letters = String(rawText).replace(/[^a-zA-Z]/g, '').length;
  if (letters > 20 && capsLetters / letters > 0.65) {
    score += addFlag(flags, 'excessive_caps', 10, 'low');
  }

  if (phraseHits(text, EDUCATION_TERMS).length === 0 && type !== 'story') {
    score += addFlag(flags, 'weak_academic_relevance', 10, 'low');
  }

  if (content?.images?.length > 5) {
    score += addFlag(flags, 'too_many_images', 12, 'medium', { count: content.images.length });
  }

  if (links > 0 && (phones > 0 || phraseHits(text, ['whatsapp', 'telegram', 'dm me']).length > 0)) {
    score += addFlag(flags, 'off_platform_contact_funnel', 22, 'high');
  }

  return score;
};

const scoreJobSignals = ({ content, rawText, text, flags }) => {
  let score = 0;
  const missing = JOB_REQUIRED_FIELDS.filter((field) => !content?.[field]);

  if (missing.length > 0) {
    score += addFlag(flags, 'missing_required_job_fields', missing.length * 14, 'high', { fields: missing });
  }

  if (countMatches(content?.contactEmail || '', EMAIL_REGEX) === 0) {
    score += addFlag(flags, 'invalid_contact_email', 18, 'high');
  } else {
    const domain = getEmailDomain(content.contactEmail);
    if (PERSONAL_EMAIL_DOMAINS.includes(domain)) {
      score += addFlag(flags, 'personal_contact_email_for_job', 8, 'low', { domain });
    }
    if (TRUSTED_EMAIL_DOMAINS.some((trusted) => domain.endsWith(trusted))) {
      score -= 5;
    }
  }

  const paymentHits = phraseHits(text, [
    'registration fee',
    'security deposit',
    'pay first',
    'investment required',
    'processing fee',
    'training fee',
    'refundable deposit',
  ]);
  if (paymentHits.length > 0) {
    score += addFlag(flags, 'job_requests_upfront_payment', 55, 'critical', { matches: paymentHits });
  }

  const moneyValues = parseMoneyValues(rawText);
  const stipend = Number(content?.stipend || 0);
  const maxMoney = Math.max(stipend, ...moneyValues, 0);
  if (moneyValues.length >= 4 || stipend > 500000 || maxMoney > 1000000) {
    score += addFlag(flags, 'unusual_compensation_claim', maxMoney > 1000000 ? 30 : 16, 'high', {
      maxValue: maxMoney,
    });
  }

  const skillCount = asArray(content?.skillsRequired).length;
  if (skillCount === 0) {
    score += addFlag(flags, 'job_missing_skills', 10, 'medium');
  }

  if (String(content?.description || '').trim().length < 60) {
    score += addFlag(flags, 'job_description_too_short', 16, 'medium');
  }

  if (String(content?.requiredQualifications || '').trim().length < 10) {
    score += addFlag(flags, 'job_missing_qualifications', 10, 'medium');
  }

  if (content?.deadline && new Date(content.deadline).getTime() < Date.now() - 24 * 60 * 60 * 1000) {
    score += addFlag(flags, 'expired_deadline', 20, 'high');
  }

  const easyMoneyCombo =
    phraseHits(text, ['remote', 'work from home']).length > 0 &&
    phraseHits(text, ['no experience required', 'guaranteed income', 'daily income', 'copy paste job']).length > 0;
  if (easyMoneyCombo) {
    score += addFlag(flags, 'too_good_to_be_true_remote_job', 26, 'high');
  }

  return score;
};

const scorePostSignals = ({ content, rawText, text, flags }) => {
  let score = 0;

  if (content?.type === 'achievement') {
    const proofTerms = ['won', 'completed', 'certified', 'selected', 'published', 'rank', 'award', 'project'];
    if (phraseHits(text, proofTerms).length === 0 && !content?.images?.length) {
      score += addFlag(flags, 'achievement_lacks_context', 12, 'medium');
    }
  }

  if (content?.type === 'job' && !content?.jobPost) {
    const jobTerms = ['role', 'apply', 'salary', 'stipend', 'hiring', 'opening', 'vacancy'];
    if (phraseHits(text, jobTerms).length >= 2) {
      score += addFlag(flags, 'job_like_post_needs_review', 12, 'medium');
    }
  }

  if (countMatches(rawText, URL_REGEX) > 0 && phraseHits(text, ['payment', 'whatsapp', 'telegram', 'apply now']).length > 0) {
    score += addFlag(flags, 'post_external_application_funnel', 20, 'high');
  }

  return score;
};

const scoreStorySignals = ({ content, rawText, text, flags }) => {
  let score = 0;
  const links = countMatches(rawText, URL_REGEX);
  const contacts = countMatches(rawText, EMAIL_REGEX) + countMatches(rawText, PHONE_REGEX);

  if (!content?.image?.url && text.length < 6) {
    score += addFlag(flags, 'empty_or_low_context_story', 18, 'medium');
  }

  if (links > 0) {
    score += addFlag(flags, 'story_contains_link', links > 1 ? 28 : 20, 'high', { count: links });
  }

  if (contacts > 0) {
    score += addFlag(flags, 'story_contains_contact_details', Math.min(contacts * 14, 28), 'high', { count: contacts });
  }

  if (links > 0 && phraseHits(text, ['earn', 'apply', 'join', 'fee', 'deposit', 'whatsapp', 'telegram']).length > 0) {
    score += addFlag(flags, 'story_link_promotes_external_action', 28, 'critical');
  }

  return score;
};

const getDecision = (score, flags) => {
  const hasCritical = flags.some((item) => item.severity === 'critical');
  const highRiskCount = flags.filter((item) => item.severity === 'high').length;
  const riskyStoryLink =
    flags.some((item) => item.flag === 'story_contains_link') &&
    flags.some((item) => item.flag === 'spam_or_scam_language');

  if (hasCritical || riskyStoryLink || score >= 62 || (score >= 52 && highRiskCount >= 2)) {
    return {
      approved: false,
      decision: 'reject',
      severity: hasCritical ? 'critical' : 'high',
      reason: hasCritical
        ? 'Rejected by rule-based checks for critical scam, unsafe, or privacy-risk signals.'
        : 'Rejected by rule-based checks due to multiple high-risk signals.',
    };
  }

  if (score >= 34 || highRiskCount > 0) {
    return {
      approved: true,
      decision: 'review',
      severity: 'medium',
      reason: 'Needs admin attention: rule-based checks found caution signals, but not enough for auto rejection.',
    };
  }

  return {
    approved: true,
    decision: 'approve',
    severity: 'low',
    reason: 'Approved by rule-based safety checks.',
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
    score += scorePostSignals({ content, rawText, text, flags });
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const decision = getDecision(score, flags);

  return {
    ...decision,
    score,
    flags: flags
      .sort((a, b) => b.weight - a.weight)
      .map(({ flag, weight, severity, ...meta }) => ({ flag, weight, severity, ...meta })),
  };
};

module.exports = { runFakeDetectionRuleOnly };
