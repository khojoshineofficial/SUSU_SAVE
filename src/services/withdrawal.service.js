'use strict';

const { Withdrawal, Organization, constants } = require('../models');
const { WITHDRAWAL_STATUS, TRANSACTION_TYPE, PAYMENT_METHOD, TRANSACTION_STATUS } = constants;
const ledger = require('./ledger.service');
const feeService = require('./fee.service');
const paymentService = require('./payment');
const notifications = require('./notification.service');
const audit = require('./audit.service');
const { getSettings } = require('./settings.service');
const money = require('../utils/money');
const ids = require('../utils/ids');
const ApiError = require('../utils/apiError');
const logger = require('../utils/logger');

/**
 * Withdrawals are the only way money leaves SUSU SAVE, and they always run
 * through this two-phase flow:
 *
 *   request  → wallet is debited immediately and the request is queued
 *   complete → provider disburses; on failure the debit is reversed by a refund
 *
 * A withdrawal is never marked complete because a client said so.
 */

async function requestWithdrawal({ actor, payload }) {
  const settings = await getSettings();
  const amountMinor = money.toMinor(payload.amount);

  if (amountMinor < settings.limits.minWithdrawalMinor) {
    throw ApiError.badRequest(
      `Minimum withdrawal is ${money.format(settings.limits.minWithdrawalMinor)}`,
      'BELOW_MIN_WITHDRAWAL',
    );
  }
  if (amountMinor > settings.limits.maxWithdrawalMinor) {
    throw ApiError.badRequest(
      `Maximum withdrawal is ${money.format(settings.limits.maxWithdrawalMinor)}`,
      'ABOVE_MAX_WITHDRAWAL',
    );
  }
  if (!payload.accountNumber) {
    throw ApiError.badRequest('A destination account number is required', 'MISSING_DESTINATION');
  }

  const organization = actor.organizationId ? await Organization.findById(actor.organizationId) : null;
  const quote = await feeService.quoteWithdrawalFee(amountMinor, organization);
  if (quote.netAmountMinor <= 0) {
    throw ApiError.badRequest('The withdrawal fee exceeds the requested amount', 'FEE_EXCEEDS_AMOUNT');
  }

  const reference = `WDL-${ids.randomCode(10)}`;

  // Debit first: the balance guard inside ledger.post is what prevents a user
  // from queueing several withdrawals against the same money.
  const { transaction } = await ledger.post({
    userId: actor._id,
    organizationId: actor.organizationId || null,
    type: TRANSACTION_TYPE.WITHDRAWAL,
    grossAmountMinor: amountMinor,
    feeMinor: quote.feeMinor,
    paymentMethod: payload.method === 'bank' ? PAYMENT_METHOD.BANK : PAYMENT_METHOD.MOBILE_MONEY,
    provider: payload.provider || 'mtn',
    status: TRANSACTION_STATUS.SUCCESSFUL,
    description: 'Withdrawal request',
    metadata: { reference },
  });

  const withdrawal = await Withdrawal.create({
    userId: actor._id,
    organizationId: actor.organizationId || null,
    savingsPlanId: payload.savingsPlanId || null,
    reference,
    amountMinor,
    feeMinor: quote.feeMinor,
    netAmountMinor: quote.netAmountMinor,
    destination: {
      method: payload.method === 'bank' ? 'bank' : 'mobile_money',
      provider: payload.provider || 'mtn',
      accountNumber: payload.accountNumber,
      accountName: payload.accountName || `${actor.firstName} ${actor.lastName}`,
    },
    reason: payload.reason || '',
    status: WITHDRAWAL_STATUS.PENDING,
    transactionId: transaction._id,
  });

  await notifications.notify({
    userId: actor._id,
    ...notifications.templates.withdrawalRequested(amountMinor),
    dedupeKey: `wdl-req:${withdrawal._id}`,
  });

  await audit.log({
    actor,
    action: 'withdrawal.requested',
    entityType: 'Withdrawal',
    entityId: withdrawal._id,
    metadata: { amountMinor, feeMinor: quote.feeMinor },
  });

  if (settings.rules.autoApproveWithdrawals) {
    return processWithdrawal(withdrawal._id, { actor: null, autoApproved: true });
  }
  return { withdrawal, quote };
}

