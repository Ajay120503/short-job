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
  loginAt: { type: Date, default: Date.now, index: true },
});

loginRecordSchema.index({ user: 1, loginAt: -1 });
loginRecordSchema.index({ 'location.city': 1 });

module.exports = mongoose.model('LoginRecord', loginRecordSchema);
