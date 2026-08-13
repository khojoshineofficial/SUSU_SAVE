'use strict';

const {
  SusuGroup, GroupMember, Contribution, Payout, constants,
} = require('../models');
const { GROUP_MEMBER_STATUS, ROLES } = constants;
const groupService = require('../services/group.service');
const contributionService = require('../services/contribution.service');
const payoutService = require('../services/payout.service');
const feeService = require('../services/fee.service');
const audit = require('../services/audit.service');
const ApiError = require('../utils/apiError');
const money = require('../utils/money');
const { asyncHandler, ok, created, paginate, meta } = require('../utils/http');

/** Tenant scope applied to every group query for non-super-admins. */
const tenantFilter = (user) => (user.role === ROLES.SUPER_ADMIN
  ? {}
  : { $or: [{ organizationId: user.organizationId || null }, { organizationId: null }] });

const listMyGroups = asyncHandler(async (req, res) => {
  const memberships = await GroupMember.find({
    userId: req.user._id,
    status: { $in: [GROUP_MEMBER_STATUS.ACTIVE, GROUP_MEMBER_STATUS.PENDING] },
  })
    .populate('groupId')
    .lean();

  const groups = memberships
    .filter((m) => m.groupId)
    .map((m) => ({
      ...m.groupId,
      membership: {
        id: m._id,
        role: m.role,
        status: m.status,
        payoutPosition: m.payoutPosition,
        totalContributedMinor: m.totalContributedMinor,
        totalReceivedMinor: m.totalReceivedMinor,
        outstandingMinor: m.outstandingMinor,
        hasReceivedPayout: m.hasReceivedPayout,
      },
    }));

  return ok(res, { groups });
});

const createGroup = asyncHandler(async (req, res) => {
  const { group, creationFeeMinor } = await groupService.createGroup({ actor: req.user, payload: req.body });
  const schedule = await groupService.buildSchedulePreview(group);

  await audit.log({
    req,
    action: 'group.created',
    entityType: 'SusuGroup',
    entityId: group._id,
    metadata: { name: group.name, contributionAmountMinor: group.contributionAmountMinor },
  });

  return created(res, {
    group,
    creationFeeMinor,
    schedulePreview: schedule.slice(0, 12),
    inviteCode: group.inviteCode,
  }, 'SUSU group created');
});

/** Wizard step 8: everything the review screen shows, priced server-side. */
const previewGroup = asyncHandler(async (req, res) => {
  const memberLimit = Number(req.body.memberLimit);
  const contributionAmountMinor = money.toMinor(req.body.contributionAmount);
  const frequency = req.body.contributionFrequency;

  const stub = {
    startDate: new Date(req.body.startDate || Date.now()),
    contributionFrequency: frequency,
    totalCycles: memberLimit,
    memberLimit,
    contributionAmountMinor,
  };
  const schedule = await groupService.buildSchedulePreview(stub);
  const quote = await feeService.quoteSavingsFee(contributionAmountMinor, null);
  const creationFeeMinor = await feeService.groupCreationFeeMinor(null);

  return ok(res, {
    memberLimit,
    contributionAmountMinor,
    frequency,
    expectedPoolPerCycleMinor: contributionAmountMinor * memberLimit,
    totalExpectedMinor: contributionAmountMinor * memberLimit * memberLimit,
    durationLabel: `${memberLimit} ${frequency === 'daily' ? 'days' : 'weeks'}`,
    perContributionFee: quote,
    creationFeeMinor,
    schedule,
  });
});

const getGroup = asyncHandler(async (req, res) => {
  const overview = await groupService.getGroupOverview(req.group);
  return ok(res, overview);
});

const joinByCode = asyncHandler(async (req, res) => {
  const code = String(req.body.inviteCode || '').trim().toUpperCase();
  const group = await SusuGroup.findOne({ inviteCode: code, ...tenantFilter(req.user) });
  if (!group) throw ApiError.notFound('No group found for that invite code', 'INVALID_INVITE_CODE');

  const member = await groupService.requestToJoin({ group, user: req.user });
  await audit.log({
    req,
    action: 'group.join_requested',
    entityType: 'SusuGroup',
    entityId: group._id,
    metadata: { status: member.status },
  });

  return created(res, {
    group: { id: group._id, name: group.name, requiresApproval: group.requiresApproval },
    membership: member,
  }, member.status === GROUP_MEMBER_STATUS.ACTIVE
    ? 'You have joined the group'
    : 'Request sent — the organizer will review it');
});

/** Public-ish lookup so the join screen can preview a group before committing. */
const lookupByCode = asyncHandler(async (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  const group = await SusuGroup.findOne({ inviteCode: code, ...tenantFilter(req.user) })
    .select('name description contributionAmountMinor contributionFrequency memberLimit stats status requiresApproval startDate')
    .lean();
  if (!group) throw ApiError.notFound('No group found for that invite code', 'INVALID_INVITE_CODE');
  return ok(res, { group });
});

const listMembers = asyncHandler(async (req, res) => {
  const members = await GroupMember.find({ groupId: req.group._id })
    .populate('userId', 'firstName lastName email phone avatarUrl')
    .sort({ payoutPosition: 1, createdAt: 1 })
    .lean();
  return ok(res, { members });
});