/** Admin approval → disbursement through the payment provider. */
async function processWithdrawal(withdrawalId, { actor = null, autoApproved = false } = {}) {
  const withdrawal = await Withdrawal.findById(withdrawalId);
  if (!withdrawal) throw ApiError.notFound('Withdrawal not found', 'WITHDRAWAL_NOT_FOUND');
  if ([WITHDRAWAL_STATUS.COMPLETED, WITHDRAWAL_STATUS.REJECTED].includes(withdrawal.status)) {
    return { withdrawal, alreadyFinal: true };
  }

  withdrawal.status = WITHDRAWAL_STATUS.PROCESSING;
  withdrawal.reviewedBy = actor?._id || null;
  withdrawal.reviewedAt = new Date();
  await withdrawal.save();

  try {
    const result = await paymentService.disburse({
      reference: withdrawal.reference,
      amountMinor: withdrawal.netAmountMinor,
      destination: withdrawal.destination,
    });

    if (result.status !== 'successful') throw new Error(result.failureReason || 'Provider declined the disbursement');

    withdrawal.status = WITHDRAWAL_STATUS.COMPLETED;
    withdrawal.completedAt = new Date();
    await withdrawal.save();

    await notifications.notify({
      userId: withdrawal.userId,
      ...notifications.templates.withdrawalCompleted(withdrawal.netAmountMinor),
      dedupeKey: `wdl-done:${withdrawal._id}`,
      alsoEmail: true,
    });
    await audit.log({
      actor,
      action: autoApproved ? 'withdrawal.auto_completed' : 'withdrawal.completed',
      entityType: 'Withdrawal',
      entityId: withdrawal._id,
      metadata: { netAmountMinor: withdrawal.netAmountMinor },
    });

    return { withdrawal, completed: true };
  } catch (err) {
    logger.error(`Withdrawal ${withdrawal.reference} failed: ${err.message}`);
    await reverse(withdrawal, err.message, actor);
    return { withdrawal, completed: false, error: err.message };
  }
}

async function rejectWithdrawal(withdrawalId, { actor, note }) {
  const withdrawal = await Withdrawal.findById(withdrawalId);
  if (!withdrawal) throw ApiError.notFound('Withdrawal not found', 'WITHDRAWAL_NOT_FOUND');
  if (withdrawal.status === WITHDRAWAL_STATUS.COMPLETED) {
    throw ApiError.badRequest('A completed withdrawal cannot be rejected', 'ALREADY_COMPLETED');
  }

  await reverse(withdrawal, note || 'Rejected by administrator', actor, WITHDRAWAL_STATUS.REJECTED);
  withdrawal.reviewNote = note || null;
  await withdrawal.save();

  await audit.log({
    actor,
    action: 'withdrawal.rejected',
    entityType: 'Withdrawal',
    entityId: withdrawal._id,
    metadata: { note },
  });
  return withdrawal;
}

/**
 * Return the money to the wallet with a compensating ledger row. The original
 * debit stays on the ledger — history is never rewritten.
 */
async function reverse(withdrawal, reason, actor = null, status = WITHDRAWAL_STATUS.FAILED) {
  await ledger.post({
    userId: withdrawal.userId,
    organizationId: withdrawal.organizationId,
    type: TRANSACTION_TYPE.REFUND,
    grossAmountMinor: withdrawal.amountMinor,
    feeMinor: 0,
    paymentMethod: PAYMENT_METHOD.SYSTEM,
    description: `Reversal of withdrawal ${withdrawal.reference}`,
    metadata: { withdrawalId: String(withdrawal._id), reason },
    idempotencyKey: `wdl-reversal:${withdrawal._id}`,
  });

  withdrawal.status = status;
  withdrawal.failureReason = reason;
  withdrawal.reviewedBy = actor?._id || withdrawal.reviewedBy;
  await withdrawal.save();

  await notifications.notify({
    userId: withdrawal.userId,
    ...notifications.templates.withdrawalFailed(withdrawal.amountMinor, reason),
    dedupeKey: `wdl-fail:${withdrawal._id}`,
  });
  return withdrawal;
}

module.exports = { requestWithdrawal, processWithdrawal, rejectWithdrawal };
