'use strict';

const mongoose = require('mongoose');

/**
 * A wallet is a cached projection of the ledger, not the source of truth.
 * `walletService.recompute()` can rebuild every field from Transaction rows,
 * and the reconciliation job uses that to detect drift.
 */
const walletSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null, index: true },
    currency: { type: String, default: 'GHS' },

    availableBalanceMinor: { type: Number, default: 0 },
    pendingBalanceMinor: { type: Number, default: 0 },

    // Lifetime counters, all minor units.
    totalDepositedMinor: { type: Number, default: 0 },
    totalContributedMinor: { type: Number, default: 0 },
    totalReceivedMinor: { type: Number, default: 0 },
    totalWithdrawnMinor: { type: Number, default: 0 },
    totalFeesPaidMinor: { type: Number, default: 0 },

    lastRecomputedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

walletSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('Wallet', walletSchema);
