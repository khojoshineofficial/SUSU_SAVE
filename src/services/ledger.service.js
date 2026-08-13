'use strict';

const { Transaction, Wallet, constants } = require('../models');
const { TRANSACTION_TYPE, TRANSACTION_STATUS, CREDIT_TYPES } = constants;
const money = require('../utils/money');
const ids = require('../utils/ids');
const ApiError = require('../utils/apiError');
const logger = require('../utils/logger');

/**
 * The only module allowed to create ledger rows or move a wallet balance.
 *
 * Integrity model
 * ---------------
 * 1. Transactions are append-only. A mistake is corrected with a compensating
 *    `adjustment`/`refund` row, never by editing an existing one.
 * 2. Every caller that can be retried passes an `idempotencyKey`. A unique
 *    partial index rejects the duplicate, and `record()` returns the original
 *    row instead of creating money twice.
 * 3. Wallet mutations use atomic `$inc` with a balance guard, so two concurrent
 *    debits cannot both pass an availability check and overdraw the wallet.
 *    The wallet is a projection: `recompute()` rebuilds it from the ledger.
 */

const DUPLICATE_KEY = 11000;

async function getOrCreateWallet(userId, organizationId = null) {
  const existing = await Wallet.findOne({ userId });
  if (existing) return existing;
  try {
    return await Wallet.create({ userId, organizationId });
  } catch (err) {
    if (err?.code === DUPLICATE_KEY) return Wallet.findOne({ userId });
    throw err;
  }
}

/**
 * Append a ledger row. Does NOT touch the wallet — call `post()` for a row that
 * should move a balance, or `record()` for a purely informational/pending row.
 */
async function record({
  userId,
  organizationId = null,
  groupId = null,
  savingsPlanId = null,
  type,
  grossAmountMinor,
  feeMinor = 0,
  status = TRANSACTION_STATUS.SUCCESSFUL,
  paymentMethod,
  provider = null,
  providerReference = null,
  description = '',
  metadata = {},
  idempotencyKey = null,
  direction,
}) {
  if (!Number.isInteger(grossAmountMinor) || grossAmountMinor < 0) {
    throw ApiError.badRequest('Transaction amount must be a non-negative integer', 'INVALID_AMOUNT');
  }
  if (feeMinor > grossAmountMinor) {
    throw ApiError.badRequest('Fee cannot exceed the transaction amount', 'INVALID_FEE');
  }

  const payload = {
    transactionId: ids.transactionId(),
    userId,
    organizationId,
    groupId,
    savingsPlanId,
    type,
    direction: direction || (CREDIT_TYPES.includes(type) ? 'credit' : 'debit'),
    grossAmountMinor,
    feeMinor,
    netAmountMinor: money.subtract(grossAmountMinor, feeMinor),
    status,
    paymentMethod,
    provider,
    providerReference,
    description,
    metadata,
    idempotencyKey,
    completedAt: status === TRANSACTION_STATUS.SUCCESSFUL ? new Date() : null,
  };

  try {
    return await Transaction.create(payload);
  } catch (err) {
    if (err?.code === DUPLICATE_KEY && idempotencyKey) {
      logger.warn(`Idempotent replay suppressed for key ${idempotencyKey}`);
      const original = await Transaction.findOne({ idempotencyKey });
      if (original) return original;
    }
    throw err;
  }
}

/** Counters on the wallet that a given transaction type should advance. */
function counterFor(type) {
  switch (type) {
    case TRANSACTION_TYPE.DEPOSIT:
      return 'totalDepositedMinor';
    case TRANSACTION_TYPE.CONTRIBUTION:
      return 'totalContributedMinor';
    case TRANSACTION_TYPE.PAYOUT:
      return 'totalReceivedMinor';
    case TRANSACTION_TYPE.WITHDRAWAL:
      return 'totalWithdrawnMinor';
    default:
      return null;
  }
}

