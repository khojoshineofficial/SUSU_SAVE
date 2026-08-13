'use strict';

const {
  SusuGroup, GroupMember, Contribution, Organization, constants,
} = require('../models');
const { CONTRIBUTION_STATUS, GROUP_MEMBER_STATUS, GROUP_STATUS, TRANSACTION_TYPE, PAYMENT_METHOD } = constants;
const ledger = require('./ledger.service');
const feeService = require('./fee.service');
const notifications = require('./notification.service');
const money = require('../utils/money');
const dates = require('../utils/dates');
const ApiError = require('../utils/apiError');

/**
 * Contributions are always paid from the user's SUSU SAVE wallet. External
 * money reaches the wallet through PaymentService + settlement, so this module
 * never has to trust a payment gateway response — it only moves internal funds.
 */

/** The cycle a member should be paying right now, or null when fully paid up. */
async function findPayableContribution({ groupId, userId, cycle = null }) {
  const filter = {
    groupId,
    userId,
    status: { $in: [CONTRIBUTION_STATUS.PENDING, CONTRIBUTION_STATUS.PARTIAL, CONTRIBUTION_STATUS.MISSED, CONTRIBUTION_STATUS.LATE] },
  };
  if (cycle) filter.cycle = cycle;
  return Contribution.findOne(filter).sort({ cycle: 1 });
}

async function contribute({ actor, groupId, amount, cycle = null, idempotencyKey = null }) {
  const group = await SusuGroup.findById(groupId);
  if (!group) throw ApiError.notFound('Group not found', 'GROUP_NOT_FOUND');
  if (group.status !== GROUP_STATUS.ACTIVE) {
    throw ApiError.badRequest('This group is not collecting contributions yet', 'GROUP_NOT_ACTIVE');
  }

  const member = await GroupMember.findOne({
    groupId: group._id,
    userId: actor._id,
    status: GROUP_MEMBER_STATUS.ACTIVE,
  });
  if (!member) throw ApiError.forbidden('You are not an active member of this group', 'NOT_A_MEMBER');

  const contribution = await findPayableContribution({ groupId: group._id, userId: actor._id, cycle });
  if (!contribution) {
    throw ApiError.badRequest('You have no outstanding contribution for this group', 'NOTHING_DUE');
  }

  const outstandingMinor = Math.max(0, contribution.expectedAmountMinor - contribution.paidAmountMinor);
  const requestedMinor = amount === undefined || amount === null
    ? outstandingMinor
    : money.toMinor(amount);

  if (requestedMinor <= 0) throw ApiError.badRequest('Contribution amount must be positive', 'INVALID_AMOUNT');
  if (requestedMinor > outstandingMinor) {
    throw ApiError.badRequest(
      `Only ${money.format(outstandingMinor)} is outstanding for cycle ${contribution.cycle}`,
      'AMOUNT_EXCEEDS_DUE',
    );
  }
  if (requestedMinor < outstandingMinor && !group.settings.allowPartialContributions) {
    throw ApiError.badRequest('This group requires the full contribution amount', 'PARTIAL_NOT_ALLOWED');
  }

  const organization = group.organizationId ? await Organization.findById(group.organizationId) : null;
  const quote = await feeService.quoteSavingsFee(requestedMinor, organization);

  // Debits the wallet under a balance guard; throws INSUFFICIENT_BALANCE if short.
  const { transaction, replayed } = await ledger.post({
    userId: actor._id,
    organizationId: group.organizationId,
    groupId: group._id,
    type: TRANSACTION_TYPE.CONTRIBUTION,
    grossAmountMinor: requestedMinor,
    feeMinor: quote.feeMinor,
    paymentMethod: PAYMENT_METHOD.WALLET,
    description: `Contribution to ${group.name}`,
    metadata: { cycle: contribution.cycle, contributionId: String(contribution._id) },
    idempotencyKey,
  });

  if (replayed) return { contribution, transaction, replayed: true };

  return applyContributionPayment({
    group,
    member,
    contribution,
    transaction,
    paidMinor: requestedMinor,
    feeMinor: quote.feeMinor,
  });
}

/**
 * Advance a contribution row after a successful ledger debit.
 *
 * `paidMinor` is the gross amount the member handed over, which is what their
 * obligation is measured against — a member who pays the full contribution is
 * fully paid even though the platform withholds a fee. The pool receives
 * `paidMinor - feeMinor`.
 */
