const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const dotenv = require('dotenv');

dotenv.config();

// Import configs
const connectDB = require('./config/db');
const { initSocket } = require('./config/socket');
const Post = require('./models/Post');
const JobPost = require('./models/JobPost');
const Story = require('./models/Story');
const { runFakeDetectionRuleOnly } = require('./utils/fakeDetectionRuleOnly');

// Import routes
const authRoutes = require('./routes/auth.routes');
const userRoutes = require('./routes/user.routes');
const postRoutes = require('./routes/post.routes');
const commentRoutes = require('./routes/comment.routes');
const jobRoutes = require('./routes/job.routes');
const chatRoutes = require('./routes/chat.routes');
const notificationRoutes = require('./routes/notification.routes');
const storyRoutes = require('./routes/story.routes');
const adminRoutes = require('./routes/admin.routes'); // Add admin routes

// Initialize express
const app = express();

// Trust proxy - required for express-rate-limit behind Render's reverse proxy
app.set('trust proxy', 1);

const server = http.createServer(app);

// Initialize Socket.io
const io = initSocket(server);

const autoModerationModels = [
  { type: 'post', Model: Post, populate: 'author' },
  { type: 'job', Model: JobPost, populate: 'postedBy' },
  { type: 'story', Model: Story, populate: 'author' },
];

const syncAutoModerationLinks = async (type, item) => {
  if (type === 'job') {
    await Post.updateMany(
      { jobPost: item._id },
      { status: item.status, moderationMeta: item.moderationMeta }
    );
  }

  if (type === 'post' && item.jobPost) {
    await JobPost.findByIdAndUpdate(item.jobPost, {
      status: item.status,
      moderationMeta: item.moderationMeta,
    });
  }
};

const runAutoModerationPass = async () => {
  const now = new Date();

  for (const config of autoModerationModels) {
    const query = {
      status: 'pending_review',
      'moderationMeta.adminWindowExpiredAt': { $lte: now },
    };
    if (config.type === 'post') {
      query.type = { $ne: 'job' };
    }

    const items = await config.Model.find(query)
      .populate(config.populate)
      .limit(25);

    for (const item of items) {
      try {
        const result = await runFakeDetectionRuleOnly(item, config.type);
        item.status = result.approved ? 'approved' : 'rejected';
        item.moderationMeta = {
          ...(item.moderationMeta?.toObject?.() || item.moderationMeta || {}),
          reviewedAt: new Date(),
          reviewMethod: result.approved ? 'auto_approved' : 'auto_rejected',
          reviewNotes: result.reason,
          autoScore: result.score,
          autoFlags: result.flags,
        };
        await item.save();
        await syncAutoModerationLinks(config.type, item);
      } catch (error) {
        console.error(`Auto moderation failed for ${config.type} ${item._id}:`, error.message);
      }
    }
  }
};

// Security middleware
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: false,
  })
);

// CORS - allow both localhost dev and Vercel production
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:5000',
  'https://edu-connect-3.vercel.app',
  'https://edu-connect-fwoo.onrender.com',
];

app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (mobile apps, curl, Postman)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`Origin ${origin} not allowed by CORS`));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Too many auth attempts, please try again later.',
});

// Apply rate limiting
app.use('/api/', limiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// Body parsing middlewares
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'EduConnect API is running',
    timestamp: new Date().toISOString(),
  });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/posts', postRoutes);
app.use('/api', commentRoutes);
app.use('/api/jobs', jobRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/stories', storyRoutes);
app.use('/api/admin', adminRoutes); // Add admin routes

// 404 handler
app.use((req, res) => {
  res.status(404).json({ message: 'Route not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Error:', err.message);

  // Multer errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ message: 'File too large. Max size is 10MB.' });
  }

  if (err.message && err.message.startsWith('Not an image')) {
    return res.status(400).json({ message: err.message });
  }

  if (err.message && err.message.startsWith('Please upload only PDF')) {
    return res.status(400).json({ message: err.message });
  }

  if (err.message && err.message.startsWith('File type not allowed')) {
    return res.status(400).json({ message: err.message });
  }

  // Mongoose validation errors
  if (err.name === 'ValidationError') {
    const messages = Object.values(err.errors).map((e) => e.message);
    return res.status(400).json({ message: messages.join('. ') });
  }

  // Mongoose duplicate key
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue)[0];
    return res.status(400).json({ message: `${field} already exists.` });
  }

  // Mongoose cast error (invalid ObjectId)
  if (err.name === 'CastError') {
    return res.status(400).json({ message: 'Invalid ID format.' });
  }

  // Default server error
  res.status(err.statusCode || 500).json({
    message: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
});

// Start server
const PORT = process.env.PORT || 5000;

const startServer = async () => {
  try {
    // Connect to database
    await connectDB();
    console.log('Database connected successfully');

    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT} in ${process.env.NODE_ENV || 'development'} mode`);
      console.log(`API URL: http://localhost:${PORT}/api`);
      console.log(`Client URL: ${process.env.CLIENT_URL || 'http://localhost:5173'}`);
    });

    runAutoModerationPass().catch((error) => {
      console.error('Initial auto moderation pass failed:', error.message);
    });

    setInterval(() => {
      runAutoModerationPass().catch((error) => {
        console.error('Auto moderation pass failed:', error.message);
      });
    }, 30 * 1000);
  } catch (error) {
    console.error('Failed to start server:', error.message);
    process.exit(1);
  }
};

startServer();

module.exports = { app, server, io };
