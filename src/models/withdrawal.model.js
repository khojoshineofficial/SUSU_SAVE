'use strict';

const mongoose = require('mongoose');
const { WITHDRAWAL_STATUS, MOMO_PROVIDERS, values } = require('./constants');

const withdrawalSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null, index: true },
    savingsPlanId: { type: mongoose.Schema.Types.ObjectId, ref: 'SavingsPlan', default: null },

    reference: { type: String, required: true, unique: true, index: true },

    amountMinor: { type: Number, required: true, min: 1 },
    feeMinor: { type: Number, default: 0, min: 0 },
    netAmountMinor: { type: Number, required: true, min: 0 },

    destination: {
      method: { type: String, enum: ['mobile_money', 'bank'], default: 'mobile_money' },
      provider: { type: String, enum: [...MOMO_PROVIDERS, 'bank'], default: 'mtn' },
      accountNumber: { type: String, required: true },
      accountName: { type: String, default: null },
    },

    reason: { type: String, default: '' },
    status: { type: String, enum: values(WITHDRAWAL_STATUS), default: WITHDRAWAL_STATUS.PENDING, index: true },

    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', default: null },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    reviewNote: { type: String, default: null },
    completedAt: { type: Date, default: null },
    failureReason: { type: String, default: null },
  },
  { timestamps: true },
);

withdrawalSchema.index({ userId: 1, createdAt: -1 });

withdrawalSchema.set('toJSON', {
  virtuals: true,
  transform(_doc, ret) {
    // Never echo a full mobile money number back to a list view.
    if (ret.destination?.accountNumber) {
      ret.destination.accountNumberMasked = ret.destination.accountNumber.replace(/.(?=.{3})/g, '*');
    }
    return ret;
  },
});

module.exports = mongoose.model('Withdrawal', withdrawalSchema);
