'use strict';

const {
  SusuGroup, GroupMember, Contribution, Payout, Transaction, SavingsPlan, Notification, constants,
} = require('../models');
const {
  GROUP_MEMBER_STATUS, GROUP_STATUS, TRANSACTION_STATUS, TRANSACTION_TYPE, PAYOUT_STATUS,
  SAVINGS_STATUS, SAVINGS_TYPE,
} = constants;
const ledger = require('./ledger.service');
const payoutService = require('./payout.service');

/**
 * Assembles the dashboard from real ledger and schedule data. Every figure the
 * UI shows is computed here, server-side — the frontend only formats it.
 */
async function getUserDashboard(user) {
  const userId = user._id;

  const [wallet, memberships, savingsPlans, upcomingPayouts, recentTransactions, unreadCount] = await Promise.all([
    ledger.getOrCreateWallet(userId, user.organizationId),
    GroupMember.find({ userId, status: GROUP_MEMBER_STATUS.ACTIVE })
      .populate({
        path: 'groupId',
        select: 'name contributionAmountMinor contributionFrequency currentCycle totalCycles status stats memberLimit organizerId',
      })
      .lean(),
    SavingsPlan.find({ userId, status: { $in: [SAVINGS_STATUS.ACTIVE, SAVINGS_STATUS.MATURED] } }).lean(),
    payoutService.upcomingForUser(userId, 5),
    Transaction.find({ userId }).sort({ createdAt: -1 }).limit(8).populate('groupId', 'name').lean(),
    Notification.countDocuments({ userId, readAt: null }),
  ]);

  const activeMemberships = memberships.filter((m) => m.groupId);

  // Total saved = every successful contribution (groups + savings plans).
  const [savedRow] = await Transaction.aggregate([
    {
      $match: {
        userId,
        type: TRANSACTION_TYPE.CONTRIBUTION,
        status: TRANSACTION_STATUS.SUCCESSFUL,
      },
    },
    { $group: { _id: null, total: { $sum: '$netAmountMinor' } } },
  ]);

  const [receivedRow] = await Transaction.aggregate([
    {
      $match: { userId, type: TRANSACTION_TYPE.PAYOUT, status: TRANSACTION_STATUS.SUCCESSFUL },
    },
    { $group: { _id: null, total: { $sum: '$netAmountMinor' } } },
  ]);

  const groupCards = await Promise.all(activeMemberships.map(async (membership) => {
    const group = membership.groupId;
    const [poolRow] = await Contribution.aggregate([
      { $match: { groupId: group._id, cycle: group.currentCycle } },
      {
        $group: {
          _id: null,
          // Net of withheld fees — this is what the recipient will receive.
          paid: { $sum: { $subtract: ['$paidAmountMinor', { $ifNull: ['$platformFeeMinor', 0] }] } },
        },
      },
    ]);
    const nextPayout = await Payout.findOne({
      groupId: group._id,
      status: { $in: [PAYOUT_STATUS.SCHEDULED, PAYOUT_STATUS.READY, PAYOUT_STATUS.ON_HOLD] },
    })
      .sort({ cycle: 1 })
      .populate('recipientId', 'firstName lastName avatarUrl')
      .lean();

    return {
      groupId: group._id,
      name: group.name,
      role: membership.role,
      isOrganizer: String(group.organizerId) === String(userId),
      members: group.stats?.activeMembers || 0,
      memberLimit: group.memberLimit,
      contributionAmountMinor: group.contributionAmountMinor,
      contributionFrequency: group.contributionFrequency,
      currentCycle: group.currentCycle,
      totalCycles: group.totalCycles,
      progressPercent: group.totalCycles
        ? Math.min(100, Math.round(((group.currentCycle - 1) / group.totalCycles) * 100))
        : 0,
      currentPoolMinor: poolRow?.paid || 0,
      myBalanceMinor: membership.totalContributedMinor,
      outstandingMinor: membership.outstandingMinor,
      status: group.status,
      nextPayout: nextPayout
        ? {
          recipient: nextPayout.recipientId
            ? `${nextPayout.recipientId.firstName} ${nextPayout.recipientId.lastName}`
            : null,
          date: nextPayout.scheduledDate,
          expectedAmountMinor: nextPayout.expectedAmountMinor,
        }
        : null,
    };
  }));

  const rentPlan = savingsPlans.find((p) => p.type === SAVINGS_TYPE.RENT) || null;
  const nextPayoutForMe = upcomingPayouts[0] || null;

  return {
    summary: {
      totalSavedMinor: savedRow?.total || 0,
      totalReceivedMinor: receivedRow?.total || 0,
      activeGroups: activeMemberships.length,
      walletBalanceMinor: wallet.availableBalanceMinor,
      nextPayoutDate: nextPayoutForMe?.scheduledDate || null,
      nextPayoutAmountMinor: nextPayoutForMe?.expectedAmountMinor || null,
    },
    groups: groupCards,
    upcomingPayouts: upcomingPayouts.map((p) => ({
      payoutId: p._id,
      groupName: p.groupId?.name || 'Group',
      date: p.scheduledDate,
      expectedAmountMinor: p.expectedAmountMinor,
      cycle: p.cycle,
    })),
    savingsPlans: savingsPlans.map((plan) => ({
      planId: plan._id,
      name: plan.name,
      type: plan.type,
      currentAmountMinor: plan.currentAmountMinor,
      targetAmountMinor: plan.targetAmountMinor,
      percentComplete: plan.targetAmountMinor
        ? Math.min(100, Math.round((plan.currentAmountMinor / plan.targetAmountMinor) * 1000) / 10)
        : 0,
    })),
    rentPlan,
    recentTransactions: recentTransactions.map((t) => ({
      transactionId: t.transactionId,
      id: t._id,
      type: t.type,
      direction: t.direction,
      description: t.description || t.groupId?.name || t.type,
      amountMinor: t.grossAmountMinor,
      netAmountMinor: t.netAmountMinor,
      status: t.status,
      createdAt: t.createdAt,
    })),
    unreadNotifications: unreadCount,
  };
}

/** Organization admin view — scoped to a single tenant. */
async function getOrganizationDashboard(organizationId) {
  const [groups, memberCount, contributionRow, payoutRow] = await Promise.all([
    SusuGroup.find({ organizationId }).select('name status stats currentCycle totalCycles contributionAmountMinor').lean(),
    GroupMember.distinct('userId', { organizationId, status: GROUP_MEMBER_STATUS.ACTIVE }),
    Transaction.aggregate([
      { $match: { organizationId, type: TRANSACTION_TYPE.CONTRIBUTION, status: TRANSACTION_STATUS.SUCCESSFUL } },
      { $group: { _id: null, total: { $sum: '$netAmountMinor' }, count: { $sum: 1 } } },
    ]),
    Transaction.aggregate([
      { $match: { organizationId, type: TRANSACTION_TYPE.PAYOUT, status: TRANSACTION_STATUS.SUCCESSFUL } },
      { $group: { _id: null, total: { $sum: '$netAmountMinor' }, count: { $sum: 1 } } },
    ]),
  ]);

  return {
    summary: {
      totalGroups: groups.length,
      activeGroups: groups.filter((g) => g.status === GROUP_STATUS.ACTIVE).length,
      totalMembers: memberCount.length,
      totalSavedMinor: contributionRow[0]?.total || 0,
      totalPaidOutMinor: payoutRow[0]?.total || 0,
      contributionCount: contributionRow[0]?.count || 0,
    },
    groups,
  };
}

module.exports = { getUserDashboard, getOrganizationDashboard };
