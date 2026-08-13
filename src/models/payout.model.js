'use strict';

const mongoose = require('mongoose');
const { PAYOUT_STATUS, values } = require('./constants');

const payoutSchema = new mongoose.Schema(
  {
    groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'SusuGroup', required: true, index: true },
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null, index: true },
    recipientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    groupMemberId: { type: mongoose.Schema.Types.ObjectId, ref: 'GroupMember', required: true },

    cycle: { type: Number, required: true, min: 1 },
    scheduledDate: { type: Date, required: true, index: true },

    /** What the full membership owes this cycle. */
    expectedAmountMinor: { type: Number, required: true, min: 0 },
    /** What was actually collected when the payout ran. */
    collectedAmountMinor: { type: Number, default: 0, min: 0 },
    feeMinor: { type: Number, default: 0, min: 0 },
    /** collectedAmount - fee. Set by the payout engine, never by a client. */
    netAmountMinor: { type: Number, default: 0 },

    status: { type: String, enum: values(PAYOUT_STATUS), default: PAYOUT_STATUS.SCHEDULED, index: true },
    holdReason: { type: String, default: null },
    failureReason: { type: String, default: null },
    attempts: { type: Number, default: 0 },

    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', default: null },
    processedAt: { type: Date, default: null },
    processedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

payoutSchema.index({ groupId: 1, cycle: 1 }, { unique: true });
payoutSchema.index({ recipientId: 1, scheduledDate: 1 });

payoutSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('Payout', payoutSchema);
