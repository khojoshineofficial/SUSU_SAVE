'use strict';

const mongoose = require('mongoose');
const { CONTRIBUTION_STATUS, values } = require('./constants');

/**
 * One row per member per cycle. Rows are created up-front by the schedule
 * builder so "missed" is a real, queryable state rather than an absence of data.
 */
const contributionSchema = new mongoose.Schema(
  {
    groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'SusuGroup', required: true, index: true },
    groupMemberId: { type: mongoose.Schema.Types.ObjectId, ref: 'GroupMember', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null, index: true },

    cycle: { type: Number, required: true, min: 1 },
    dueDate: { type: Date, required: true, index: true },

    expectedAmountMinor: { type: Number, required: true, min: 0 },
    /** Gross amount the member has paid towards this cycle — their obligation. */
    paidAmountMinor: { type: Number, default: 0, min: 0 },
    /**
     * Platform fee withheld from what was paid. The money available to the
     * cycle pool is `paidAmountMinor - platformFeeMinor`, so a member who pays
     * in full has met their obligation even though the pool receives less.
     */
    platformFeeMinor: { type: Number, default: 0, min: 0 },
    lateFeeMinor: { type: Number, default: 0, min: 0 },

    status: { type: String, enum: values(CONTRIBUTION_STATUS), default: CONTRIBUTION_STATUS.PENDING, index: true },

    paidAt: { type: Date, default: null },
    daysLate: { type: Number, default: 0 },
    transactionIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Transaction' }],
  },
  { timestamps: true },
);

contributionSchema.index({ groupId: 1, userId: 1, cycle: 1 }, { unique: true });
contributionSchema.index({ groupId: 1, cycle: 1, status: 1 });

contributionSchema.virtual('outstandingMinor').get(function outstanding() {
  return Math.max(0, this.expectedAmountMinor - this.paidAmountMinor);
});

/** What this row actually contributes to the cycle pool. */
contributionSchema.virtual('poolValueMinor').get(function poolValue() {
  return Math.max(0, this.paidAmountMinor - this.platformFeeMinor);
});

contributionSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('Contribution', contributionSchema);
