'use strict';

/** Fee resolution, savings maturity rules and withdrawal reversal. */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  startDatabase, stopDatabase, resetDatabase, makeUser, walletOf, dbTest,
} = require('./helpers');

let feeService;
let settingsService;
let savingsService;
let withdrawalService;
let models;
let money;
let dates;

test.before(async () => {
  await startDatabase();
  feeService = require('../src/services/fee.service');
  settingsService = require('../src/services/settings.service');
  savingsService = require('../src/services/savings.service');
  withdrawalService = require('../src/services/withdrawal.service');
  models = require('../src/models');
  money = require('../src/utils/money');
  dates = require('../src/utils/dates');
});
test.after(async () => { await stopDatabase(); });
test.beforeEach(async () => { await resetDatabase(); });

dbTest('savings fees follow the configured percentage', async () => {
  await settingsService.updateSettings({ fees: { savingsFeePercent: 1, transactionFeeMinor: 0 } });

  const quote = await feeService.quoteSavingsFee(money.toMinor(1000));
  assert.equal(quote.feeMinor, money.toMinor(10), '1% of GH₵1000');
  assert.equal(quote.netAmountMinor, money.toMinor(990));
});

dbTest('changing the fee configuration changes the quote — no hard-coded rates', async () => {
  await settingsService.updateSettings({ fees: { savingsFeePercent: 2.5 } });
  const quote = await feeService.quoteSavingsFee(money.toMinor(200));
  assert.equal(quote.feeMinor, money.toMinor(5));
  assert.equal(quote.breakdown.savingsFeePercent, 2.5);
});

dbTest('an organization fee override beats the platform default', async () => {
  await settingsService.updateSettings({ fees: { savingsFeePercent: 1 } });
  const organization = { feeOverrides: { savingsFeePercent: 0 } };

  const overridden = await feeService.quoteSavingsFee(money.toMinor(500), organization);
  const standard = await feeService.quoteSavingsFee(money.toMinor(500));

  assert.equal(overridden.feeMinor, 0);
  assert.equal(standard.feeMinor, money.toMinor(5));
});

dbTest('withdrawal fees combine a percentage and a flat charge', async () => {
  await settingsService.updateSettings({
    fees: { withdrawalFeePercent: 0.5, withdrawalFlatFeeMinor: money.toMinor(1) },
  });

  const quote = await feeService.quoteWithdrawalFee(money.toMinor(200));
  assert.equal(quote.feeMinor, money.toMinor(2), 'GH₵1 percentage + GH₵1 flat');
  assert.equal(quote.netAmountMinor, money.toMinor(198));
});

dbTest('a withdrawal below the configured minimum is refused', async () => {
  await settingsService.updateSettings({ limits: { minWithdrawalMinor: money.toMinor(10) } });
  const user = await makeUser({ fundMajor: 500 });

  await assert.rejects(
    withdrawalService.requestWithdrawal({
      actor: user,
      payload: { amount: 5, accountNumber: '0244123456', provider: 'mtn' },
    }),
    (err) => err.errorCode === 'BELOW_MIN_WITHDRAWAL',
  );
});

dbTest('a withdrawal request debits immediately and a rejection returns the money', async () => {
  const user = await makeUser({ fundMajor: 500 });
  const { withdrawal } = await withdrawalService.requestWithdrawal({
    actor: user,
    payload: { amount: 100, accountNumber: '0244123456', provider: 'mtn' },
  });

  const afterRequest = await walletOf(user);
  assert.equal(afterRequest.availableBalanceMinor, money.toMinor(400), 'funds are held as soon as the request is made');

  await withdrawalService.rejectWithdrawal(withdrawal._id, { actor: null, note: 'Test rejection' });

  const afterRejection = await walletOf(user);
  assert.equal(afterRejection.availableBalanceMinor, money.toMinor(500), 'the full amount comes back');

  const reloaded = await models.Withdrawal.findById(withdrawal._id).lean();
  assert.equal(reloaded.status, 'rejected');

  // The original debit stays on the ledger; the reversal is a separate row.
  const rows = await models.Transaction.find({ userId: user._id }).lean();
  assert.ok(rows.some((r) => r.type === 'withdrawal'));
  assert.ok(rows.some((r) => r.type === 'refund'));
});

dbTest('a user cannot withdraw more than their balance', async () => {
  const user = await makeUser({ fundMajor: 50 });
  await assert.rejects(
    withdrawalService.requestWithdrawal({
      actor: user,
      payload: { amount: 100, accountNumber: '0244123456', provider: 'mtn' },
    }),
    (err) => err.errorCode === 'INSUFFICIENT_BALANCE',
  );
});

dbTest('savings inside the lock period cannot be released when early exit is off', async () => {
  const user = await makeUser({ fundMajor: 1000 });
  const plan = await savingsService.createPlan({
    actor: user,
    payload: { name: 'Locked Plan', targetAmount: 1000, contributionAmount: 100, minimumLockDays: 30, allowEarlyWithdrawal: false },
  });
  await savingsService.deposit({ actor: user, planId: plan._id, amount: 100 });

  await assert.rejects(
    savingsService.release({ actor: user, planId: plan._id }),
    (err) => err.errorCode === 'LOCK_PERIOD',
  );
});

dbTest('matured savings can be released back to the wallet', async () => {
  const user = await makeUser({ fundMajor: 1000 });
  const plan = await savingsService.createPlan({
    actor: user,
    payload: {
      name: 'Matured Plan',
      targetAmount: 1000,
      contributionAmount: 100,
      startDate: dates.addDays(new Date(), -60),
    },
  });
  await savingsService.deposit({ actor: user, planId: plan._id, amount: 200 });

  const beforeRelease = await walletOf(user);
  const { plan: updated } = await savingsService.release({ actor: user, planId: plan._id });
  const afterRelease = await walletOf(user);

  // 1% fee on the deposit means GH₵198 sits in the plan and returns to the wallet.
  assert.equal(updated.currentAmountMinor, 0);
  assert.equal(afterRelease.availableBalanceMinor - beforeRelease.availableBalanceMinor, money.toMinor(198));
});

dbTest('a user cannot deposit into another user\'s savings plan', async () => {
  const owner = await makeUser({ fundMajor: 500 });
  const stranger = await makeUser({ fundMajor: 500 });
  const plan = await savingsService.createPlan({ actor: owner, payload: { name: 'Private Goal', targetAmount: 500 } });

  await assert.rejects(
    savingsService.deposit({ actor: stranger, planId: plan._id, amount: 50 }),
    (err) => err.errorCode === 'PLAN_NOT_FOUND',
  );
});

dbTest('rent projection derives the monthly plan from the target', async () => {
  const user = await makeUser({ fundMajor: 20000 });
  const plan = await savingsService.createPlan({
    actor: user,
    payload: {
      name: 'Rent 2026',
      type: 'rent',
      targetAmount: 12000,
      contributionAmount: 1000,
      monthlyRent: 1000,
    },
  });
  await savingsService.deposit({ actor: user, planId: plan._id, amount: 3000 });

  const reloaded = await models.SavingsPlan.findById(plan._id);
  const projection = savingsService.rentProjection(reloaded);

  assert.equal(projection.targetMinor, money.toMinor(12000));
  assert.equal(projection.savedMinor, money.toMinor(2970)); // net of the 1% fee
  assert.equal(projection.remainingMinor, money.toMinor(9030));
  assert.ok(projection.projectedCompletionDate instanceof Date);
});
