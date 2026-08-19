'use strict';

const {
  Organization, User, SusuGroup, GroupMember, Transaction, Invitation, Wallet, constants,
} = require('../models');
const { ROLES, ACCOUNT_STATUS, GROUP_MEMBER_STATUS } = constants;
const dashboardService = require('../services/dashboard.service');
const reportService = require('../services/report.service');
const email = require('../services/email.service');
const audit = require('../services/audit.service');
const collectors = require('../services/collector.service');
const ids = require('../utils/ids');
const ApiError = require('../utils/apiError');
const { asyncHandler, ok, created, paginate, meta } = require('../utils/http');

/** Org admins act only on their own organization; super admins may target any. */
async function resolveOrganization(req) {
  const id = req.params.id || req.user.organizationId;
  if (!id) throw ApiError.badRequest('No organization in context', 'NO_ORGANIZATION');
  if (req.user.role !== ROLES.SUPER_ADMIN && String(id) !== String(req.user.organizationId)) {
    throw ApiError.forbidden('This organization belongs to another tenant', 'CROSS_TENANT_DENIED');
  }
  const organization = await Organization.findById(id);
  if (!organization) throw ApiError.notFound('Organization not found', 'ORG_NOT_FOUND');
  return organization;
}

const getOrganization = asyncHandler(async (req, res) => {
  const organization = await resolveOrganization(req);
  const [memberCount, groupCount] = await Promise.all([
    User.countDocuments({ organizationId: organization._id }),
    SusuGroup.countDocuments({ organizationId: organization._id }),
  ]);
  return ok(res, { organization, counts: { members: memberCount, groups: groupCount } });
});

const updateOrganization = asyncHandler(async (req, res) => {
  const organization = await resolveOrganization(req);
  ['description', 'contactEmail', 'contactPhone', 'address', 'region', 'logoUrl'].forEach((field) => {
    if (req.body[field] !== undefined) organization[field] = req.body[field];
  });
  if (req.body.settings) {
    ['allowMemberGroupCreation', 'requireGroupApproval', 'allowPublicJoin'].forEach((key) => {
      if (typeof req.body.settings[key] === 'boolean') organization.settings[key] = req.body.settings[key];
    });
  }
  await organization.save();

  await audit.log({ req, action: 'organization.updated', entityType: 'Organization', entityId: organization._id });
  return ok(res, { organization }, 'Organization updated');
});

/**
 * Members, each with the balance the collector needs to see at a glance. The
 * wallet figures come from the wallet projection in one extra query rather than
 * one per member, so a collector with hundreds of customers still loads fast.
 */
const listMembers = asyncHandler(async (req, res) => {
  const organization = await resolveOrganization(req);
  const members = await User.find({ organizationId: organization._id })
    .select('firstName lastName email phone role status createdAt lastLoginAt avatarUrl')
    .sort({ createdAt: -1 })
    .lean();

  const wallets = await Wallet.find({ userId: { $in: members.map((m) => m._id) } })
    .select('userId availableBalanceMinor totalDepositedMinor totalWithdrawnMinor')
    .lean();
  const byUser = new Map(wallets.map((w) => [String(w.userId), w]));

  return ok(res, {
    members: members.map((m) => {
      const wallet = byUser.get(String(m._id));
      return {
        ...m,
        balanceMinor: wallet?.availableBalanceMinor || 0,
        totalDepositedMinor: wallet?.totalDepositedMinor || 0,
        totalWithdrawnMinor: wallet?.totalWithdrawnMinor || 0,
      };
    }),
  });
});

/* ------------------------------- join links -------------------------------- */

/**
 * The collector's public sign-up link. A GET mints the code on first use, so a
 * collector never has to think about "creating" one — they open the tab and the
 * link is there to share.
 */
const getJoinLink = asyncHandler(async (req, res) => {
  const organization = await resolveOrganization(req);
  const code = await collectors.ensureJoinCode(organization);

  const signups = await User.countDocuments({
    organizationId: organization._id,
    _id: { $ne: organization.adminId },
  });

  return ok(res, {
    joinCode: code,
    url: collectors.linkFor(code),
    enabled: organization.settings?.allowPublicJoin !== false,
    customers: signups,
    capacity: organization.limits?.maxMembers || null,
  });
});

