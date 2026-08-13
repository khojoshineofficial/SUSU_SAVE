'use strict';

const mongoose = require('mongoose');
const { GROUP_STATUS, GROUP_FREQUENCIES, FREQUENCY, values } = require('./constants');
const ids = require('../utils/ids');

const susuGroupSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },

    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null, index: true },
    organizerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    inviteCode: { type: String, required: true, unique: true, uppercase: true, index: true },
    isPrivate: { type: Boolean, default: true },
    requiresApproval: { type: Boolean, default: true },

    // Money in minor units (pesewas).
    contributionAmountMinor: { type: Number, required: true, min: 1 },
    contributionFrequency: { type: String, enum: GROUP_FREQUENCIES, default: FREQUENCY.WEEKLY },
    memberLimit: { type: Number, required: true, min: 2, max: 200 },

    startDate: { type: Date, required: true },
    endDate: { type: Date, default: null },

    /**
     * A group runs exactly `memberLimit` cycles — one payout per member.
     * `currentCycle` is 1-based and points at the cycle currently collecting.
     */
    currentCycle: { type: Number, default: 1, min: 1 },
    totalCycles: { type: Number, required: true, min: 2 },

    payoutOrderMode: { type: String, enum: ['automatic', 'manual'], default: 'automatic' },

    status: { type: String, enum: values(GROUP_STATUS), default: GROUP_STATUS.RECRUITING, index: true },

    settings: {
      gracePeriodDays: { type: Number, default: 1, min: 0 },
      lateFeeEnabled: { type: Boolean, default: false },
      lateFeePercent: { type: Number, default: 0, min: 0 },
      // Hold a payout when the pool has not been fully collected.
      requireFullPoolBeforePayout: { type: Boolean, default: true },
      allowPartialContributions: { type: Boolean, default: true },
    },

    // Denormalised counters — recomputed by the services that own them, never
    // used as the source of truth for money.
    stats: {
      activeMembers: { type: Number, default: 0 },
      totalCollectedMinor: { type: Number, default: 0 },
      totalPaidOutMinor: { type: Number, default: 0 },
      completedPayouts: { type: Number, default: 0 },
    },

    completedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

susuGroupSchema.index({ organizationId: 1, status: 1 });

/** Money expected from the full membership in one cycle. */
susuGroupSchema.virtual('expectedPoolMinor').get(function expectedPool() {
  return this.contributionAmountMinor * (this.stats?.activeMembers || 0);
});

susuGroupSchema.set('toJSON', { virtuals: true });

susuGroupSchema.statics.generateInviteCode = async function generateInviteCode(name) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = ids.inviteCode(name);
    // eslint-disable-next-line no-await-in-loop
    const clash = await this.exists({ inviteCode: code });
    if (!clash) return code;
  }
  throw new Error('Could not generate a unique invite code');
};

module.exports = mongoose.model('SusuGroup', susuGroupSchema);
