'use strict';

const mongoose = require('mongoose');
const { SAVINGS_TYPE, SAVINGS_STATUS, SAVINGS_FREQUENCIES, FREQUENCY, values } = require('./constants');

const savingsPlanSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null, index: true },

    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    type: { type: String, enum: values(SAVINGS_TYPE), default: SAVINGS_TYPE.PERSONAL, index: true },

    targetAmountMinor: { type: Number, default: 0, min: 0 },
    currentAmountMinor: { type: Number, default: 0, min: 0 },
    contributionAmountMinor: { type: Number, default: 0, min: 0 },
    frequency: { type: String, enum: SAVINGS_FREQUENCIES, default: FREQUENCY.MONTHLY },

    startDate: { type: Date, default: Date.now },
    targetDate: { type: Date, default: null },
    nextContributionDate: { type: Date, default: null },

    /**
     * Individual savings mature monthly by default: money is locked until
     * `maturityDate`, after which a withdrawal request is permitted.
     */
    withdrawalRules: {
      lockUntilTarget: { type: Boolean, default: false },
      minimumLockDays: { type: Number, default: 30 },
      allowEarlyWithdrawal: { type: Boolean, default: true },
      earlyWithdrawalPenaltyPercent: { type: Number, default: 0 },
    },

    // Rent-specific fields; ignored for other types.
    rentDetails: {
      monthlyRentMinor: { type: Number, default: null },
      landlordName: { type: String, default: null },
      propertyLabel: { type: String, default: null },
    },

    status: { type: String, enum: values(SAVINGS_STATUS), default: SAVINGS_STATUS.ACTIVE, index: true },
    lastContributionAt: { type: Date, default: null },
    maturedAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

savingsPlanSchema.index({ userId: 1, status: 1 });

savingsPlanSchema.virtual('progressPercent').get(function progress() {
  if (!this.targetAmountMinor) return 0;
  return Math.min(100, Math.round((this.currentAmountMinor / this.targetAmountMinor) * 1000) / 10);
});

savingsPlanSchema.virtual('remainingMinor').get(function remaining() {
  return Math.max(0, (this.targetAmountMinor || 0) - this.currentAmountMinor);
});

savingsPlanSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('SavingsPlan', savingsPlanSchema);
