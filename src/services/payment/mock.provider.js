'use strict';

const crypto = require('crypto');
const ids = require('../../utils/ids');
const env = require('../../config/env');

/**
 * Development provider. It behaves like a real gateway — it returns a checkout
 * handle and settles out-of-band via the webhook endpoint — so no application
 * code has to special-case "we are in dev". Nothing here touches the ledger.
 */
const mockProvider = {
  name: 'mock',

  async initiate({ reference, amountMinor, currency, method, payerIdentifier, metadata }) {
    return {
      providerReference: `MOCK-${ids.randomCode(10)}`,
      status: 'pending',
      checkoutUrl: `${env.appUrl}/checkout/${reference}`,
      raw: { amountMinor, currency, method, payerIdentifier, metadata },
    };
  },

  /** Server-to-server verification — the only source of truth for settlement. */
  async verify(providerReference) {
    return { providerReference, status: 'successful' };
  },

  /** Payouts/disbursements to a mobile money wallet. */
  async disburse({ reference, amountMinor, destination }) {
    return {
      providerReference: `MOCKPAY-${ids.randomCode(10)}`,
      status: 'successful',
      raw: { reference, amountMinor, destination },
    };
  },

  /**
   * HMAC-SHA256 over the raw request body, compared in constant time. A real
   * provider integration replaces the header name and algorithm only.
   */
  verifySignature(rawBody, signature) {
    if (!signature) return false;
    const expected = crypto
      .createHmac('sha256', env.payment.webhookSecret)
      .update(rawBody)
      .digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(String(signature));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  },

  signatureHeader: 'x-susu-signature',
};

module.exports = mockProvider;
