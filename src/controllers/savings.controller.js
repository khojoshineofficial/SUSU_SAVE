'use strict';

const { SavingsPlan, Transaction, constants } = require('../models');
const { SAVINGS_TYPE } = constants;
const savingsService = require('../services/savings.service');
const feeService = require('../services/fee.service');
const audit = require('../services/audit.service');
const ApiError = require('../utils/apiError');
const money = require('../utils/money');
const { asyncHandler, ok, created } = require('../utils/http');

/** Ownership is enforced by filtering on userId, never by trusting the :id. */
async function loadOwnedPlan(req) {
  const plan = await SavingsPlan.findOne({ _id: req.params.id, userId: req.user._id });
  if (!plan) throw ApiError.notFound('Savings plan not found', 'PLAN_NOT_FOUND');
  return plan;
}

const listPlans = asyncHandler(async (req, res) => {
  const filter = { userId: req.user._id };
  if (req.query.type) filter.type = req.query.type;
  if (req.query.status) filter.status = req.query.status;

  const plans = await SavingsPlan.find(filter).sort({ createdAt: -1 });
  return ok(res, { plans: plans.map((p) => p.toJSON()) });
});

const createPlan = asyncHandler(async (req, res) => {
  const plan = await savingsService.createPlan({ actor: req.user, payload: req.body });
  await audit.log({ req, action: 'savings.created', entityType: 'SavingsPlan', entityId: plan._id });
  return created(res, { plan: plan.toJSON() }, 'Savings plan created');
});

const getPlan = asyncHandler(async (req, res) => {
  const plan = await loadOwnedPlan(req);
  const [transactions, eligibility] = await Promise.all([
    Transaction.find({ savingsPlanId: plan._id }).sort({ createdAt: -1 }).limit(20).lean(),
    savingsService.checkWithdrawalEligibility(plan),
  ]);

  return ok(res, {
    plan: plan.toJSON(),
    transactions,
    withdrawalEligibility: eligibility,
    projection: plan.type === SAVINGS_TYPE.RENT ? savingsService.rentProjection(plan) : null,
  });
});

const updatePlan = asyncHandler(async (req, res) => {
  const plan = await loadOwnedPlan(req);
  // currentAmountMinor is ledger-derived and deliberately not updatable here.
  ['name', 'description', 'targetDate'].forEach((field) => {
    if (req.body[field] !== undefined) plan[field] = req.body[field];
  });
  if (req.body.targetAmount !== undefined) plan.targetAmountMinor = money.toMinor(req.body.targetAmount);
  if (req.body.contributionAmount !== undefined) {
    plan.contributionAmountMinor = money.toMinor(req.body.contributionAmount);
  }
  await plan.save();

  await audit.log({ req, action: 'savings.updated', entityType: 'SavingsPlan', entityId: plan._id });
  return ok(res, { plan: plan.toJSON() }, 'Savings plan updated');
});

const deposit = asyncHandler(async (req, res) => {
  const result = await savingsService.deposit({
    actor: req.user,
    planId: req.params.id,
    amount: req.body.amount,
    idempotencyKey: req.get('idempotency-key') || null,
  });
  return created(res, {
    plan: result.plan.toJSON(),
    transaction: result.transaction,
    replayed: result.replayed,
  }, result.replayed ? 'Deposit already recorded' : 'Deposit successful');
});

const release = asyncHandler(async (req, res) => {
  const result = await savingsService.release({
    actor: req.user,
    planId: req.params.id,
    amount: req.body.amount ?? null,
  });
  await audit.log({ req, action: 'savings.released', entityType: 'SavingsPlan', entityId: result.plan._id });
  return ok(res, {
    plan: result.plan.toJSON(),
    transaction: result.transaction,
    penaltyMinor: result.penaltyMinor,
  }, 'Funds released to your wallet');
});

const quoteDeposit = asyncHandler(async (req, res) => {
  const quote = await feeService.quoteSavingsFee(money.toMinor(req.query.amount), null);
  return ok(res, { quote });
});

/** Rent savings gets its own view because the dashboard card is rent-specific. */
const rentOverview = asyncHandler(async (req, res) => {
  const plans = await SavingsPlan.find({ userId: req.user._id, type: SAVINGS_TYPE.RENT });
  return ok(res, {
    plans: plans.map((plan) => ({
      plan: plan.toJSON(),
      projection: savingsService.rentProjection(plan),
    })),
  });
});

module.exports = { listPlans, createPlan, getPlan, updatePlan, deposit, release, quoteDeposit, rentOverview };
