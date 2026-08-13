'use strict';

const {
  SusuGroup, GroupMember, Contribution, Payout, Organization, constants,
} = require('../models');
const {
  PAYOUT_STATUS, CONTRIBUTION_STATUS, GROUP_STATUS, TRANSACTION_TYPE, PAYMENT_METHOD,
} = constants;
const ledger = require('./ledger.service');
const feeService = require('./fee.service');
const notifications = require('./notification.service');
const audit = require('./audit.service');
const { getSettings } = require('./settings.service');
const money = require('../utils/money');
const ApiError = require('../utils/apiError');
const logger = require('../utils/logger');

/**
 * The payout engine. Nothing a client sends influences the amount paid: the
 * recipient comes from the rotation stored at group activation, and the amount
 * is summed from Contribution rows at the moment of payout.
 */

/**
 * What a cycle actually holds.
 *
 * `paidMinor` is the money available to pay out: the gross members handed over
 * less the platform fee withheld from each contribution. `outstandingMinor`
 * measures members' obligations against the gross they paid, so a fee never
 * makes a fully-paid member look like a defaulter.
 */
async function collectedForCycle(groupId, cycle) {
  const [row] = await Contribution.aggregate([
    { $match: { groupId, cycle } },
    {
      $group: {
        _id: null,
        gross: { $sum: '$paidAmountMinor' },
        fees: { $sum: { $ifNull: ['$platformFeeMinor', 0] } },
        expected: { $sum: '$expectedAmountMinor' },
        outstanding: { $sum: { $subtract: ['$expectedAmountMinor', '$paidAmountMinor'] } },
      },
    },
  ]);
  return {
    paidMinor: Math.max(0, (row?.gross || 0) - (row?.fees || 0)),
    grossPaidMinor: row?.gross || 0,
    feesWithheldMinor: row?.fees || 0,
    expectedMinor: row?.expected || 0,
    outstandingMinor: Math.max(0, row?.outstanding || 0),
  };
}

/**
 * Decide whether a scheduled payout may run. Returns a structured verdict so
 * the reason a payout is held can be shown in the UI and stored on the record.
 */
async function evaluateEligibility(payout, group, { now = new Date() } = {}) {
  const settings = await getSettings();

  if (payout.status === PAYOUT_STATUS.COMPLETED) {
    return { eligible: false, code: 'ALREADY_PAID', reason: 'This payout has already been completed' };
  }
  if (group.status !== GROUP_STATUS.ACTIVE) {
    return { eligible: false, code: 'GROUP_NOT_ACTIVE', reason: 'The group is not active' };
  }
  if (new Date(payout.scheduledDate) > now) {
    return { eligible: false, code: 'NOT_DUE', reason: `Scheduled for ${payout.scheduledDate.toISOString().slice(0, 10)}` };
  }

  // Cycles must complete in order — never pay cycle 3 while cycle 2 is open.
  const earlier = await Payout.findOne({
    groupId: group._id,
    cycle: { $lt: payout.cycle },
    status: { $ne: PAYOUT_STATUS.COMPLETED },
  }).lean();
  if (earlier) {
    return { eligible: false, code: 'EARLIER_CYCLE_OPEN', reason: `Cycle ${earlier.cycle} has not been paid out yet` };
  }

  const collected = await collectedForCycle(group._id, payout.cycle);
  if (collected.paidMinor <= 0) {
    return { eligible: false, code: 'NOTHING_COLLECTED', reason: 'No contributions have been collected for this cycle', collected };
  }
  if (group.settings.requireFullPoolBeforePayout && collected.outstandingMinor > 0) {
    return {
      eligible: false,
      code: 'POOL_INCOMPLETE',
      reason: `${money.format(collected.outstandingMinor)} is still outstanding for this cycle`,
      collected,
    };
  }

  if (settings.rules.requireCleanRecordForPayout) {
    const missed = await Contribution.countDocuments({
      groupId: group._id,
      userId: payout.recipientId,
      status: CONTRIBUTION_STATUS.MISSED,
    });
    if (missed > 0) {
      return { eligible: false, code: 'RECIPIENT_IN_ARREARS', reason: 'The recipient has missed contributions', collected };
    }
  }

  return { eligible: true, collected };
}

/**
 * Execute a payout. The recipient's wallet is credited with the collected pool
 * minus the configured payout fee; the money then leaves the platform through
 * the ordinary withdrawal flow, which keeps one audited exit path.
 */
