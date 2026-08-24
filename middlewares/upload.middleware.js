const multer = require('multer');
const cloudinary = require('../config/cloudinary');
const streamifier = require('streamifier');

// Use memory storage for multer (buffer in memory)
const storage = multer.memoryStorage();

// File filter for images
const imageFilter = (req, file, cb) => {
  if (file.mimetype.startsWith('image')) {
    cb(null, true);
  } else {
    cb(new Error('Not an image! Please upload only images.'), false);
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
  limits: { fileSize: 10 * 1024 * 1024, files: 5 }, // 10MB, max 5 files
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
const deleteFromCloudinary = async (publicId) => {
  try {
    await cloudinary.uploader.destroy(publicId);
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
  uploadProfile,
  uploadToCloudinary,
  deleteFromCloudinary,
};