/**
 * Write a ledger row and apply it to the wallet in one call.
 *
 * For a debit the wallet is decremented under a `$gte` guard; if the balance is
 * insufficient the update matches nothing and we fail without having written
 * anything the user can spend.
 */
async function post(entry) {
  const { userId, organizationId = null, type, grossAmountMinor } = entry;
  const direction = entry.direction || (CREDIT_TYPES.includes(type) ? 'credit' : 'debit');
  const wallet = await getOrCreateWallet(userId, organizationId);

  // An already-applied idempotent entry must not move the balance a second time.
  if (entry.idempotencyKey) {
    const existing = await Transaction.findOne({ idempotencyKey: entry.idempotencyKey });
    if (existing) return { transaction: existing, wallet, replayed: true };
  }

  const feeMinor = entry.feeMinor || 0;
  const netMinor = money.subtract(grossAmountMinor, feeMinor);
  const inc = { totalFeesPaidMinor: feeMinor };
  const counter = counterFor(type);
  if (counter) inc[counter] = grossAmountMinor;

  let updated;
  if (direction === 'credit') {
    // Credits post the net amount: the fee is retained by the platform.
    inc.availableBalanceMinor = netMinor;
    updated = await Wallet.findOneAndUpdate({ _id: wallet._id }, { $inc: inc }, { new: true });
  } else {
    // Debits take the gross amount out of the wallet.
    inc.availableBalanceMinor = -grossAmountMinor;
    updated = await Wallet.findOneAndUpdate(
      { _id: wallet._id, availableBalanceMinor: { $gte: grossAmountMinor } },
      { $inc: inc },
      { new: true },
    );
    if (!updated) {
      throw new ApiError(
        422,
        'Insufficient wallet balance for this transaction',
        'INSUFFICIENT_BALANCE',
        { requiredMinor: grossAmountMinor, availableMinor: wallet.availableBalanceMinor },
      );
    }
  }

  let transaction;
  try {
    transaction = await record({ ...entry, direction, status: TRANSACTION_STATUS.SUCCESSFUL });
  } catch (err) {
    // Roll the balance back so a failed ledger write never leaves phantom money.
    const rollback = Object.fromEntries(Object.entries(inc).map(([k, v]) => [k, -v]));
    await Wallet.updateOne({ _id: wallet._id }, { $inc: rollback });
    throw err;
  }

  return { transaction, wallet: updated, replayed: false };
}

/**
 * Rebuild a wallet from its ledger rows. Used by the reconciliation job and
 * available to Super Admin — this is what makes the wallet safe to cache.
 */
async function recompute(userId) {
  const rows = await Transaction.find({ userId, status: TRANSACTION_STATUS.SUCCESSFUL }).lean();
  const totals = {
    availableBalanceMinor: 0,
    totalDepositedMinor: 0,
    totalContributedMinor: 0,
    totalReceivedMinor: 0,
    totalWithdrawnMinor: 0,
    totalFeesPaidMinor: 0,
  };

  rows.forEach((row) => {
    const net = row.netAmountMinor;
    totals.availableBalanceMinor += row.direction === 'credit' ? net : -row.grossAmountMinor;
    totals.totalFeesPaidMinor += row.feeMinor || 0;
    const counter = counterFor(row.type);
    if (counter) totals[counter] += row.grossAmountMinor;
  });

  const wallet = await getOrCreateWallet(userId);
  Object.assign(wallet, totals, { lastRecomputedAt: new Date() });
  await wallet.save();
  return wallet;
}

const pendingSum = async (filter) => {
  const [row] = await Transaction.aggregate([
    { $match: { ...filter, status: TRANSACTION_STATUS.PENDING } },
    { $group: { _id: null, total: { $sum: '$grossAmountMinor' } } },
  ]);
  return row?.total || 0;
};

module.exports = { getOrCreateWallet, record, post, recompute, pendingSum };
