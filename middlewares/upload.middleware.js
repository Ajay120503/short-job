const multer = require('multer');
const cloudinary = require('../config/cloudinary');
const streamifier = require('streamifier');

// Use memory storage for multer (buffer in memory)
const storage = multer.memoryStorage();
const ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

// File filter for images
const imageFilter = (req, file, cb) => {
  if (ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
    cb(null, true);
  } else {
    const error = new Error('Unsupported image type. Upload a JPG, PNG, GIF, or WebP image.');
    error.code = 'INVALID_IMAGE_TYPE';
    error.field = file.fieldname;
    cb(error, false);
  }
};

// File filter for PDFs
const pdfFilter = (req, file, cb) => {
  if (file.mimetype === 'application/pdf') {
    cb(null, true);
  } else {
    cb(new Error('Please upload only PDF files.'), false);
  }
};

// File filter for images and PDFs (chat files)
const chatFileFilter = (req, file, cb) => {
  const allowedTypes = [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
    'text/csv',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/zip',
  ];

  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('File type not allowed.'), false);
  }
};

// File filter for profile uploads (images + PDF for resume)
const profileFileFilter = (req, file, cb) => {
  const allowedTypes = [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'application/pdf',
  ];

  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Please upload only images or PDF files.'), false);
  }
};

// Multer instances
const uploadImage = multer({
  storage,
  fileFilter: imageFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

const uploadPDF = multer({
  storage,
  fileFilter: pdfFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

const uploadChatFile = multer({
  storage,
  fileFilter: chatFileFilter,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
});

const uploadPostImages = multer({
  storage,
  fileFilter: imageFilter,
  limits: { fileSize: 5 * 1024 * 1024, files: 4 },
});

const uploadCreationImage = multer({
  storage,
  fileFilter: imageFilter,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

// Cloudinary upload helper
const uploadToCloudinary = async (file, folder, options = {}) => {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: 'auto',
        quality: 'auto',
        fetch_format: 'auto',
        ...options,
      },
      (err, result) => {
        if (err) reject(err);
        else resolve(result);
      }
    );
    streamifier.createReadStream(file.buffer).pipe(stream);
  });
};

// Delete from Cloudinary helper
const getPublicIdFromCloudinaryUrl = (url) => {
  if (!url || typeof url !== 'string' || !url.includes('/upload/')) return '';
  const [, afterUpload] = url.split('/upload/');
  if (!afterUpload) return '';
  const withoutTransform = afterUpload.replace(/^.*?\/v\d+\//, '');
  const withoutVersion = withoutTransform.replace(/^v\d+\//, '');
  const withoutExtension = withoutVersion.replace(/\.[^/.]+$/, '');
  return decodeURIComponent(withoutExtension);
};

const deleteFromCloudinary = async (publicIdOrUrl) => {
  const publicId = publicIdOrUrl?.includes?.('/upload/')
    ? getPublicIdFromCloudinaryUrl(publicIdOrUrl)
    : publicIdOrUrl;
  if (!publicId) return;

  try {
    const resourceTypes = ['image', 'raw', 'video'];
    for (const resource_type of resourceTypes) {
      const result = await cloudinary.uploader.destroy(publicId, { resource_type });
      if (result?.result === 'ok' || result?.result === 'not found') {
        if (result.result === 'ok') return;
      }
    }
  } catch (error) {
    console.error('Cloudinary delete error:', error);
  }
};

// Multer instance for profile updates (images + PDF for resume)
const uploadProfile = multer({
  storage,
  fileFilter: profileFileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

module.exports = {
  uploadImage,
  uploadPDF,
  uploadChatFile,
  uploadPostImages,
  uploadCreationImage,
  uploadProfile,
  uploadToCloudinary,
  deleteFromCloudinary,
  getPublicIdFromCloudinaryUrl,
};
