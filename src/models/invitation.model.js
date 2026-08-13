'use strict';

const mongoose = require('mongoose');

const invitationSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    phone: { type: String, default: null },
    name: { type: String, default: null },

    scope: { type: String, enum: ['organization', 'group'], required: true },
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null, index: true },
    groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'SusuGroup', default: null, index: true },

    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    tokenHash: { type: String, required: true, index: true },

    status: {
      type: String,
      enum: ['pending', 'accepted', 'declined', 'expired', 'revoked'],
      default: 'pending',
      index: true,
    },
    expiresAt: { type: Date, required: true },
    acceptedAt: { type: Date, default: null },
    acceptedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

invitationSchema.set('toJSON', {
  virtuals: true,
  transform(_doc, ret) {
    delete ret.tokenHash;
    return ret;
  },
});

module.exports = mongoose.model('Invitation', invitationSchema);