async function processPayout(payoutId, { actor = null, force = false, now = new Date() } = {}) {
  const payout = await Payout.findById(payoutId);
  if (!payout) throw ApiError.notFound('Payout not found', 'PAYOUT_NOT_FOUND');

  const group = await SusuGroup.findById(payout.groupId);
  if (!group) throw ApiError.notFound('Group not found', 'GROUP_NOT_FOUND');

  const verdict = await evaluateEligibility(payout, group, { now });
  if (!verdict.eligible && !force) {
    payout.status = verdict.code === 'NOT_DUE' ? PAYOUT_STATUS.SCHEDULED : PAYOUT_STATUS.ON_HOLD;
    payout.holdReason = verdict.reason;
    await payout.save();
    return { processed: false, verdict, payout };
  }
  if (verdict.code === 'ALREADY_PAID') {
    return { processed: false, verdict, payout };
  }

  const collected = verdict.collected || (await collectedForCycle(group._id, payout.cycle));
  const organization = group.organizationId ? await Organization.findById(group.organizationId) : null;
  const quote = await feeService.quotePayoutFee(collected.paidMinor, organization);

  payout.status = PAYOUT_STATUS.PROCESSING;
  payout.attempts += 1;
  await payout.save();

  let result;
  try {
    // The idempotency key is derived from the group and cycle, so a retried job
    // or a double-clicked admin button can never pay the same cycle twice.
    result = await ledger.post({
      userId: payout.recipientId,
      organizationId: group.organizationId,
      groupId: group._id,
      type: TRANSACTION_TYPE.PAYOUT,
      grossAmountMinor: collected.paidMinor,
      feeMinor: quote.feeMinor,
      paymentMethod: PAYMENT_METHOD.WALLET,
      description: `Payout from ${group.name} (cycle ${payout.cycle})`,
      metadata: { cycle: payout.cycle, payoutId: String(payout._id) },
      idempotencyKey: `payout:${group._id}:${payout.cycle}`,
    });
  } catch (err) {
    payout.status = PAYOUT_STATUS.FAILED;
    payout.failureReason = err.message;
    await payout.save();
    logger.error(`Payout ${payout._id} failed: ${err.message}`);
    // The rotation deliberately does NOT advance on failure.
    return { processed: false, error: err.message, payout };
  }

  payout.collectedAmountMinor = collected.paidMinor;
  payout.feeMinor = quote.feeMinor;
  payout.netAmountMinor = quote.netAmountMinor;
  payout.status = PAYOUT_STATUS.COMPLETED;
  payout.holdReason = null;
  payout.failureReason = null;
  payout.transactionId = result.transaction._id;
  payout.processedAt = new Date();
  payout.processedBy = actor?._id || null;
  await payout.save();

  await GroupMember.updateOne(
    { _id: payout.groupMemberId },
    {
      $set: { hasReceivedPayout: true, payoutReceivedAt: new Date() },
      $inc: { totalReceivedMinor: quote.netAmountMinor },
    },
  );

  await advanceGroupCycle(group);

  await notifications.notify({
    userId: payout.recipientId,
    organizationId: group.organizationId,
    ...notifications.templates.payoutCompleted(group, quote.netAmountMinor),
    dedupeKey: `payout-done:${payout._id}`,
    alsoEmail: true,
  });

  await audit.log({
    actor,
    action: 'payout.completed',
    entityType: 'Payout',
    entityId: payout._id,
    organizationId: group.organizationId,
    metadata: { cycle: payout.cycle, netAmountMinor: quote.netAmountMinor, recipientId: String(payout.recipientId) },
  });

  return { processed: true, payout, transaction: result.transaction };
}

/** Move the group to the next collecting cycle, completing it after the last one. */
async function advanceGroupCycle(group) {
  const completed = await Payout.countDocuments({ groupId: group._id, status: PAYOUT_STATUS.COMPLETED });
  const paidTotal = await Payout.aggregate([
    { $match: { groupId: group._id, status: PAYOUT_STATUS.COMPLETED } },
    { $group: { _id: null, total: { $sum: '$netAmountMinor' } } },
  ]);

  group.stats.completedPayouts = completed;
  group.stats.totalPaidOutMinor = paidTotal[0]?.total || 0;

  if (completed >= group.totalCycles) {
    group.status = GROUP_STATUS.COMPLETED;
    group.completedAt = new Date();
    group.currentCycle = group.totalCycles;
  } else {
    group.currentCycle = completed + 1;
  }
  await group.save();
  return group;
}

/** Cron entry point: run every payout whose date has arrived. */
async function runDuePayouts({ now = new Date() } = {}) {
  const due = await Payout.find({
    scheduledDate: { $lte: now },
    status: { $in: [PAYOUT_STATUS.SCHEDULED, PAYOUT_STATUS.READY, PAYOUT_STATUS.ON_HOLD] },
  }).sort({ scheduledDate: 1, cycle: 1 });

  const results = { processed: 0, held: 0, failed: 0 };
  for (const payout of due) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const outcome = await processPayout(payout._id, { now });
      if (outcome.processed) results.processed += 1;
      else if (outcome.error) results.failed += 1;
      else results.held += 1;
    } catch (err) {
      results.failed += 1;
      logger.error(`runDuePayouts error on ${payout._id}: ${err.message}`);
    }
  }
  return results;
}

async function upcomingForUser(userId, limit = 5) {
  return Payout.find({
    recipientId: userId,
    status: { $in: [PAYOUT_STATUS.SCHEDULED, PAYOUT_STATUS.READY, PAYOUT_STATUS.ON_HOLD] },
  })
    .sort({ scheduledDate: 1 })
    .limit(limit)
    .populate('groupId', 'name contributionAmountMinor contributionFrequency')
    .lean();
}

module.exports = {
  collectedForCycle,
  evaluateEligibility,
  processPayout,
  advanceGroupCycle,
  runDuePayouts,
  upcomingForUser,
};
