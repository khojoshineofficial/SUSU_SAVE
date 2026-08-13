'use strict';

const mongoose = require('mongoose');
const { GROUP_MEMBER_STATUS, GROUP_ROLE, values } = require('./constants');

const groupMemberSchema = new mongoose.Schema(
  {
    groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'SusuGroup', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null, index: true },

    role: { type: String, enum: values(GROUP_ROLE), default: GROUP_ROLE.MEMBER },
    status: { type: String, enum: values(GROUP_MEMBER_STATUS), default: GROUP_MEMBER_STATUS.PENDING, index: true },

    /** 1-based position in the payout rotation. Null until the member is approved. */
    payoutPosition: { type: Number, default: null },
    hasReceivedPayout: { type: Boolean, default: false },
    payoutReceivedAt: { type: Date, default: null },

    // Ledger-derived running totals, updated only by the contribution/payout services.
    totalContributedMinor: { type: Number, default: 0 },
    totalReceivedMinor: { type: Number, default: 0 },
    outstandingMinor: { type: Number, default: 0 },
    missedContributions: { type: Number, default: 0 },

    joinedAt: { type: Date, default: Date.now },
    approvedAt: { type: Date, default: null },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    exitedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// One membership row per user per group.
groupMemberSchema.index({ groupId: 1, userId: 1 }, { unique: true });
// Payout positions must be unique among the members that actually hold one.
groupMemberSchema.index(
  { groupId: 1, payoutPosition: 1 },
  { unique: true, partialFilterExpression: { payoutPosition: { $type: 'number' } } },
);

groupMemberSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('GroupMember', groupMemberSchema);