const reviewMember = asyncHandler(async (req, res) => {
  const member = await groupService.approveMember({
    group: req.group,
    memberId: req.params.memberId,
    actor: req.user,
    approve: req.body.action === 'approve',
  });

  await audit.log({
    req,
    action: `group.member_${req.body.action}d`,
    entityType: 'GroupMember',
    entityId: member._id,
    metadata: { groupId: String(req.group._id) },
  });
  return ok(res, { member }, `Member ${req.body.action}d`);
});

const removeMember = asyncHandler(async (req, res) => {
  const member = await GroupMember.findOne({ _id: req.params.memberId, groupId: req.group._id });
  if (!member) throw ApiError.notFound('Member not found', 'MEMBER_NOT_FOUND');
  if (String(member.userId) === String(req.group.organizerId)) {
    throw ApiError.badRequest('The organizer cannot be removed from the group', 'CANNOT_REMOVE_ORGANIZER');
  }
  if (member.totalContributedMinor > 0 && !member.hasReceivedPayout) {
    throw ApiError.badRequest(
      'This member has contributed but not yet received a payout. Settle their balance first.',
      'MEMBER_HAS_BALANCE',
    );
  }

  member.status = GROUP_MEMBER_STATUS.REMOVED;
  member.payoutPosition = null;
  member.exitedAt = new Date();
  await member.save();
  await groupService.refreshMemberStats(req.group._id);

  await audit.log({ req, action: 'group.member_removed', entityType: 'GroupMember', entityId: member._id });
  return ok(res, { member }, 'Member removed');
});

const setPayoutOrder = asyncHandler(async (req, res) => {
  const members = await groupService.setPayoutOrder({
    group: req.group,
    orderedMemberIds: req.body.memberIds,
  });
  await audit.log({ req, action: 'group.payout_order_set', entityType: 'SusuGroup', entityId: req.group._id });
  return ok(res, { members }, 'Payout order updated');
});

const activateGroup = asyncHandler(async (req, res) => {
  const group = await groupService.activateGroup(req.group);
  await audit.log({ req, action: 'group.activated', entityType: 'SusuGroup', entityId: group._id });
  return ok(res, { group }, 'Group activated — the schedule is live');
});

const listContributions = asyncHandler(async (req, res) => {
  const { page, limit, skip } = paginate(req.query, { defaultLimit: 50 });
  const filter = { groupId: req.group._id };
  if (req.query.cycle) filter.cycle = Number(req.query.cycle);
  if (req.query.status) filter.status = req.query.status;
  // Members see only their own rows; organizers see the whole group.
  const isOrganizer = String(req.group.organizerId) === String(req.user._id)
    || req.user.role === ROLES.SUPER_ADMIN;
  if (!isOrganizer && req.query.scope !== 'all') filter.userId = req.user._id;

  const [rows, total] = await Promise.all([
    Contribution.find(filter)
      .populate('userId', 'firstName lastName avatarUrl')
      .sort({ cycle: 1, dueDate: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Contribution.countDocuments(filter),
  ]);

  return ok(res, { contributions: rows, meta: meta(page, limit, total) });
});

const contribute = asyncHandler(async (req, res) => {
  const result = await contributionService.contribute({
    actor: req.user,
    groupId: req.group._id,
    amount: req.body.amount,
    cycle: req.body.cycle,
    idempotencyKey: req.get('idempotency-key') || null,
  });

  return created(res, {
    contribution: result.contribution,
    transaction: result.transaction,
    replayed: result.replayed,
  }, result.replayed ? 'Contribution already recorded' : 'Contribution successful');
});

const listPayouts = asyncHandler(async (req, res) => {
  const payouts = await Payout.find({ groupId: req.group._id })
    .populate('recipientId', 'firstName lastName avatarUrl')
    .sort({ cycle: 1 })
    .lean();
  return ok(res, { payouts });
});

/** Organizer/admin trigger. Eligibility is still decided by the engine. */
const runPayout = asyncHandler(async (req, res) => {
  const payout = await Payout.findOne({ _id: req.params.payoutId, groupId: req.group._id });
  if (!payout) throw ApiError.notFound('Payout not found', 'PAYOUT_NOT_FOUND');

  const result = await payoutService.processPayout(payout._id, { actor: req.user });
  if (!result.processed) {
    return ok(res, result, result.verdict?.reason || result.error || 'Payout could not be processed yet');
  }
  return ok(res, result, 'Payout completed');
});

const getCalendar = asyncHandler(async (req, res) => {
  const now = new Date();
  const days = await contributionService.getCalendar({
    groupId: req.group._id,
    userId: req.query.userId && String(req.group.organizerId) === String(req.user._id)
      ? req.query.userId
      : req.user._id,
    year: Number(req.query.year) || now.getFullYear(),
    month: Number(req.query.month) || now.getMonth() + 1,
  });
  return ok(res, { days });
});

const getSchedule = asyncHandler(async (req, res) => {
  const schedule = await groupService.buildSchedulePreview(req.group);
  return ok(res, { schedule });
});

module.exports = {
  listMyGroups,
  createGroup,
  previewGroup,
  getGroup,
  joinByCode,
  lookupByCode,
  listMembers,
  reviewMember,
  removeMember,
  setPayoutOrder,
  activateGroup,
  listContributions,
  contribute,
  listPayouts,
  runPayout,
  getCalendar,
  getSchedule,
};
