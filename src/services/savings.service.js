'use strict';

const { SavingsPlan, Organization, constants } = require('../models');
const { SAVINGS_TYPE, SAVINGS_STATUS, TRANSACTION_TYPE, PAYMENT_METHOD, FREQUENCY } = constants;
const ledger = require('./ledger.service');
const feeService = require('./fee.service');
const notifications = require('./notification.service');
const { getSettings } = require('./settings.service');
const money = require('../utils/money');
const dates = require('../utils/dates');
const ApiError = require('../utils/apiError');

const MILESTONES = [25, 50, 75, 100];

async function createPlan({ actor, payload }) {
  const settings = await getSettings();
  const targetAmountMinor = payload.targetAmount ? money.toMinor(payload.targetAmount) : 0;

  if (targetAmountMinor && targetAmountMinor < settings.limits.minSavingsTargetMinor) {
    throw ApiError.badRequest(
      `Minimum savings target is ${money.format(settings.limits.minSavingsTargetMinor)}`,
      'TARGET_TOO_SMALL',
    );
  }

  const type = payload.type || SAVINGS_TYPE.PERSONAL;
  const frequency = payload.frequency || FREQUENCY.MONTHLY;
  const startDate = dates.startOfDay(payload.startDate || new Date());

  const plan = await SavingsPlan.create({
    userId: actor._id,
    organizationId: actor.organizationId || null,
    name: payload.name,
    description: payload.description || '',
    type,
    targetAmountMinor,
    contributionAmountMinor: payload.contributionAmount ? money.toMinor(payload.contributionAmount) : 0,
    frequency,
    startDate,
    targetDate: payload.targetDate ? dates.startOfDay(payload.targetDate) : null,
    nextContributionDate: dates.addPeriods(startDate, frequency, 1),
    withdrawalRules: {
      lockUntilTarget: Boolean(payload.lockUntilTarget),
      minimumLockDays: payload.minimumLockDays ?? settings.rules.individualSavingsLockDays,
      allowEarlyWithdrawal: payload.allowEarlyWithdrawal !== false,
      earlyWithdrawalPenaltyPercent: payload.earlyWithdrawalPenaltyPercent ?? 0,
    },
    rentDetails: type === SAVINGS_TYPE.RENT
      ? {
        monthlyRentMinor: payload.monthlyRent ? money.toMinor(payload.monthlyRent) : null,
        landlordName: payload.landlordName || null,
        propertyLabel: payload.propertyLabel || null,
      }
      : {},
  });

  return plan;
}

/** Move money from the wallet into a savings plan. */
async function deposit({ actor, planId, amount, idempotencyKey = null }) {
  const plan = await SavingsPlan.findOne({ _id: planId, userId: actor._id });
  if (!plan) throw ApiError.notFound('Savings plan not found', 'PLAN_NOT_FOUND');
  if (plan.status !== SAVINGS_STATUS.ACTIVE) {
    throw ApiError.badRequest('This savings plan is closed', 'PLAN_CLOSED');
  }

  const amountMinor = money.toMinor(amount);
  if (amountMinor <= 0) throw ApiError.badRequest('Deposit amount must be positive', 'INVALID_AMOUNT');

  const organization = plan.organizationId ? await Organization.findById(plan.organizationId) : null;
  const quote = await feeService.quoteSavingsFee(amountMinor, organization);

  const { transaction, replayed } = await ledger.post({
    userId: actor._id,
    organizationId: plan.organizationId,
    savingsPlanId: plan._id,
    type: TRANSACTION_TYPE.CONTRIBUTION,
    grossAmountMinor: amountMinor,
    feeMinor: quote.feeMinor,
    paymentMethod: PAYMENT_METHOD.WALLET,
    description: `Deposit into ${plan.name}`,
    metadata: { savingsPlanId: String(plan._id) },
    idempotencyKey,
  });

  if (replayed) return { plan, transaction, replayed: true };

  const before = plan.progressPercent;
  plan.currentAmountMinor = money.add(plan.currentAmountMinor, quote.netAmountMinor);
  plan.lastContributionAt = new Date();
  plan.nextContributionDate = dates.addPeriods(new Date(), plan.frequency, 1);

  if (plan.targetAmountMinor && plan.currentAmountMinor >= plan.targetAmountMinor) {
    plan.status = SAVINGS_STATUS.MATURED;
    plan.maturedAt = new Date();
  }
  await plan.save();

  const crossed = MILESTONES.filter((m) => before < m && plan.progressPercent >= m);
  await Promise.all(crossed.map((percent) => notifications.notify({
    userId: actor._id,
    organizationId: plan.organizationId,
    ...notifications.templates.savingsMilestone(plan, percent),
    dedupeKey: `milestone:${plan._id}:${percent}`,
  })));

  return { plan, transaction, replayed: false };
}

