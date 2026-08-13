'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  startDatabase, stopDatabase, resetDatabase, makeUser, walletOf, dbTest,
} = require('./helpers');

let ledger;
let constants;
let money;

test.before(async () => {
  await startDatabase();
  ledger = require('../src/services/ledger.service');
  ({ constants } = require('../src/models'));
  money = require('../src/utils/money');
});
test.after(async () => { await stopDatabase(); });
test.beforeEach(async () => { await resetDatabase(); });

dbTest('a credit increases the wallet by the net amount and keeps the fee', async () => {
  const user = await makeUser({ fundMajor: 0 });
  await ledger.post({
    userId: user._id,
    type: constants.TRANSACTION_TYPE.DEPOSIT,
    grossAmountMinor: money.toMinor(100),
    feeMinor: money.toMinor(1),
    paymentMethod: constants.PAYMENT_METHOD.MOBILE_MONEY,
  });

  const wallet = await walletOf(user);
  assert.equal(wallet.availableBalanceMinor, money.toMinor(99));
  assert.equal(wallet.totalFeesPaidMinor, money.toMinor(1));
  assert.equal(wallet.totalDepositedMinor, money.toMinor(100));
});

dbTest('a debit is refused when the balance is insufficient', async () => {
  const user = await makeUser({ fundMajor: 10 });
  await assert.rejects(
    ledger.post({
      userId: user._id,
      type: constants.TRANSACTION_TYPE.CONTRIBUTION,
      grossAmountMinor: money.toMinor(50),
      paymentMethod: constants.PAYMENT_METHOD.WALLET,
    }),
    (err) => err.errorCode === 'INSUFFICIENT_BALANCE',
  );

  const wallet = await walletOf(user);
  assert.equal(wallet.availableBalanceMinor, money.toMinor(10), 'balance must be untouched after a refused debit');
});

dbTest('an idempotency key prevents a duplicate transaction from creating money', async () => {
  const user = await makeUser({ fundMajor: 0 });
  const entry = {
    userId: user._id,
    type: constants.TRANSACTION_TYPE.DEPOSIT,
    grossAmountMinor: money.toMinor(500),
    paymentMethod: constants.PAYMENT_METHOD.MOBILE_MONEY,
    idempotencyKey: 'payment:abc-123',
  };

  const first = await ledger.post(entry);
  const second = await ledger.post(entry);

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(String(first.transaction._id), String(second.transaction._id));

  const wallet = await walletOf(user);
  assert.equal(wallet.availableBalanceMinor, money.toMinor(500), 'the replay must not credit a second time');
});

dbTest('concurrent debits cannot overdraw a wallet', async () => {
  const user = await makeUser({ fundMajor: 100 });
  const debit = () => ledger.post({
    userId: user._id,
    type: constants.TRANSACTION_TYPE.CONTRIBUTION,
    grossAmountMinor: money.toMinor(80),
    paymentMethod: constants.PAYMENT_METHOD.WALLET,
  });

  const results = await Promise.allSettled([debit(), debit()]);
  const succeeded = results.filter((r) => r.status === 'fulfilled').length;

  assert.equal(succeeded, 1, 'exactly one of two competing debits should succeed');
  const wallet = await walletOf(user);
  assert.equal(wallet.availableBalanceMinor, money.toMinor(20));
  assert.ok(wallet.availableBalanceMinor >= 0);
});

dbTest('recompute rebuilds the wallet from ledger rows', async () => {
  const user = await makeUser({ fundMajor: 200 });
  await ledger.post({
    userId: user._id,
    type: constants.TRANSACTION_TYPE.CONTRIBUTION,
    grossAmountMinor: money.toMinor(50),
    feeMinor: money.toMinor(0.5),
    paymentMethod: constants.PAYMENT_METHOD.WALLET,
  });

  // Corrupt the cached projection, then prove the ledger is the source of truth.
  const { Wallet } = require('../src/models');
  await Wallet.updateOne({ userId: user._id }, { $set: { availableBalanceMinor: 999999 } });

  const rebuilt = await ledger.recompute(user._id);
  assert.equal(rebuilt.availableBalanceMinor, money.toMinor(150));
  assert.equal(rebuilt.totalContributedMinor, money.toMinor(50));
});

dbTest('a transaction cannot carry a fee larger than its amount', async () => {
  const user = await makeUser({ fundMajor: 100 });
  await assert.rejects(
    ledger.record({
      userId: user._id,
      type: constants.TRANSACTION_TYPE.CONTRIBUTION,
      grossAmountMinor: 100,
      feeMinor: 500,
      paymentMethod: constants.PAYMENT_METHOD.WALLET,
    }),
    (err) => err.errorCode === 'INVALID_FEE',
  );
});
