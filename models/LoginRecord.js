const mongoose = require('mongoose');

const loginRecordSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  photo: {
    url: { type: String, required: true },
    publicId: { type: String, required: true },
  },
  location: {
    lat: Number,
    lng: Number,
    city: String,
    state: String,
    accuracy: Number,
  },
  device: {
    userAgent: String,
    browser: String,
    ip: String,
  },
  faceDetection: {
    detected: { type: Boolean, default: false },
    count: { type: Number, default: 0 },
    detector: String,
    confidence: Number,
    validation: String,
  },
  auditTokenId: { type: String, index: true, unique: true, sparse: true },
  loginAt: { type: Date, default: Date.now },
});

loginRecordSchema.index({ user: 1, loginAt: -1 });
loginRecordSchema.index({ 'location.city': 1 });
loginRecordSchema.index({ loginAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

module.exports = mongoose.model('LoginRecord', loginRecordSchema);