/** Issues a new code. Every link already shared stops working immediately. */
const rotateJoinLink = asyncHandler(async (req, res) => {
  const organization = await resolveOrganization(req);
  const code = await collectors.regenerateJoinCode(organization);

  await audit.log({
    req,
    action: 'organization.join_link_rotated',
    entityType: 'Organization',
    entityId: organization._id,
    organizationId: organization._id,
  });

  return ok(res, { joinCode: code, url: collectors.linkFor(code) }, 'New sign-up link issued. The old one no longer works.');
});

const inviteMember = asyncHandler(async (req, res) => {
  const organization = await resolveOrganization(req);

  const memberCount = await User.countDocuments({ organizationId: organization._id });
  if (memberCount >= (organization.limits?.maxMembers ?? Infinity)) {
    throw ApiError.badRequest('Your plan member limit has been reached', 'ORG_MEMBER_LIMIT');
  }

  const rawToken = ids.token(24);
  const invitation = await Invitation.create({
    email: String(req.body.email).toLowerCase(),
    name: req.body.name || null,
    phone: req.body.phone || null,
    scope: 'organization',
    organizationId: organization._id,
    invitedBy: req.user._id,
    tokenHash: ids.hashToken(rawToken),
    expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
  });

  await email.sendInvitationEmail(invitation, rawToken, { label: organization.name });
  await audit.log({
    req,
    action: 'organization.member_invited',
    entityType: 'Invitation',
    entityId: invitation._id,
    organizationId: organization._id,
  });

  return created(res, {
    invitation,
    ...(process.env.NODE_ENV === 'production' ? {} : { inviteToken: rawToken }),
  }, 'Invitation sent');
});

const acceptInvitation = asyncHandler(async (req, res) => {
  const invitation = await Invitation.findOne({
    tokenHash: ids.hashToken(String(req.body.token)),
    status: 'pending',
    expiresAt: { $gt: new Date() },
  });
  if (!invitation) throw ApiError.badRequest('This invitation is invalid or has expired', 'INVALID_INVITATION');

  if (req.user.organizationId && String(req.user.organizationId) !== String(invitation.organizationId)) {
    throw ApiError.conflict('You already belong to another organization', 'ALREADY_IN_ORGANIZATION');
  }

  req.user.organizationId = invitation.organizationId;
  await req.user.save();

  invitation.status = 'accepted';
  invitation.acceptedAt = new Date();
  invitation.acceptedBy = req.user._id;
  await invitation.save();

  return ok(res, { user: req.user.toJSON() }, 'You have joined the organization');
});

const removeMember = asyncHandler(async (req, res) => {
  const organization = await resolveOrganization(req);
  const member = await User.findOne({ _id: req.params.memberId, organizationId: organization._id });
  if (!member) throw ApiError.notFound('Member not found', 'MEMBER_NOT_FOUND');
  if (String(member._id) === String(organization.adminId)) {
    throw ApiError.badRequest('The organization admin cannot be removed', 'CANNOT_REMOVE_ADMIN');
  }

  // The user keeps their account and ledger history — only the tenant link goes.
  member.organizationId = null;
  if (member.role === ROLES.ORG_ADMIN) member.role = ROLES.USER;
  await member.save();

  await audit.log({
    req,
    action: 'organization.member_removed',
    entityType: 'User',
    entityId: member._id,
    organizationId: organization._id,
  });
  return ok(res, {}, 'Member removed from organization');
});

const listGroups = asyncHandler(async (req, res) => {
  const organization = await resolveOrganization(req);
  const groups = await SusuGroup.find({ organizationId: organization._id })
    .populate('organizerId', 'firstName lastName email')
    .sort({ createdAt: -1 })
    .lean();
  return ok(res, { groups });
});

const suspendMember = asyncHandler(async (req, res) => {
  const organization = await resolveOrganization(req);
  const member = await User.findOne({ _id: req.params.memberId, organizationId: organization._id });
  if (!member) throw ApiError.notFound('Member not found', 'MEMBER_NOT_FOUND');

  member.status = req.body.suspend === false ? ACCOUNT_STATUS.ACTIVE : ACCOUNT_STATUS.SUSPENDED;
  await member.save();

  await audit.log({
    req,
    action: member.status === ACCOUNT_STATUS.SUSPENDED ? 'organization.member_suspended' : 'organization.member_activated',
    entityType: 'User',
    entityId: member._id,
    organizationId: organization._id,
  });
  return ok(res, { member: member.toJSON() }, 'Member status updated');
});


