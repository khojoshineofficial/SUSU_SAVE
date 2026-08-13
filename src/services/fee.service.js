'use strict';

const money = require('../utils/money');
const { getSettings } = require('./settings.service');

/**
 * Every fee in the product is resolved here, from SystemSetting values with
 * optional per-organization overrides. No controller computes a fee itself, and
 * no fee percentage is hard-coded anywhere else in the codebase.
 */

const pick = (override, fallback) => (override === null || override === undefined ? fallback : override);

async function resolveSchedule(organization = null) {
  const settings = await getSettings();
  const o = organization?.feeOverrides || {};
  return {
    registrationFeeMinor: settings.fees.registrationFeeMinor,
    monthlyPlatformFeeMinor: settings.fees.monthlyPlatformFeeMinor,
    groupCreationFeeMinor: pick(o.groupCreationFeeMinor, settings.fees.groupCreationFeeMinor),
    savingsFeePercent: pick(o.savingsFeePercent, settings.fees.savingsFeePercent),
    withdrawalFeePercent: pick(o.withdrawalFeePercent, settings.fees.withdrawalFeePercent),
    withdrawalFlatFeeMinor: settings.fees.withdrawalFlatFeeMinor,
    payoutFeePercent: settings.fees.payoutFeePercent,
    transactionFeeMinor: settings.fees.transactionFeeMinor,
  };
}

/**
 * Fee taken on money going *into* savings (a contribution or a plan deposit).
 * Returns the breakdown the UI shows the user before they confirm.
 */
async function quoteSavingsFee(amountMinor, organization = null) {
  const schedule = await resolveSchedule(organization);
  const percentFee = money.percentOf(amountMinor, schedule.savingsFeePercent);
  const feeMinor = money.add(percentFee, schedule.transactionFeeMinor);
  return {
    grossAmountMinor: amountMinor,
    feeMinor,
    netAmountMinor: money.subtract(amountMinor, feeMinor),
    breakdown: {
      savingsFeePercent: schedule.savingsFeePercent,
      percentFeeMinor: percentFee,
      transactionFeeMinor: schedule.transactionFeeMinor,
    },
  };
}

/** Fee on money leaving the platform. Charged on top of the requested amount. */
async function quoteWithdrawalFee(amountMinor, organization = null) {
  const schedule = await resolveSchedule(organization);
  const percentFee = money.percentOf(amountMinor, schedule.withdrawalFeePercent);
  const feeMinor = money.add(percentFee, schedule.withdrawalFlatFeeMinor);
  return {
    grossAmountMinor: amountMinor,
    feeMinor,
    // The user receives the amount minus the fee; the wallet is debited in full.
    netAmountMinor: money.clampNonNegative(money.subtract(amountMinor, feeMinor)),
    breakdown: {
      withdrawalFeePercent: schedule.withdrawalFeePercent,
      percentFeeMinor: percentFee,
      flatFeeMinor: schedule.withdrawalFlatFeeMinor,
    },
  };
}

/** Fee deducted from a group payout before it reaches the recipient. */
async function quotePayoutFee(amountMinor, organization = null) {
  const schedule = await resolveSchedule(organization);
  const feeMinor = money.percentOf(amountMinor, schedule.payoutFeePercent);
  return {
    grossAmountMinor: amountMinor,
    feeMinor,
    netAmountMinor: money.subtract(amountMinor, feeMinor),
    breakdown: { payoutFeePercent: schedule.payoutFeePercent },
  };
}

async function registrationFeeMinor(organization = null) {
  return (await resolveSchedule(organization)).registrationFeeMinor;
}

async function groupCreationFeeMinor(organization = null) {
  return (await resolveSchedule(organization)).groupCreationFeeMinor;
}

module.exports = {
  resolveSchedule,
  quoteSavingsFee,
  quoteWithdrawalFee,
  quotePayoutFee,
  registrationFeeMinor,
  groupCreationFeeMinor,
};
