'use strict';

const {
  User, Organization, SusuGroup, Transaction, Withdrawal, Payout, AuditLog, Payment, Plan, constants,
} = require('../models');
const { ACCOUNT_STATUS, ORG_STATUS, ROLES } = constants;
const reportService = require('../services/report.service');
const withdrawalService = require('../services/withdrawal.service');
const payoutService = require('../services/payout.service');
const ledger = require('../services/ledger.service');
const settingsService = require('../services/settings.service');
const audit = require('../services/audit.service');
const ApiError = require('../utils/apiError');
const ids = require('../utils/ids');
const { asyncHandler, ok, created, paginate, meta } = require('../utils/http');

const escapeRx = (term) => new RegExp(String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

/* --------------------------------- overview ---------------------------------- */

const overview = asyncHandler(async (req, res) => {
  const data = await reportService.platformOverview();
  return ok(res, data);
});

const charts = asyncHandler(async (req, res) => {
  const to = req.query.to ? new Date(req.query.to) : new Date();
  const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const interval = req.query.interval === 'month' ? 'month' : 'day';

  const [savings, payouts, growth] = await Promise.all([
    reportService.timeSeries({ type: constants.TRANSACTION_TYPE.CONTRIBUTION, from, to, interval }),
    reportService.timeSeries({ type: constants.TRANSACTION_TYPE.PAYOUT, from, to, interval }),
    reportService.growth({ from, to, interval }),
  ]);
  return ok(res, { savings, payouts, growth, range: { from, to, interval } });
});

/* ----------------------------------- users ----------------------------------- */

const listUsers = asyncHandler(async (req, res) => {
  const { page, limit, skip } = paginate(req.query, { defaultLimit: 25 });
  const filter = {};
  if (req.query.q) {
    const rx = escapeRx(req.query.q);
    filter.$or = [{ firstName: rx }, { lastName: rx }, { email: rx }, { phone: rx }];
  }
  if (req.query.status) filter.status = req.query.status;
  if (req.query.role) filter.role = req.query.role;
  if (req.query.organizationId) filter.organizationId = req.query.organizationId;

  const [users, total] = await Promise.all([
    User.find(filter).populate('organizationId', 'name').sort({ createdAt: -1 }).skip(skip).limit(limit),
    User.countDocuments(filter),
  ]);

  return ok(res, { users: users.map((u) => u.toJSON()), meta: meta(page, limit, total) });
});

const getUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id).populate('organizationId', 'name');
  if (!user) throw ApiError.notFound('User not found', 'USER_NOT_FOUND');

  const [wallet, transactions] = await Promise.all([
    ledger.getOrCreateWallet(user._id, user.organizationId),
    Transaction.find({ userId: user._id }).sort({ createdAt: -1 }).limit(25).lean(),
  ]);
  return ok(res, { user: user.toJSON(), wallet, transactions });
});

const setUserStatus = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) throw ApiError.notFound('User not found', 'USER_NOT_FOUND');
  if (String(user._id) === String(req.user._id)) {
    throw ApiError.badRequest('You cannot change your own account status', 'SELF_STATUS_CHANGE');
  }

  const status = req.body.status;
  if (!Object.values(ACCOUNT_STATUS).includes(status)) {
    throw ApiError.badRequest('Unknown account status', 'INVALID_STATUS');
  }
  user.status = status;
  await user.save();

  await audit.log({
    req,
    action: 'admin.user_status_changed',
    entityType: 'User',
    entityId: user._id,
    metadata: { status, reason: req.body.reason || null },
  });
  return ok(res, { user: user.toJSON() }, 'User status updated');
});

/** Issues a reset token rather than setting a password on the user's behalf. */
const resetUserPassword = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) throw ApiError.notFound('User not found', 'USER_NOT_FOUND');

  const rawToken = ids.token(24);
  user.passwordResetTokenHash = ids.hashToken(rawToken);
  user.passwordResetExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
  await user.save();

  await audit.log({ req, action: 'admin.password_reset_issued', entityType: 'User', entityId: user._id });
  return ok(res, {
    ...(process.env.NODE_ENV === 'production' ? {} : { resetToken: rawToken }),
  }, 'A password reset link has been issued for this user');
});