async function applyContributionPayment({ group, member, contribution, transaction, paidMinor, feeMinor = 0 }) {
  const now = new Date();
  const graceEnd = dates.addDays(contribution.dueDate, group.settings.gracePeriodDays || 0);

  contribution.paidAmountMinor = money.add(contribution.paidAmountMinor, paidMinor);
  contribution.platformFeeMinor = money.add(contribution.platformFeeMinor, feeMinor);
  contribution.transactionIds.push(transaction._id);
  contribution.paidAt = now;
  contribution.daysLate = Math.max(0, dates.daysBetween(graceEnd, now));

  const fullyPaid = contribution.paidAmountMinor >= contribution.expectedAmountMinor;
  if (fullyPaid) {
    contribution.status = contribution.daysLate > 0 ? CONTRIBUTION_STATUS.LATE : CONTRIBUTION_STATUS.PAID;
  } else {
    contribution.status = CONTRIBUTION_STATUS.PARTIAL;
  }
  await contribution.save();

  const outstanding = Math.max(0, contribution.expectedAmountMinor - contribution.paidAmountMinor);
  const poolValueMinor = money.subtract(paidMinor, feeMinor);

  await GroupMember.updateOne(
    { _id: member._id },
    {
      $inc: { totalContributedMinor: paidMinor },
      $set: { outstandingMinor: outstanding },
    },
  );
  await SusuGroup.updateOne({ _id: group._id }, { $inc: { 'stats.totalCollectedMinor': poolValueMinor } });

  await notifications.notify({
    userId: member.userId,
    organizationId: group.organizationId,
    ...notifications.templates.contributionSuccessful(group, paidMinor),
    dedupeKey: `contrib:${transaction._id}`,
  });

  return { contribution, transaction, replayed: false };
}

/**
 * Sweep overdue rows into `missed`. Idempotent and safe to re-run — it only
 * touches rows whose grace period has genuinely elapsed.
 */
async function markMissedContributions({ now = new Date() } = {}) {
  const groups = await SusuGroup.find({ status: GROUP_STATUS.ACTIVE }).lean();
  let marked = 0;

  for (const group of groups) {
    const cutoff = dates.addDays(now, -(group.settings?.gracePeriodDays || 0));
    // eslint-disable-next-line no-await-in-loop
    const overdue = await Contribution.find({
      groupId: group._id,
      dueDate: { $lt: cutoff },
      status: { $in: [CONTRIBUTION_STATUS.PENDING, CONTRIBUTION_STATUS.PARTIAL] },
    });

    for (const row of overdue) {
      row.status = CONTRIBUTION_STATUS.MISSED;
      row.daysLate = dates.daysBetween(row.dueDate, now);
      // eslint-disable-next-line no-await-in-loop
      await row.save();
      // eslint-disable-next-line no-await-in-loop
      await GroupMember.updateOne(
        { _id: row.groupMemberId },
        {
          $inc: { missedContributions: 1 },
          $set: { outstandingMinor: Math.max(0, row.expectedAmountMinor - row.paidAmountMinor) },
        },
      );
      // eslint-disable-next-line no-await-in-loop
      await notifications.notify({
        userId: row.userId,
        organizationId: row.organizationId,
        ...notifications.templates.contributionMissed(group, row.expectedAmountMinor - row.paidAmountMinor),
        dedupeKey: `missed:${row._id}`,
      });
      marked += 1;
    }
  }
  return { marked };
}

/** Calendar data: one entry per day for the requested month. */
async function getCalendar({ groupId, userId, year, month }) {
  const from = new Date(year, month - 1, 1);
  const to = new Date(year, month, 0, 23, 59, 59);
  const rows = await Contribution.find({
    groupId,
    userId,
    dueDate: { $gte: from, $lte: to },
  }).sort({ dueDate: 1 }).lean();

  return rows.map((row) => ({
    date: row.dueDate,
    cycle: row.cycle,
    expectedAmountMinor: row.expectedAmountMinor,
    paidAmountMinor: row.paidAmountMinor,
    status: row.status,
    contributionId: row._id,
  }));
}

module.exports = {
  contribute,
  findPayableContribution,
  markMissedContributions,
  getCalendar,
};
