'use strict';

const env = require('../../config/env');
const mockProvider = require('./mock.provider');
const ApiError = require('../../utils/apiError');
const ids = require('../../utils/ids');
const { Payment, constants } = require('../../models');

const { TRANSACTION_STATUS } = constants;

/**
 * PaymentService — the seam between SUSU SAVE and any money-movement provider.
 *
 * Application code only ever calls `initiate`, `verify` and `disburse`. Adding
 * MTN MoMo, Telecel Cash, a card processor or a bank rail means registering a
 * new provider object with the same four methods; no savings, payout or wallet
 * code changes.
 */
const providers = new Map([[mockProvider.name, mockProvider]]);

function registerProvider(provider) {
  ['name', 'initiate', 'verify', 'disburse', 'verifySignature'].forEach((key) => {
    if (!provider?.[key]) throw new Error(`Payment provider is missing "${key}"`);
  });
  providers.set(provider.name, provider);
}

function getProvider(name = env.payment.provider) {
  const provider = providers.get(name);
  if (!provider) throw ApiError.badRequest(`Unknown payment provider: ${name}`, 'UNKNOWN_PROVIDER');
  return provider;
}

/**
 * Create a pending Payment and hand it to the provider. The returned payment is
 * NOT money yet — only a verified webhook or `verify()` can settle it.
 */
async function initiatePayment({
  userId,
  organizationId = null,
  purpose,
  amountMinor,
  method = 'mobile_money',
  payerIdentifier = null,
  metadata = {},
  providerName = env.payment.provider,
}) {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    throw ApiError.badRequest('Payment amount must be a positive integer', 'INVALID_AMOUNT');
  }

  const provider = getProvider(providerName);
  const reference = `PAY-${ids.randomCode(10)}`;

  const payment = await Payment.create({
    reference,
    userId,
    organizationId,
    purpose,
    amountMinor,
    currency: env.currency,
    method,
    provider: provider.name,
    payerIdentifier,
    metadata,
    status: TRANSACTION_STATUS.PENDING,
  });

  const result = await provider.initiate({
    reference,
    amountMinor,
    currency: env.currency,
    method,
    payerIdentifier,
    metadata,
  });

  payment.providerReference = result.providerReference;
  payment.checkoutUrl = result.checkoutUrl || null;
  payment.status = result.status === 'successful' ? TRANSACTION_STATUS.PROCESSING : TRANSACTION_STATUS.PENDING;
  await payment.save();

  return payment;
}

async function verifyPayment(payment) {
  const provider = getProvider(payment.provider);
  return provider.verify(payment.providerReference);
}

/** Send money out to a mobile money wallet or bank account. */
async function disburse({ reference, amountMinor, destination, providerName = env.payment.provider }) {
  return getProvider(providerName).disburse({ reference, amountMinor, destination });
}

const verifySignature = (rawBody, signature, providerName = env.payment.provider) =>
  getProvider(providerName).verifySignature(rawBody, signature);

const signatureHeader = (providerName = env.payment.provider) =>
  getProvider(providerName).signatureHeader || 'x-signature';

module.exports = {
  registerProvider,
  getProvider,
  initiatePayment,
  verifyPayment,
  disburse,
  verifySignature,
  signatureHeader,
};