/**
 * Whether a plan's balance may be released back to the wallet.
 * Individual savings mature monthly by default, hence the lock-days rule.
 */
function checkWithdrawalEligibility(plan, { now = new Date() } = {}) {
  const rules = plan.withdrawalRules || {};
  const lockDays = rules.minimumLockDays ?? 30;
  const heldDays = dates.daysBetween(plan.startDate, now);

  if (rules.lockUntilTarget && plan.targetAmountMinor && plan.currentAmountMinor < plan.targetAmountMinor) {
    return { eligible: false, code: 'TARGET_NOT_REACHED', reason: 'This plan is locked until the target is reached' };
  }
  if (heldDays < lockDays) {
    if (!rules.allowEarlyWithdrawal) {
      return {
        eligible: false,
        code: 'LOCK_PERIOD',
        reason: `Funds are locked for ${lockDays - heldDays} more day(s)`,
      };
    }
    return {
      eligible: true,
      early: true,
      penaltyPercent: rules.earlyWithdrawalPenaltyPercent || 0,
    };
  }
  return { eligible: true, early: false, penaltyPercent: 0 };
}

/** Release matured savings back into the wallet so they can be withdrawn. */
async function release({ actor, planId, amount = null }) {
  const plan = await SavingsPlan.findOne({ _id: planId, userId: actor._id });
  if (!plan) throw ApiError.notFound('Savings plan not found', 'PLAN_NOT_FOUND');

  const verdict = checkWithdrawalEligibility(plan);
  if (!verdict.eligible) throw ApiError.unprocessable(verdict.reason, verdict.code);

  const requestedMinor = amount === null ? plan.currentAmountMinor : money.toMinor(amount);
  if (requestedMinor <= 0 || requestedMinor > plan.currentAmountMinor) {
    throw ApiError.badRequest('Amount exceeds the plan balance', 'INVALID_AMOUNT');
  }

  const penaltyMinor = verdict.early ? money.percentOf(requestedMinor, verdict.penaltyPercent) : 0;

  const { transaction } = await ledger.post({
    userId: actor._id,
    organizationId: plan.organizationId,
    savingsPlanId: plan._id,
    type: TRANSACTION_TYPE.REFUND,
    grossAmountMinor: requestedMinor,
    feeMinor: penaltyMinor,
    paymentMethod: PAYMENT_METHOD.WALLET,
    description: `Release from ${plan.name}`,
    metadata: { early: verdict.early, penaltyPercent: verdict.penaltyPercent },
  });

  plan.currentAmountMinor = money.subtract(plan.currentAmountMinor, requestedMinor);
  if (plan.currentAmountMinor === 0 && plan.status === SAVINGS_STATUS.MATURED) {
    plan.status = SAVINGS_STATUS.COMPLETED;
    plan.closedAt = new Date();
  }
  await plan.save();

  return { plan, transaction, penaltyMinor };
}

/** Rent dashboard figures, all derived server-side. */
function rentProjection(plan, { now = new Date() } = {}) {
  const target = plan.targetAmountMinor || plan.rentDetails?.monthlyRentMinor || 0;
  const remaining = Math.max(0, target - plan.currentAmountMinor);
  const monthly = plan.contributionAmountMinor || 0;
  const monthsRemaining = monthly > 0 ? Math.ceil(remaining / monthly) : null;

  return {
    targetMinor: target,
    savedMinor: plan.currentAmountMinor,
    remainingMinor: remaining,
    percentComplete: target ? Math.round((plan.currentAmountMinor / target) * 1000) / 10 : 0,
    monthlyTargetMinor: monthly,
    nextContributionDate: plan.nextContributionDate,
    projectedCompletionDate: monthsRemaining === null ? null : dates.addMonths(now, monthsRemaining),
    onTrack: plan.targetDate && monthsRemaining !== null
      ? dates.addMonths(now, monthsRemaining) <= new Date(plan.targetDate)
      : null,
  };
}

module.exports = { createPlan, deposit, release, checkWithdrawalEligibility, rentProjection };
