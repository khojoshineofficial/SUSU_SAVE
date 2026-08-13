'use strict';

const { Payment } = require('../models');
const paymentService = require('../services/payment');
const settlement = require('../services/settlement.service');
const ApiError = require('../utils/apiError');
const logger = require('../utils/logger');
const { asyncHandler, ok } = require('../utils/http');

/**
 * Provider webhook. Three rules govern this endpoint:
 *   1. The signature is verified against the *raw* body before anything else.
 *   2. The provider's claim is re-verified server-to-server.
 *   3. Settlement is idempotent, so a replayed delivery creates no new money.
 * It always answers 200 once accepted, so a provider does not retry forever on
 * an event we have deliberately ignored.
 */
const webhook = asyncHandler(async (req, res) => {
  const provider = req.params.provider || undefined;
  const signature = req.get(paymentService.signatureHeader(provider));
  const rawBody = req.rawBody || JSON.stringify(req.body || {});

  if (!paymentService.verifySignature(rawBody, signature, provider)) {
    logger.warn('Rejected webhook with an invalid signature');
    throw ApiError.unauthorized('Invalid webhook signature', 'INVALID_SIGNATURE');
  }

  const { reference, providerReference, event } = req.body || {};
  const payment = await Payment.findOne(
    reference ? { reference } : { providerReference },
  );
  if (!payment) {
    logger.warn(`Webhook for unknown payment: ${reference || providerReference}`);
    return ok(res, { applied: false }, 'Unknown payment reference — ignored');
  }

  // Never trust the payload's status: ask the provider directly.
  const verification = await paymentService.verifyPayment(payment);
  const result = await settlement.settlePayment(payment, { verifiedStatus: verification.status });

  return ok(res, {
    applied: result.applied,
    reason: result.reason || null,
    event: event || null,
  }, result.applied ? 'Payment applied' : 'No action taken');
});

const getPayment = asyncHandler(async (req, res) => {
  const payment = await Payment.findOne({ reference: req.params.reference, userId: req.user._id }).lean();
  if (!payment) throw ApiError.notFound('Payment not found', 'PAYMENT_NOT_FOUND');
  return ok(res, { payment });
});

module.exports = { webhook, getPayment };
