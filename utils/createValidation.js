const cleanString = (value) => (typeof value === 'string' ? value.trim() : '');
const MIN_STANDALONE_CONTENT_LENGTH = 20;

const sendValidationError = (res, errors) => res.status(400).json({
  message: Object.values(errors)[0] || 'Please correct the highlighted fields.',
  errors,
});

const sendCreateError = (res, error, fallbackMessage) => {
  if (error?.name === 'ValidationError') {
    const errors = Object.fromEntries(
      Object.entries(error.errors || {}).map(([field, detail]) => [field, detail.message])
    );
    return sendValidationError(res, errors);
  }

  if (error?.name === 'MongoServerError' && error.code === 11000) {
    return res.status(409).json({ message: 'This content already exists. Please refresh before trying again.' });
  }

  const uploadError = error?.http_code || error?.name === 'UploadApiError';
  return res.status(uploadError ? 502 : 500).json({
    message: uploadError
      ? 'The media upload could not be completed. Check your connection and try again.'
      : fallbackMessage,
  });
};

const isHttpUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_) {
    return false;
  }
};

const parseLocalDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? date
    : null;
};

module.exports = {
  MIN_STANDALONE_CONTENT_LENGTH,
  cleanString,
  sendValidationError,
  sendCreateError,
  isHttpUrl,
  parseLocalDate,
};
