'use strict';

const mongoose = require('mongoose');

/**
 * The identifier behind a QR code.
 *
 * The QR image encodes nothing but a URL ending in this random `code`. No name,
 * no phone number, no member id, no amount — a printed code that ends up on the
 * wrong table reveals nothing about whose it is, and scanning it proves
 * nothing: the scan lands on a page that still requires the member to be signed
 * in as themselves before any money moves.
 *
 * A row with `userId: null` is the group's shared code; one with a `userId` is
 * that member's own.
 */
const paymentCodeSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, index: true },

    groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'SusuGroup', required: true, index: true },
    /** Null for the group-wide code. */
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null, index: true },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    /** Revoking is preferred to deleting: the scan log stays meaningful. */
    revokedAt: { type: Date, default: null },
    revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    scanCount: { type: Number, default: 0 },
    lastScannedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

/**
 * One live code per target. The partial filter lets a revoked code keep its row
 * while a fresh one is issued for the same member.
 */
paymentCodeSchema.index(
  { groupId: 1, userId: 1 },
  { unique: true, partialFilterExpression: { revokedAt: null } },
);

paymentCodeSchema.virtual('active').get(function active() {
  return this.revokedAt === null;
});

paymentCodeSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('PaymentCode', paymentCodeSchema);