/* ------------------------------- organizations -------------------------------- */

const listOrganizations = asyncHandler(async (req, res) => {
  const { page, limit, skip } = paginate(req.query);
  const filter = {};
  if (req.query.q) filter.name = escapeRx(req.query.q);
  if (req.query.status) filter.status = req.query.status;

  const [organizations, total] = await Promise.all([
    Organization.find(filter).populate('adminId', 'firstName lastName email').sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Organization.countDocuments(filter),
  ]);

  const enriched = await Promise.all(organizations.map(async (org) => {
    const [members, groups, saved] = await Promise.all([
      User.countDocuments({ organizationId: org._id }),
      SusuGroup.countDocuments({ organizationId: org._id }),
      reportService.sumTransactions({ organizationId: org._id, type: constants.TRANSACTION_TYPE.CONTRIBUTION }),
    ]);
    return { ...org, memberCount: members, groupCount: groups, totalSavedMinor: saved.total };
  }));

  return ok(res, { organizations: enriched, meta: meta(page, limit, total) });
});

const setOrganizationStatus = asyncHandler(async (req, res) => {
  const organization = await Organization.findById(req.params.id);
  if (!organization) throw ApiError.notFound('Organization not found', 'ORG_NOT_FOUND');

  const status = req.body.status;
  if (!Object.values(ORG_STATUS).includes(status)) {
    throw ApiError.badRequest('Unknown organization status', 'INVALID_STATUS');
  }
  organization.status = status;
  organization.suspendedAt = status === ORG_STATUS.SUSPENDED ? new Date() : null;
  organization.suspensionReason = status === ORG_STATUS.SUSPENDED ? (req.body.reason || null) : null;
  await organization.save();

  // Suspending a tenant suspends the people inside it.
  if (status === ORG_STATUS.SUSPENDED) {
    await User.updateMany(
      { organizationId: organization._id, status: ACCOUNT_STATUS.ACTIVE },
      { $set: { status: ACCOUNT_STATUS.SUSPENDED } },
    );
  }

  await audit.log({
    req,
    action: 'admin.organization_status_changed',
    entityType: 'Organization',
    entityId: organization._id,
    metadata: { status },
  });
  return ok(res, { organization }, 'Organization status updated');
});

const updateOrganizationPlan = asyncHandler(async (req, res) => {
  const organization = await Organization.findById(req.params.id);
  if (!organization) throw ApiError.notFound('Organization not found', 'ORG_NOT_FOUND');

  const plan = await Plan.findOne({ code: String(req.body.planCode).toLowerCase() });
  if (!plan) throw ApiError.notFound('Plan not found', 'PLAN_NOT_FOUND');

  organization.planCode = plan.code;
  organization.limits = { maxMembers: plan.maxMembers, maxGroups: plan.maxGroups };
  await organization.save();

  await audit.log({
    req,
    action: 'admin.organization_plan_changed',
    entityType: 'Organization',
    entityId: organization._id,
    metadata: { planCode: plan.code },
  });
  return ok(res, { organization }, 'Plan updated');
});

/* ---------------------------------- groups ----------------------------------- */

const listGroups = asyncHandler(async (req, res) => {
  const { page, limit, skip } = paginate(req.query);
  const filter = {};
  if (req.query.q) filter.name = escapeRx(req.query.q);
  if (req.query.status) filter.status = req.query.status;
  if (req.query.organizationId) filter.organizationId = req.query.organizationId;

  const [groups, total] = await Promise.all([
    SusuGroup.find(filter)
      .populate('organizerId', 'firstName lastName email')
      .populate('organizationId', 'name')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    SusuGroup.countDocuments(filter),
  ]);
  return ok(res, { groups, meta: meta(page, limit, total) });
});

/* -------------------------------- transactions -------------------------------- */

