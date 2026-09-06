const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema(
  {
    conversation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Conversation',
      required: true,
    },
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    content: {
      type: String,
      maxlength: [4000, 'Message cannot exceed 4000 characters'],
      default: '',
    },
    type: {
      type: String,
      enum: ['text', 'image', 'file', 'sticker', 'deleted'],
      default: 'text',
    },
    fileUrl: {
      type: String,
      default: '',
    },
    filePublicId: {
      type: String,
      default: '',
    },
    fileName: {
      type: String,
      maxlength: [255, 'File name cannot exceed 255 characters'],
      default: '',
    },
    fileMimeType: { type: String, default: '' },
    replyTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Message',
      default: null,
    },
    deliveredTo: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    }],
    readBy: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    reactions: [{
      emoji: { type: String, maxlength: [16, 'Invalid reaction'] },
      reactedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    }],
    editedAt: { type: Date },
    deletedAt: { type: Date },
  },
  {
    timestamps: true,
  }
);

messageSchema.index({ conversation: 1, createdAt: -1 });

module.exports = mongoose.model('Message', messageSchema);
