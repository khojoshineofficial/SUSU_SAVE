'use strict';

/**
 * Paystack integration.
 *
 * These are the parts that decide whether money is real: the webhook signature,
 * the amount that actually cleared, and the configuration check. The HTTP calls
 * are stubbed — this is about our handling of Paystack's answers, not about
 * Paystack being up.
 */

process.env.PAYMENT_PROVIDER = 'paystack';
process.env.PAYMENT_PROVIDER_SECRET = 'sk_test_abc123';
process.env.APP_URL = 'https://susu.test';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const paystack = require('../src/services/payment/paystack.provider');
const payments = require('../src/services/payment');

const realFetch = global.fetch;
const stubFetch = (payload, { ok = true, status = 200 } = {}) => {
  global.fetch = async (url, options) => {
    stubFetch.lastCall = { url, options: options || {} };
    return { ok, status, json: async () => payload };
  };
};
test.afterEach(() => { global.fetch = realFetch; });

/* -------------------------------- signature -------------------------------- */

const sign = (body, key = 'sk_test_abc123') =>
  crypto.createHmac('sha512', key).update(body).digest('hex');

test('a webhook signed with the secret key is accepted', () => {
  const body = JSON.stringify({ event: 'charge.success', data: { reference: 'PAY-123' } });
  assert.equal(paystack.verifySignature(body, sign(body)), true);
});

test('a webhook with a wrong, missing or tampered signature is refused', () => {
  const body = JSON.stringify({ event: 'charge.success', data: { reference: 'PAY-123' } });

  assert.equal(paystack.verifySignature(body, sign(body, 'sk_test_someone_else')), false);
  assert.equal(paystack.verifySignature(body, ''), false);
  assert.equal(paystack.verifySignature(body, undefined), false);
  assert.equal(paystack.verifySignature(body, 'not-a-signature'), false, 'a short value must not throw');

  // The signature must cover the body: changing the amount invalidates it.
  const signature = sign(body);
  const tampered = JSON.stringify({ event: 'charge.success', data: { reference: 'PAY-123', amount: 1 } });
  assert.equal(paystack.verifySignature(tampered, signature), false);
});

test('Paystack signs with SHA512, not SHA256', () => {
  const body = '{"a":1}';
  const sha256 = crypto.createHmac('sha256', 'sk_test_abc123').update(body).digest('hex');
  assert.equal(paystack.verifySignature(body, sha256), false);
  assert.equal(paystack.verifySignature(body, sign(body)), true);
});

/* --------------------------------- initiate -------------------------------- */

test('initiate sends minor units untouched and returns the checkout URL', async () => {
  stubFetch({
    status: true,
    data: { authorization_url: 'https://checkout.paystack.com/xyz', reference: 'PAY-123', access_code: 'ac' },
  });

  const result = await paystack.initiate({
    reference: 'PAY-123',
    amountMinor: 2500,
    currency: 'GHS',
    method: 'mobile_money',
    payerIdentifier: '0244123456',
    payerEmail: 'ama@example.com',
    metadata: {},
  });

  const sent = JSON.parse(stubFetch.lastCall.options.body);
  assert.equal(sent.amount, 2500, 'pesewas are sent as-is — no multiplying by 100 twice');
  assert.equal(sent.currency, 'GHS');
  assert.equal(sent.email, 'ama@example.com');
  assert.equal(sent.reference, 'PAY-123');
  assert.match(sent.callback_url, /^https:\/\/susu\.test\/wallet\?reference=PAY-123$/);
  assert.match(stubFetch.lastCall.options.headers.Authorization, /^Bearer sk_test_/);

  assert.equal(result.checkoutUrl, 'https://checkout.paystack.com/xyz');
  assert.equal(result.status, 'pending', 'initiating is never "paid"');
});

test('a Paystack error surfaces its message instead of a silent failure', async () => {
  stubFetch({ status: false, message: 'Invalid key' }, { ok: false, status: 401 });
  await assert.rejects(
    () => paystack.initiate({ reference: 'PAY-1', amountMinor: 100, currency: 'GHS', payerEmail: 'a@b.test' }),
    /Invalid key/,
  );
});

/* ---------------------------------- verify --------------------------------- */

test('only a Paystack "success" settles; anything else stays unsettled', async () => {
  for (const [paystackStatus, expected] of [
    ['success', 'successful'],
    ['failed', 'failed'],
    ['abandoned', 'abandoned'],
    ['ongoing', 'ongoing'],
  ]) {
    stubFetch({ status: true, data: { status: paystackStatus, amount: 2500, currency: 'GHS' } });
    // eslint-disable-next-line no-await-in-loop
    const result = await paystack.verify('PAY-123', { amountMinor: 2500, currency: 'GHS' });
    assert.equal(result.status, expected, `${paystackStatus} maps to ${expected}`);
  }
});

test('paying less than the amount asked for does not settle', async () => {
  stubFetch({ status: true, data: { status: 'success', amount: 500, currency: 'GHS' } });
  const result = await paystack.verify('PAY-123', { amountMinor: 50000, currency: 'GHS' });

  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'amount_mismatch');
});

test('paying in the wrong currency does not settle', async () => {
  stubFetch({ status: true, data: { status: 'success', amount: 2500, currency: 'NGN' } });
  const result = await paystack.verify('PAY-123', { amountMinor: 2500, currency: 'GHS' });

  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'amount_mismatch');
});

test('overpaying still settles — the member is not blocked by their own generosity', async () => {
  stubFetch({ status: true, data: { status: 'success', amount: 3000, currency: 'GHS' } });
  const result = await paystack.verify('PAY-123', { amountMinor: 2500, currency: 'GHS' });
  assert.equal(result.status, 'successful');
});

/* ------------------------------- configuration ------------------------------ */

test('the boot check catches the mistakes that break payments', () => {
  const check = (provider, secret) => {
    const previous = { provider: process.env.PAYMENT_PROVIDER, secret: process.env.PAYMENT_PROVIDER_SECRET };
    // env is read once at require time, so poke the cached config directly.
    const env = require('../src/config/env');
    env.payment.provider = provider;
    env.payment.secret = secret;
    delete process.env.PAYSTACK_SECRET_KEY;
    const result = payments.describeConfiguration();
    env.payment.provider = previous.provider;
    env.payment.secret = previous.secret;
    return result;
  };

  const unknown = check('paystak', 'sk_test_x');
  assert.equal(unknown.ok, false);
  assert.match(unknown.message, /not a registered provider/);
  assert.match(unknown.message, /paystack/, 'the correct spelling is offered');

  assert.equal(check('paystack', '').ok, false, 'no key is fatal');
  assert.match(check('paystack', 'pk_live_abc').message, /not a Paystack secret key/);

  const test_ = check('paystack', 'sk_test_abc');
  assert.equal(test_.ok, true);
  assert.equal(test_.warn, true, 'test mode is flagged');

  const live = check('paystack', 'sk_live_abc');
  assert.equal(live.ok, true);
  assert.equal(live.warn, false);

  assert.equal(check('mock', '').warn, true, 'the mock provider is always flagged');
});