/* --------------------------------- dashboard -------------------------------- */

/**
 * Everything the organization console's overview needs, in one round trip.
 * Every query is filtered by organizationId — an admin of one tenant can never
 * see another's figures.
 */
const dashboard = asyncHandler(async (req, res) => {
  const organization = await resolveOrganization(req);
  const orgId = organization._id;

  const [data, memberCount, pendingMembers, recentTransactions, upcomingPayouts] = await Promise.all([
    dashboardService.getOrganizationDashboard(orgId),
    User.countDocuments({ organizationId: orgId }),
    User.countDocuments({ organizationId: orgId, status: ACCOUNT_STATUS.PENDING_PAYMENT }),
    Transaction.find({ organizationId: orgId })
      .populate('userId', 'firstName lastName')
      .sort({ createdAt: -1 })
      .limit(8)
      .lean(),
    reportService.payoutSchedule({ organizationId: orgId, from: new Date() }),
  ]);

  return ok(res, {
    organization,
    ...data,
    counts: {
      members: memberCount,
      pendingMembers,
      // Plan limits, so the console can warn before an invite is refused.
      maxMembers: organization.limits?.maxMembers ?? null,
      maxGroups: organization.limits?.maxGroups ?? null,
    },
    recentTransactions,
    upcomingPayouts: upcomingPayouts.slice(0, 6),
  });
});

/* ------------------------------- money & reports ----------------------------- */

const listTransactions = asyncHandler(async (req, res) => {
  const organization = await resolveOrganization(req);
  const { page, limit, skip } = paginate(req.query, { defaultLimit: 25 });

  const filter = { organizationId: organization._id };
  if (req.query.type) filter.type = req.query.type;
  if (req.query.status) filter.status = req.query.status;

  const [transactions, total] = await Promise.all([
    Transaction.find(filter)
      .populate('userId', 'firstName lastName email')
      .populate('groupId', 'name')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Transaction.countDocuments(filter),
  ]);

  if (req.query.format === 'csv') {
    const csv = reportService.toCsv(transactions.map((t) => ({
      transactionId: t.transactionId,
      date: t.createdAt,
      member: t.userId ? `${t.userId.firstName} ${t.userId.lastName}` : '',
      group: t.groupId?.name || '',
      type: t.type,
      gross: t.grossAmountMinor / 100,
      fee: t.feeMinor / 100,
      net: t.netAmountMinor / 100,
      status: t.status,
    })));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${organization.slug}-transactions.csv"`);
    return res.send(csv);
  }

  return ok(res, { transactions, meta: meta(page, limit, total) });
});

const listPayouts = asyncHandler(async (req, res) => {
  const organization = await resolveOrganization(req);
  const payouts = await reportService.payoutSchedule({
    organizationId: organization._id,
    from: req.query.from,
    to: req.query.to,
  });
  return ok(res, { payouts });
});

/** Per-group compliance: who is paying on time and who is falling behind. */
const performance = asyncHandler(async (req, res) => {
  const organization = await resolveOrganization(req);
  const [rows, memberIds] = await Promise.all([
    reportService.groupPerformance({ organizationId: organization._id }),
    GroupMember.find({ organizationId: organization._id, status: GROUP_MEMBER_STATUS.ACTIVE })
      .populate('userId', 'firstName lastName email')
      .lean(),
  ]);

  // Members carrying arrears, worst first — the list an admin actually acts on.
  const inArrears = memberIds
    .filter((m) => m.outstandingMinor > 0 || m.missedContributions > 0)
    .sort((a, b) => b.outstandingMinor - a.outstandingMinor)
    .slice(0, 25)
    .map((m) => ({
      name: m.userId ? `${m.userId.firstName} ${m.userId.lastName}` : 'Unknown',
      email: m.userId?.email || null,
      outstandingMinor: m.outstandingMinor,
      missedContributions: m.missedContributions,
      totalContributedMinor: m.totalContributedMinor,
    }));

  return ok(res, { groups: rows, inArrears });
});

module.exports = {
  dashboard,
  listTransactions,
  listPayouts,
  performance,
  getOrganization,
  updateOrganization,
  listMembers,
  getJoinLink,
  rotateJoinLink,
  inviteMember,
  acceptInvitation,
  removeMember,
  listGroups,
  suspendMember,
};
