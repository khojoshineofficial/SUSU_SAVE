'use strict';

const crypto = require('crypto');
const env = require('../../config/env');
const logger = require('../../utils/logger');
const ApiError = require('../../utils/apiError');

/**
 * Paystack.
 *
 * Paystack works in minor units (pesewas for GHS), which is what this codebase
 * stores everywhere, so no conversion happens here — a mismatch would be the
 * kind of bug that quietly charges people a hundred times too much.
 *
 * The flow is the standard one: `initialize` returns a hosted checkout URL, the
 * customer pays there, and settlement happens through the webhook and the
 * server-to-server verify. Nothing in this file touches the ledger.
 */

const API = 'https://api.paystack.co';

/** Paystack's bank codes for Ghanaian mobile money wallets. */
const MOMO_BANK_CODES = {
  mtn: 'MTN',
  telecel: 'VOD',
  vodafone: 'VOD',
  airteltigo: 'ATL',
};

/**
 * The secret key (sk_...). Paystack authenticates the API with it *and* signs
 * webhooks with it, so there is no separate webhook secret to configure.
 * PAYSTACK_SECRET_KEY is accepted as well, because that is what Paystack's own
 * documentation calls it.
 */
const secretKey = () => process.env.PAYSTACK_SECRET_KEY || env.payment.secret || '';

function requireKey() {
  const key = secretKey();
  if (!key) {
    throw ApiError.badRequest(
      'Paystack is not configured — set PAYMENT_PROVIDER_SECRET to your secret key',
      'PAYSTACK_NOT_CONFIGURED',
    );
  }
  if (!/^sk_/.test(key)) {
    // A public key here fails every call with a confusing 401 from Paystack.
    throw ApiError.badRequest(
      'PAYMENT_PROVIDER_SECRET must be a Paystack secret key (it starts with sk_)',
      'PAYSTACK_WRONG_KEY',
    );
  }
  return key;
}

/** One place for every call, so failures surface as a readable message. */
async function callPaystack(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${requireKey()}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  let payload = {};
  try { payload = await response.json(); } catch { /* non-JSON error page */ }

  if (!response.ok || payload.status === false) {
    const message = payload.message || `Paystack returned ${response.status}`;
    logger.error(`Paystack ${method} ${path} failed: ${message}`);
    throw ApiError.badRequest(`Payment provider error: ${message}`, 'PAYSTACK_ERROR');
  }
  return payload.data || {};
}

const paystackProvider = {
  name: 'paystack',

  /**
   * Opens a transaction and returns the hosted checkout URL. Paystack requires
   * an email address for every transaction, so one is synthesised from the
   * phone number when an account somehow has none — better a placeholder than a
   * payment that cannot start.
   */
  async initiate({ reference, amountMinor, currency, method, payerIdentifier, payerEmail, metadata }) {
    const email = payerEmail
      || metadata?.email
      || `${String(payerIdentifier || 'customer').replace(/\D/g, '') || 'customer'}@sususave.app`;

    const data = await callPaystack('/transaction/initialize', {
      method: 'POST',
      body: {
        email,
        amount: amountMinor,
        currency: currency || 'GHS',
        reference,
        // Where Paystack sends the customer back to. The page reads the
        // reference off the query string and asks the server to verify.
        callback_url: `${env.appUrl.replace(/\/+$/, '')}/wallet?reference=${encodeURIComponent(reference)}`,
        channels: method === 'card' ? ['card'] : ['mobile_money', 'card'],
        metadata: {
          ...metadata,
          phone: payerIdentifier || null,
          platform: 'SUSU SAVE',
        },
      },
    });

    return {
      // Paystack keys everything off the reference we supplied, so keeping the
      // two identical makes verification and webhook lookup trivial.
      providerReference: data.reference || reference,
      status: 'pending',
      checkoutUrl: data.authorization_url,
      raw: { accessCode: data.access_code },
    };
  },

  /**
   * Server-to-server verification — the only thing that settles money.
   *
   * When the caller supplies the payment we also check the amount and currency
   * that actually cleared. Without that, a customer could open checkout for
   * GH₵500, pay GH₵5, and still be credited the full amount.
   */
  async verify(providerReference, payment = null) {
    const data = await callPaystack(`/transaction/verify/${encodeURIComponent(providerReference)}`);

    const settled = data.status === 'success';
    if (settled && payment) {
      const shortPaid = Number(data.amount) < payment.amountMinor;
      const wrongCurrency = data.currency && payment.currency && data.currency !== payment.currency;
      if (shortPaid || wrongCurrency) {
        logger.error(
          `Paystack amount mismatch on ${providerReference}: `
          + `expected ${payment.amountMinor} ${payment.currency}, got ${data.amount} ${data.currency}`,
        );
        return { providerReference, status: 'failed', reason: 'amount_mismatch', raw: data };
      }
    }

    return {
      providerReference,
      // Anything that is not an outright success is left unsettled: 'ongoing'
      // and 'pending' come back on a prompt the customer has not approved yet.
      status: settled ? 'successful' : (data.status || 'pending'),
      raw: data,
    };
  },

  /**
   * Sends money out: create a transfer recipient, then transfer to it.
   *
   * Paystack transfers must be enabled on the account, and Ghanaian mobile
   * money payouts need approval from Paystack before they work. Until then this
   * fails with Paystack's own message, which is what a withdrawal operator
   * needs to see.
   */
  async disburse({ reference, amountMinor, destination }) {
    const bankCode = MOMO_BANK_CODES[String(destination?.provider || '').toLowerCase()];
    if (!bankCode) {
      throw ApiError.badRequest(
        `Unsupported mobile money provider for payout: ${destination?.provider}`,
        'UNSUPPORTED_PAYOUT_PROVIDER',
      );
    }

    const recipient = await callPaystack('/transferrecipient', {
      method: 'POST',
      body: {
        type: 'mobile_money',
        name: destination.accountName || 'SUSU SAVE member',
        account_number: destination.accountNumber,
        bank_code: bankCode,
        currency: 'GHS',
      },
    });

    const transfer = await callPaystack('/transfer', {
      method: 'POST',
      body: {
        source: 'balance',
        amount: amountMinor,
        recipient: recipient.recipient_code,
        reference,
        reason: 'SUSU SAVE withdrawal',
      },
    });

    return {
      providerReference: transfer.transfer_code || transfer.reference || reference,
      // 'success' is instant; 'pending' and 'otp' both mean it is still moving.
      status: transfer.status === 'success' ? 'successful' : 'pending',
      raw: transfer,
    };
  },

  /**
   * Paystack signs the raw request body with HMAC-SHA512 using the secret key.
   * Compared in constant time, and only after a length check, because
   * timingSafeEqual throws on mismatched lengths.
   */
  verifySignature(rawBody, signature) {
    const key = secretKey();
    if (!signature || !key) return false;

    const expected = crypto.createHmac('sha512', key).update(rawBody).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(String(signature));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  },

  signatureHeader: 'x-paystack-signature',
};

module.exports = paystackProvider;
module.exports.MOMO_BANK_CODES = MOMO_BANK_CODES;
