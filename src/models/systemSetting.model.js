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

    /**
     * Visual settings the super admin controls from the console.
     *
     * These are served as CSS custom properties by GET /theme.css, which every
     * page loads after the design system. They therefore *override* the built-in
     * look rather than replacing it: anything left at its default keeps the
     * original design, and clearing a value restores it.
     */
    theme: {
      primaryColor: { type: String, default: '' },
      secondaryColor: { type: String, default: '' },
      backgroundColor: { type: String, default: '' },
      surfaceColor: { type: String, default: '' },
      textColor: { type: String, default: '' },
      mutedTextColor: { type: String, default: '' },
      buttonColor: { type: String, default: '' },
      buttonTextColor: { type: String, default: '' },
      borderColor: { type: String, default: '' },

      /** A family name from the allowlist in theme.service — never raw CSS. */
      fontFamily: { type: String, default: '' },
      headingFontFamily: { type: String, default: '' },
      baseFontSize: { type: Number, default: 0 }, // px; 0 = leave as designed
      headingWeight: { type: Number, default: 0 },
      headingLetterSpacing: { type: Number, default: 0 }, // em, may be negative
      headingTransform: { type: String, default: '' }, // none | uppercase | capitalize
      bodyLineHeight: { type: Number, default: 0 },
      cornerRadius: { type: Number, default: 0 }, // px

      logoUrl: { type: String, default: '' },
      faviconUrl: { type: String, default: '' },

      headerBackground: { type: String, default: '' },
      headerTextColor: { type: String, default: '' },
      footerBackground: { type: String, default: '' },
      footerTextColor: { type: String, default: '' },

      /** A thin strip above the header — promotions, notices, opening hours. */
      bannerEnabled: { type: Boolean, default: false },
      bannerText: { type: String, default: '' },
      bannerUrl: { type: String, default: '' },
      bannerBackground: { type: String, default: '' },
      bannerTextColor: { type: String, default: '' },

      /** Bumped on every publish so caches and open tabs pick up the change. */
      version: { type: Number, default: 0 },
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
