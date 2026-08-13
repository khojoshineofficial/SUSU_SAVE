'use strict';

const mongoose = require('mongoose');

/**
 * A single-document store for every platform-wide business rule. Nothing about
 * fees, limits or grace periods is hard-coded in the application logic — it is
 * all read from here so the Super Admin can change the product without a deploy.
 */
const systemSettingSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'platform', unique: true, index: true },

    platformName: { type: String, default: 'SUSU SAVE' },
    tagline: { type: String, default: 'Save Together, Grow Together.' },
    logoUrl: { type: String, default: null },
    currency: { type: String, default: 'GHS' },
    currencySymbol: { type: String, default: 'GH₵' },

    fees: {
      registrationFeeMinor: { type: Number, default: 2000 }, // GH₵20.00
      monthlyPlatformFeeMinor: { type: Number, default: 500 }, // GH₵5.00
      groupCreationFeeMinor: { type: Number, default: 0 },
      savingsFeePercent: { type: Number, default: 1 },
      withdrawalFeePercent: { type: Number, default: 0.5 },
      withdrawalFlatFeeMinor: { type: Number, default: 100 },
      payoutFeePercent: { type: Number, default: 0 },
      transactionFeeMinor: { type: Number, default: 0 },
    },

    limits: {
      minContributionMinor: { type: Number, default: 100 },
      maxContributionMinor: { type: Number, default: 50000000 },
      minWithdrawalMinor: { type: Number, default: 1000 },
      maxWithdrawalMinor: { type: Number, default: 10000000 },
      minSavingsTargetMinor: { type: Number, default: 1000 },
      maxGroupMembers: { type: Number, default: 100 },
      maxGroupsPerUser: { type: Number, default: 10 },
    },

    rules: {
      requireRegistrationPayment: { type: Boolean, default: true },
      requireEmailVerification: { type: Boolean, default: false },
      defaultGracePeriodDays: { type: Number, default: 1 },
      lateFeeEnabled: { type: Boolean, default: false },
      lateFeePercent: { type: Number, default: 0 },
      // Payout eligibility: a member with unpaid cycles can be skipped.
      requireCleanRecordForPayout: { type: Boolean, default: false },
      autoApproveWithdrawals: { type: Boolean, default: false },
      individualSavingsLockDays: { type: Number, default: 30 },
    },

    support: {
      email: { type: String, default: 'support@sususave.app' },
      phone: { type: String, default: '+233 000 000 000' },
    },

    maintenanceMode: { type: Boolean, default: false },
    maintenanceMessage: { type: String, default: '' },

    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

/** Always returns the settings document, creating defaults on first call. */
systemSettingSchema.statics.load = async function load() {
  const existing = await this.findOne({ key: 'platform' });
  if (existing) return existing;
  return this.create({ key: 'platform' });
};

systemSettingSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('SystemSetting', systemSettingSchema);
