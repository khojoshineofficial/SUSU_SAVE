'use strict';

const mongoose = require('mongoose');
const {
  TRANSACTION_TYPE,
  TRANSACTION_STATUS,
  PAYMENT_METHOD,
  CREDIT_TYPES,
  values,
} = require('./constants');

/**
 * The ledger. Rows are append-only: a transaction's amount, type and direction
 * are never edited after creation — corrections are made by writing a new
 * `adjustment` or `refund` row. Only `status` and completion metadata move.
 */
const transactionSchema = new mongoose.Schema(
  {
    transactionId: { type: String, required: true, unique: true, index: true },

    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null, index: true },
    groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'SusuGroup', default: null, index: true },
    savingsPlanId: { type: mongoose.Schema.Types.ObjectId, ref: 'SavingsPlan', default: null, index: true },

    type: { type: String, enum: values(TRANSACTION_TYPE), required: true, index: true },
    direction: { type: String, enum: ['credit', 'debit'], required: true },

    // All amounts are integer minor units. grossAmountMinor = netAmountMinor + feeMinor
    grossAmountMinor: { type: Number, required: true, min: 0 },
    feeMinor: { type: Number, default: 0, min: 0 },
    netAmountMinor: { type: Number, required: true },
    currency: { type: String, default: 'GHS' },

    status: { type: String, enum: values(TRANSACTION_STATUS), default: TRANSACTION_STATUS.PENDING, index: true },
    paymentMethod: { type: String, enum: values(PAYMENT_METHOD), default: PAYMENT_METHOD.WALLET },
    provider: { type: String, default: null },
    providerReference: { type: String, default: null, index: true },

    description: { type: String, default: '' },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },

    /**
     * Idempotency guard. Any caller that could be retried (webhooks, cron jobs,
     * double-submitted forms) supplies a deterministic key; the unique index
     * makes a duplicate insert fail instead of creating money twice.
     */
    idempotencyKey: { type: String, default: null },

    completedAt: { type: Date, default: null },
    failureReason: { type: String, default: null },
  },
  { timestamps: true },
);

transactionSchema.index(
  { idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);
transactionSchema.index({ userId: 1, createdAt: -1 });
transactionSchema.index({ organizationId: 1, createdAt: -1 });

transactionSchema.statics.directionFor = (type) =>
  (CREDIT_TYPES.includes(type) ? 'credit' : 'debit');

transactionSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('Transaction', transactionSchema);
