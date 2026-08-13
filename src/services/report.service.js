'use strict';

const {
  User, Organization, SusuGroup, Transaction, Payout, Withdrawal, Contribution, constants,
} = require('../models');
const { TRANSACTION_STATUS, TRANSACTION_TYPE, ORG_STATUS, GROUP_STATUS, WITHDRAWAL_STATUS, ACCOUNT_STATUS, CONTRIBUTION_STATUS } = constants;

/** Fee types are the platform's revenue. */
const REVENUE_TYPES = [
  TRANSACTION_TYPE.REGISTRATION_FEE,
  TRANSACTION_TYPE.PLATFORM_FEE,
  TRANSACTION_TYPE.SAVINGS_FEE,
  TRANSACTION_TYPE.WITHDRAWAL_FEE,
  TRANSACTION_TYPE.GROUP_CREATION_FEE,
  TRANSACTION_TYPE.SUBSCRIPTION,
];

/** Platform-wide numbers for the Super Admin dashboard. */
async function platformOverview() {
  const [
    totalUsers, activeUsers, totalOrganizations, activeOrganizations,
    totalGroups, activeGroups, savings, payouts, pendingWithdrawals, feeRevenue, explicitRevenue,
  ] = await Promise.all([
    User.countDocuments({}),
    User.countDocuments({ status: ACCOUNT_STATUS.ACTIVE }),
    Organization.countDocuments({}),
    Organization.countDocuments({ status: ORG_STATUS.ACTIVE }),
    SusuGroup.countDocuments({}),
    SusuGroup.countDocuments({ status: GROUP_STATUS.ACTIVE }),
    sumTransactions({ type: TRANSACTION_TYPE.CONTRIBUTION }),
    sumTransactions({ type: TRANSACTION_TYPE.PAYOUT }),
    Withdrawal.countDocuments({ status: WITHDRAWAL_STATUS.PENDING }),
    // Fees withheld inside other transactions.
    Transaction.aggregate([
      { $match: { status: TRANSACTION_STATUS.SUCCESSFUL } },
      { $group: { _id: null, total: { $sum: '$feeMinor' } } },
    ]),
    sumTransactions({ type: { $in: REVENUE_TYPES } }),
  ]);

  const withheldFees = feeRevenue[0]?.total || 0;

  return {
    totalUsers,
    activeUsers,
    totalOrganizations,
    activeOrganizations,
    totalGroups,
    activeGroups,
    totalSavedMinor: savings.total,
    totalPaidOutMinor: payouts.total,
    pendingWithdrawals,
    platformRevenueMinor: withheldFees + explicitRevenue.total,
    revenueBreakdown: {
      withheldFeesMinor: withheldFees,
      directChargesMinor: explicitRevenue.total,
    },
  };
}

async function sumTransactions(match) {
  const [row] = await Transaction.aggregate([
    { $match: { status: TRANSACTION_STATUS.SUCCESSFUL, ...match } },
    { $group: { _id: null, total: { $sum: '$netAmountMinor' }, count: { $sum: 1 } } },
  ]);
  return { total: row?.total || 0, count: row?.count || 0 };
}

/** Time series for the admin charts, bucketed by day or month. */
async function timeSeries({ type, from, to, interval = 'day', organizationId = null }) {
  const match = {
    status: TRANSACTION_STATUS.SUCCESSFUL,
    createdAt: { $gte: new Date(from), $lte: new Date(to) },
  };
  if (type) match.type = type;
  if (organizationId) match.organizationId = organizationId;

  const format = interval === 'month' ? '%Y-%m' : '%Y-%m-%d';
  return Transaction.aggregate([
    { $match: match },
    {
      $group: {
        _id: { $dateToString: { format, date: '$createdAt' } },
        totalMinor: { $sum: '$netAmountMinor' },
        count: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
    { $project: { _id: 0, period: '$_id', totalMinor: 1, count: 1 } },
  ]);
}

/** Growth report: new users and organizations per period. */
async function growth({ from, to, interval = 'day' }) {
  const format = interval === 'month' ? '%Y-%m' : '%Y-%m-%d';
  const range = { createdAt: { $gte: new Date(from), $lte: new Date(to) } };
  const bucket = (Model) => Model.aggregate([
    { $match: range },
    { $group: { _id: { $dateToString: { format, date: '$createdAt' } }, count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
    { $project: { _id: 0, period: '$_id', count: 1 } },
  ]);
  const [users, organizations] = await Promise.all([bucket(User), bucket(Organization)]);
  return { users, organizations };
}

/** Per-group performance, respecting tenant scope when organizationId is given. */
async function groupPerformance({ organizationId = null } = {}) {
  const match = organizationId ? { organizationId } : {};
  const groups = await SusuGroup.find(match)
    .select('name status stats currentCycle totalCycles contributionAmountMinor organizationId')
    .lean();

  return Promise.all(groups.map(async (group) => {
    const [missed, onTime] = await Promise.all([
      Contribution.countDocuments({ groupId: group._id, status: CONTRIBUTION_STATUS.MISSED }),
      Contribution.countDocuments({ groupId: group._id, status: CONTRIBUTION_STATUS.PAID }),
    ]);
    const total = missed + onTime;
    return {
      ...group,
      missedContributions: missed,
      onTimeContributions: onTime,
      complianceRate: total ? Math.round((onTime / total) * 100) : null,
    };
  }));
}

/** Payout schedule report across the platform or one tenant. */
async function payoutSchedule({ organizationId = null, from = null, to = null } = {}) {
  const match = {};
  if (organizationId) match.organizationId = organizationId;
  if (from || to) {
    match.scheduledDate = {};
    if (from) match.scheduledDate.$gte = new Date(from);
    if (to) match.scheduledDate.$lte = new Date(to);
  }
  return Payout.find(match)
    .populate('recipientId', 'firstName lastName email')
    .populate('groupId', 'name')
    .sort({ scheduledDate: 1 })
    .lean();
}

/** Minimal, dependency-free CSV encoder for report exports. */
function toCsv(rows, columns) {
  const cols = columns || Object.keys(rows[0] || {});
  const escape = (value) => {
    if (value === null || value === undefined) return '';
    const text = value instanceof Date ? value.toISOString() : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [cols.join(',')];
  rows.forEach((row) => lines.push(cols.map((c) => escape(row[c])).join(',')));
  return lines.join('\n');
}

module.exports = { platformOverview, sumTransactions, timeSeries, growth, groupPerformance, payoutSchedule, toCsv };
