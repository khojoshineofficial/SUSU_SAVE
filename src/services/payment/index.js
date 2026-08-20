'use strict';

const env = require('../../config/env');
const mockProvider = require('./mock.provider');
const paystackProvider = require('./paystack.provider');
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
const providers = new Map([
  [mockProvider.name, mockProvider],
  [paystackProvider.name, paystackProvider],
]);

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
  payerEmail = null,
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
    payerEmail,
    metadata,
  });

  payment.providerReference = result.providerReference;
  payment.checkoutUrl = result.checkoutUrl || null;
  payment.status = result.status === 'successful' ? TRANSACTION_STATUS.PROCESSING : TRANSACTION_STATUS.PENDING;
  await payment.save();

  return payment;
}

/**
 * Ask the provider what actually happened. The payment is passed through so a
 * provider can check that the amount and currency which cleared match what was
 * asked for — a verification that only says "successful" is not enough.
 */
async function verifyPayment(payment) {
  const provider = getProvider(payment.provider);
  return provider.verify(payment.providerReference, payment);
}

/** Send money out to a mobile money wallet or bank account. */
async function disburse({ reference, amountMinor, destination, providerName = env.payment.provider }) {
  return getProvider(providerName).disburse({ reference, amountMinor, destination });
}

const verifySignature = (rawBody, signature, providerName = env.payment.provider) =>
  getProvider(providerName).verifySignature(rawBody, signature);

const signatureHeader = (providerName = env.payment.provider) =>
  getProvider(providerName).signatureHeader || 'x-signature';

/**
 * A one-line health report for the configured provider, logged at boot.
 *
 * A payment gateway that is misconfigured fails at the worst moment — when
 * somebody is trying to pay — and the error surfaces to them, not to the
 * operator. This puts the problem in the startup log instead.
 */
function describeConfiguration() {
  const name = env.payment.provider;
  const known = providers.has(name);

  if (!known) {
    return {
      ok: false,
      message: `PAYMENT_PROVIDER is "${name}", which is not a registered provider. `
        + `Available: ${[...providers.keys()].join(', ')}. Every payment will fail until this is fixed.`,
    };
  }
  if (name === 'mock') {
    return {
      ok: true,
      warn: true,
      message: 'Payments are using the mock provider — no real money moves. Set PAYMENT_PROVIDER for live payments.',
    };
  }
  if (name === 'paystack') {
    const key = process.env.PAYSTACK_SECRET_KEY || env.payment.secret || '';
    if (!key) {
      return { ok: false, message: 'Paystack is selected but PAYMENT_PROVIDER_SECRET is empty. Payments will fail.' };
    }
    if (!/^sk_/.test(key)) {
      return { ok: false, message: 'PAYMENT_PROVIDER_SECRET is not a Paystack secret key (it must start with sk_). Payments will fail.' };
    }
    return {
      ok: true,
      warn: key.startsWith('sk_test_'),
      message: key.startsWith('sk_test_')
        ? 'Paystack is in TEST mode — payments will not take real money.'
        : 'Paystack is configured in live mode.',
    };
  }
  return { ok: true, message: `Payments are using the ${name} provider.` };
}

module.exports = {
  registerProvider,
  getProvider,
  describeConfiguration,
  initiatePayment,
  verifyPayment,
  disburse,
  verifySignature,
  signatureHeader,
};
