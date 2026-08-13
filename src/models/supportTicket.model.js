'use strict';

const mongoose = require('mongoose');
const { SUPPORT_STATUS, values } = require('./constants');

const messageSchema = new mongoose.Schema(
  {
    authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    body: { type: String, required: true },
    isStaff: { type: Boolean, default: false },
  },
  { timestamps: true, _id: true },
);

const supportTicketSchema = new mongoose.Schema(
  {
    reference: { type: String, required: true, unique: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null, index: true },

    subject: { type: String, required: true },
    category: {
      type: String,
      enum: ['account', 'payment', 'group', 'withdrawal', 'technical', 'other'],
      default: 'other',
    },
    priority: { type: String, enum: ['low', 'normal', 'high'], default: 'normal' },
    status: { type: String, enum: values(SUPPORT_STATUS), default: SUPPORT_STATUS.OPEN, index: true },

    messages: [messageSchema],
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

supportTicketSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('SupportTicket', supportTicketSchema);
