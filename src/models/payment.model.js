'use strict';

const mongoose = require('mongoose');
const { TRANSACTION_STATUS, PAYMENT_METHOD, values } = require('./constants');

/**
 * A payment is an attempt to move money through an external provider. It is
 * deliberately separate from Transaction: a payment can be retried, expire or
 * fail, while a Transaction only exists once money has actually moved.
 */
const paymentSchema = new mongoose.Schema(
  {
    reference: { type: String, required: true, unique: true, index: true },
    providerReference: { type: String, default: null, index: true },

    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null, index: true },

    purpose: {
      type: String,
      enum: ['registration_fee', 'wallet_topup', 'contribution', 'subscription', 'group_creation_fee'],
      required: true,
    },
    amountMinor: { type: Number, required: true, min: 1 },
    currency: { type: String, default: 'GHS' },

    method: { type: String, enum: values(PAYMENT_METHOD), default: PAYMENT_METHOD.MOBILE_MONEY },
    provider: { type: String, default: 'mock' },
    // Only non-sensitive identifiers — never card numbers, CVVs or PINs.
    payerIdentifier: { type: String, default: null },

    status: { type: String, enum: values(TRANSACTION_STATUS), default: TRANSACTION_STATUS.PENDING, index: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },

    /** Set once a webhook for this payment has been applied, so replays no-op. */
    settledAt: { type: Date, default: null },
    failureReason: { type: String, default: null },
    checkoutUrl: { type: String, default: null },
  },
  { timestamps: true },
);

paymentSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('Payment', paymentSchema);