const listTransactions = asyncHandler(async (req, res) => {
  const { page, limit, skip } = paginate(req.query, { defaultLimit: 50 });
  const filter = {};
  ['type', 'status', 'organizationId', 'groupId', 'userId'].forEach((key) => {
    if (req.query[key]) filter[key] = req.query[key];
  });
  if (req.query.from || req.query.to) {
    filter.createdAt = {};
    if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
    if (req.query.to) filter.createdAt.$lte = new Date(req.query.to);
  }

  const [transactions, total] = await Promise.all([
    Transaction.find(filter)
      .populate('userId', 'firstName lastName email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Transaction.countDocuments(filter),
  ]);

  if (req.query.format === 'csv') {
    const csv = reportService.toCsv(
      transactions.map((t) => ({
        transactionId: t.transactionId,
        date: t.createdAt,
        user: t.userId ? `${t.userId.firstName} ${t.userId.lastName}` : '',
        type: t.type,
        direction: t.direction,
        gross: t.grossAmountMinor / 100,
        fee: t.feeMinor / 100,
        net: t.netAmountMinor / 100,
        status: t.status,
      })),
    );
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="transactions.csv"');
    return res.send(csv);
  }

  return ok(res, { transactions, meta: meta(page, limit, total) });
});


/* ----------------------------- payment analysis ----------------------------- */

/**
 * The money view an admin works from: what is flowing, through which method,
 * what is stuck, and who is moving the most. Everything is aggregated in the
 * database rather than pulled into memory, so it stays fast as the ledger grows.
 */
const paymentAnalysis = asyncHandler(async (req, res) => {
  const to = req.query.to ? new Date(req.query.to) : new Date();
  const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const range = { createdAt: { $gte: from, $lte: to } };

  const [byMethod, byStatus, byType, daily, topUsers, pendingWithdrawals, failedPayments, settlement] =
    await Promise.all([
      Transaction.aggregate([
        { $match: { ...range, status: constants.TRANSACTION_STATUS.SUCCESSFUL } },
        { $group: { _id: '$paymentMethod', totalMinor: { $sum: '$grossAmountMinor' }, count: { $sum: 1 } } },
        { $sort: { totalMinor: -1 } },
      ]),
      Transaction.aggregate([
        { $match: range },
        { $group: { _id: '$status', totalMinor: { $sum: '$grossAmountMinor' }, count: { $sum: 1 } } },
      ]),
      Transaction.aggregate([
        { $match: { ...range, status: constants.TRANSACTION_STATUS.SUCCESSFUL } },
        {
          $group: {
            _id: '$type',
            totalMinor: { $sum: '$grossAmountMinor' },
            feesMinor: { $sum: '$feeMinor' },
            count: { $sum: 1 },
          },
        },
        { $sort: { totalMinor: -1 } },
      ]),
      Transaction.aggregate([
        { $match: { ...range, status: constants.TRANSACTION_STATUS.SUCCESSFUL } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            totalMinor: { $sum: '$grossAmountMinor' },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
        { $project: { _id: 0, period: '$_id', totalMinor: 1, count: 1 } },
      ]),
      Transaction.aggregate([
        { $match: { ...range, status: constants.TRANSACTION_STATUS.SUCCESSFUL } },
        {
          $group: {
            _id: '$userId',
            totalMinor: { $sum: '$grossAmountMinor' },
            feesMinor: { $sum: '$feeMinor' },
            count: { $sum: 1 },
          },
        },
        { $sort: { totalMinor: -1 } },
        { $limit: 10 },
      ]),
      Withdrawal.countDocuments({ status: constants.WITHDRAWAL_STATUS.PENDING }),
      Payment.countDocuments({ ...range, status: constants.TRANSACTION_STATUS.FAILED }),
      // Provider payments that never settled — the ones worth chasing.
      Payment.aggregate([
        { $match: { ...range } },
        { $group: { _id: '$status', count: { $sum: 1 }, totalMinor: { $sum: '$amountMinor' } } },
      ]),
    ]);

  const users = await User.find({ _id: { $in: topUsers.map((u) => u._id) } })
    .select('firstName lastName email')
    .lean();
  const nameOf = new Map(users.map((u) => [String(u._id), u]));

  return ok(res, {
    range: { from, to },
    byMethod,
    byStatus,
    byType,
    daily,
    settlement,
    alerts: { pendingWithdrawals, failedPayments },
    topUsers: topUsers.map((row) => ({
      userId: row._id,
      name: nameOf.get(String(row._id))
        ? `${nameOf.get(String(row._id)).firstName} ${nameOf.get(String(row._id)).lastName}`
        : 'Unknown',
      email: nameOf.get(String(row._id))?.email || null,
      totalMinor: row.totalMinor,
      feesMinor: row.feesMinor,
      count: row.count,
    })),
  });
});

/**
 * The record of payment decisions: who approved or rejected what, and when.
 * Read from the immutable audit log, so it cannot be edited after the fact.
 */
const paymentRecords = asyncHandler(async (req, res) => {
  const { page, limit, skip } = paginate(req.query, { defaultLimit: 50 });

  const filter = {
    action: { $in: ['withdrawal.completed', 'withdrawal.rejected', 'withdrawal.auto_completed', 'payout.completed', 'payment.settled'] },
  };
  // `mine=true` narrows it to the decisions this admin made themselves.
  if (req.query.mine === 'true') filter.actorId = req.user._id;

  const [logs, total] = await Promise.all([
    AuditLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    AuditLog.countDocuments(filter),
  ]);

  return ok(res, { records: logs, meta: meta(page, limit, total) });
});

/* --------------------------------- withdrawals -------------------------------- */

const listWithdrawals = asyncHandler(async (req, res) => {
  const { page, limit, skip } = paginate(req.query);
  const filter = {};
  if (req.query.status) filter.status = req.query.status;

  const [withdrawals, total] = await Promise.all([
    Withdrawal.find(filter).populate('userId', 'firstName lastName email phone').sort({ createdAt: -1 }).skip(skip).limit(limit),
    Withdrawal.countDocuments(filter),
  ]);
  return ok(res, { withdrawals: withdrawals.map((w) => w.toJSON()), meta: meta(page, limit, total) });
});

const approveWithdrawal = asyncHandler(async (req, res) => {
  const result = await withdrawalService.processWithdrawal(req.params.id, { actor: req.user });
  return ok(res, result, result.completed ? 'Withdrawal completed' : 'Withdrawal could not be completed');
});

const rejectWithdrawal = asyncHandler(async (req, res) => {
  const withdrawal = await withdrawalService.rejectWithdrawal(req.params.id, {
    actor: req.user,
    note: req.body.note,
  });
  return ok(res, { withdrawal: withdrawal.toJSON() }, 'Withdrawal rejected and funds returned');
});

/* ----------------------------------- payouts ---------------------------------- */

const listPayouts = asyncHandler(async (req, res) => {
  const payouts = await reportService.payoutSchedule({
    organizationId: req.query.organizationId || null,
    from: req.query.from,
    to: req.query.to,
  });
  return ok(res, { payouts });
});

const runPayout = asyncHandler(async (req, res) => {
  const result = await payoutService.processPayout(req.params.id, {
    actor: req.user,
    force: req.body.force === true,
  });
  return ok(res, result, result.processed ? 'Payout completed' : 'Payout not processed');
});

const runDuePayouts = asyncHandler(async (req, res) => {
  const results = await payoutService.runDuePayouts();
  await audit.log({ req, action: 'admin.payouts_run', entityType: 'Payout', metadata: results });
  return ok(res, results, 'Payout run finished');
});

/* ---------------------------------- settings ---------------------------------- */

const getSettings = asyncHandler(async (req, res) => {
  const settings = await settingsService.getSettings({ fresh: true });
  return ok(res, { settings });
});

const updateSettings = asyncHandler(async (req, res) => {
  const settings = await settingsService.updateSettings(req.body, req.user._id);
  await audit.log({
    req,
    action: 'admin.settings_updated',
    entityType: 'SystemSetting',
    entityId: settings._id,
    metadata: { keys: Object.keys(req.body) },
  });
  return ok(res, { settings }, 'Platform settings updated');
});

/* ----------------------------------- plans ----------------------------------- */

const listPlans = asyncHandler(async (req, res) => {
  const plans = await Plan.find({}).sort({ sortOrder: 1 }).lean();
  return ok(res, { plans });
});

const upsertPlan = asyncHandler(async (req, res) => {
  const code = String(req.body.code).toLowerCase();
  const plan = await Plan.findOneAndUpdate(
    { code },
    {
      $set: {
        code,
        name: req.body.name,
        description: req.body.description || '',
        monthlyPriceMinor: req.body.monthlyPriceMinor ?? 0,
        maxMembers: req.body.maxMembers ?? 25,
        maxGroups: req.body.maxGroups ?? 3,
        features: req.body.features || [],
        isActive: req.body.isActive !== false,
        sortOrder: req.body.sortOrder ?? 0,
      },
    },
    { new: true, upsert: true },
  );
  await audit.log({ req, action: 'admin.plan_upserted', entityType: 'Plan', entityId: plan._id });
  return created(res, { plan }, 'Plan saved');
});

/* --------------------------------- audit logs --------------------------------- */

const listAuditLogs = asyncHandler(async (req, res) => {
  const { page, limit, skip } = paginate(req.query, { defaultLimit: 50 });
  const filter = {};
  if (req.query.action) filter.action = escapeRx(req.query.action);
  if (req.query.entityType) filter.entityType = req.query.entityType;
  if (req.query.actorId) filter.actorId = req.query.actorId;

  const [logs, total] = await Promise.all([
    AuditLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    AuditLog.countDocuments(filter),
  ]);
  return ok(res, { logs, meta: meta(page, limit, total) });
});

/* ----------------------------------- reports ---------------------------------- */

const reports = asyncHandler(async (req, res) => {
  const kind = req.params.kind;
  const organizationId = req.query.organizationId || null;

  switch (kind) {
    case 'group-performance':
      return ok(res, { rows: await reportService.groupPerformance({ organizationId }) });
    case 'payout-schedule':
      return ok(res, { rows: await reportService.payoutSchedule({ organizationId, from: req.query.from, to: req.query.to }) });
    case 'revenue': {
      const overviewData = await reportService.platformOverview();
      return ok(res, { rows: [overviewData] });
    }
    default:
      throw ApiError.badRequest(`Unknown report: ${kind}`, 'UNKNOWN_REPORT');
  }
});

/** Rebuild a wallet from the ledger — the drift check for the projection. */
const recomputeWallet = asyncHandler(async (req, res) => {
  const wallet = await ledger.recompute(req.params.id);
  await audit.log({ req, action: 'admin.wallet_recomputed', entityType: 'Wallet', entityId: wallet._id });
  return ok(res, { wallet }, 'Wallet recomputed from the ledger');
});

/** Promote a user to super admin. Guarded so it cannot be self-applied. */
const setUserRole = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) throw ApiError.notFound('User not found', 'USER_NOT_FOUND');
  if (!Object.values(ROLES).includes(req.body.role)) {
    throw ApiError.badRequest('Unknown role', 'INVALID_ROLE');
  }
  if (String(user._id) === String(req.user._id)) {
    throw ApiError.badRequest('You cannot change your own role', 'SELF_ROLE_CHANGE');
  }

  user.role = req.body.role;
  await user.save();
  await audit.log({
    req,
    action: 'admin.user_role_changed',
    entityType: 'User',
    entityId: user._id,
    metadata: { role: req.body.role },
  });
  return ok(res, { user: user.toJSON() }, 'Role updated');
});

module.exports = {
  overview,
  paymentAnalysis,
  paymentRecords,
  charts,
  listUsers,
  getUser,
  setUserStatus,
  setUserRole,
  resetUserPassword,
  listOrganizations,
  setOrganizationStatus,
  updateOrganizationPlan,
  listGroups,
  listTransactions,
  listWithdrawals,
  approveWithdrawal,
  rejectWithdrawal,
  listPayouts,
  runPayout,
  runDuePayouts,
  getSettings,
  updateSettings,
  listPlans,
  upsertPlan,
  listAuditLogs,
  reports,
  recomputeWallet,
};
