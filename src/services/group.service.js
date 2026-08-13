'use strict';

const {
  SusuGroup, GroupMember, Contribution, Payout, Organization, constants,
} = require('../models');
const {
  GROUP_STATUS, GROUP_MEMBER_STATUS, GROUP_ROLE, CONTRIBUTION_STATUS, PAYOUT_STATUS,
} = constants;
const dates = require('../utils/dates');
const money = require('../utils/money');
const ApiError = require('../utils/apiError');
const feeService = require('./fee.service');
const notifications = require('./notification.service');
const { getSettings } = require('./settings.service');

/**
 * Group lifecycle and schedule generation.
 *
 * Timing model for a group with frequency F and start date S:
 *   - cycle N (1-based) collects from S + (N-1)·F, which is its contribution due date
 *   - cycle N pays out at S + N·F, once the window has closed
 *   - the group runs exactly `memberLimit` cycles, one payout per member
 */

const cycleDueDate = (group, cycle) => dates.addPeriods(group.startDate, group.contributionFrequency, cycle - 1);
const cyclePayoutDate = (group, cycle) => dates.addPeriods(group.startDate, group.contributionFrequency, cycle);

async function createGroup({ actor, payload }) {
  const settings = await getSettings();
  const organization = actor.organizationId ? await Organization.findById(actor.organizationId) : null;

  const memberLimit = Number(payload.memberLimit);
  if (!Number.isInteger(memberLimit) || memberLimit < 2) {
    throw ApiError.badRequest('A SUSU group needs at least 2 members', 'INVALID_MEMBER_LIMIT');
  }
  if (memberLimit > settings.limits.maxGroupMembers) {
    throw ApiError.badRequest(
      `Groups are limited to ${settings.limits.maxGroupMembers} members`,
      'MEMBER_LIMIT_EXCEEDED',
    );
  }

  const contributionAmountMinor = money.toMinor(payload.contributionAmount);
  if (contributionAmountMinor < settings.limits.minContributionMinor) {
    throw ApiError.badRequest(
      `Minimum contribution is ${money.format(settings.limits.minContributionMinor)}`,
      'CONTRIBUTION_TOO_SMALL',
    );
  }
  if (contributionAmountMinor > settings.limits.maxContributionMinor) {
    throw ApiError.badRequest(
      `Maximum contribution is ${money.format(settings.limits.maxContributionMinor)}`,
      'CONTRIBUTION_TOO_LARGE',
    );
  }

  if (organization && organization.settings?.allowMemberGroupCreation === false
      && String(organization.adminId) !== String(actor._id)) {
    throw ApiError.forbidden('Your organization does not allow members to create groups', 'GROUP_CREATION_DISABLED');
  }

  const ownedGroups = await SusuGroup.countDocuments({
    organizerId: actor._id,
    status: { $in: [GROUP_STATUS.RECRUITING, GROUP_STATUS.ACTIVE] },
  });
  if (ownedGroups >= settings.limits.maxGroupsPerUser) {
    throw ApiError.badRequest('You have reached the maximum number of active groups', 'GROUP_QUOTA_REACHED');
  }

  if (organization) {
    const orgGroups = await SusuGroup.countDocuments({
      organizationId: organization._id,
      status: { $in: [GROUP_STATUS.RECRUITING, GROUP_STATUS.ACTIVE] },
    });
    if (orgGroups >= (organization.limits?.maxGroups ?? Infinity)) {
      throw ApiError.badRequest('Your organization plan group limit has been reached', 'ORG_GROUP_LIMIT');
    }
  }

  const startDate = dates.startOfDay(payload.startDate || new Date());
  const group = await SusuGroup.create({
    name: payload.name,
    description: payload.description || '',
    organizationId: actor.organizationId || null,
    organizerId: actor._id,
    inviteCode: await SusuGroup.generateInviteCode(payload.name),
    isPrivate: payload.isPrivate !== false,
    requiresApproval: payload.requiresApproval !== false,
    contributionAmountMinor,
    contributionFrequency: payload.contributionFrequency,
    memberLimit,
    totalCycles: memberLimit,
    startDate,
    endDate: dates.addPeriods(startDate, payload.contributionFrequency, memberLimit),
    payoutOrderMode: payload.payoutOrderMode === 'manual' ? 'manual' : 'automatic',
    status: GROUP_STATUS.RECRUITING,
    settings: {
      gracePeriodDays: payload.gracePeriodDays ?? settings.rules.defaultGracePeriodDays,
      lateFeeEnabled: payload.lateFeeEnabled ?? settings.rules.lateFeeEnabled,
      lateFeePercent: payload.lateFeePercent ?? settings.rules.lateFeePercent,
      requireFullPoolBeforePayout: payload.requireFullPoolBeforePayout !== false,
      allowPartialContributions: payload.allowPartialContributions !== false,
    },
  });

  // The organizer is member #1 by default.
  await GroupMember.create({
    groupId: group._id,
    userId: actor._id,
    organizationId: group.organizationId,
    role: GROUP_ROLE.ORGANIZER,
    status: GROUP_MEMBER_STATUS.ACTIVE,
    payoutPosition: 1,
    approvedAt: new Date(),
    approvedBy: actor._id,
  });
  group.stats.activeMembers = 1;
  await group.save();

  const creationFee = await feeService.groupCreationFeeMinor(organization);
  return { group, creationFeeMinor: creationFee };
}

/** A projection of the full contribution + payout timetable, computed on demand. */
async function buildSchedulePreview(group) {
  const cycles = [];
  for (let cycle = 1; cycle <= group.totalCycles; cycle += 1) {
    cycles.push({
      cycle,
      dueDate: cycleDueDate(group, cycle),
      payoutDate: cyclePayoutDate(group, cycle),
      expectedPoolMinor: group.contributionAmountMinor * group.memberLimit,
    });
  }
  return cycles;
}

async function requestToJoin({ group, user }) {
  if ([GROUP_STATUS.COMPLETED, GROUP_STATUS.CANCELLED].includes(group.status)) {
    throw ApiError.badRequest('This group is no longer accepting members', 'GROUP_CLOSED');
  }
  if (group.organizationId && String(group.organizationId) !== String(user.organizationId)) {
    throw ApiError.forbidden('This group belongs to another organization', 'CROSS_TENANT_DENIED');
  }

  const existing = await GroupMember.findOne({ groupId: group._id, userId: user._id });
  if (existing && [GROUP_MEMBER_STATUS.ACTIVE, GROUP_MEMBER_STATUS.PENDING].includes(existing.status)) {
    throw ApiError.conflict('You are already part of this group', 'ALREADY_MEMBER');
  }

  const activeCount = await GroupMember.countDocuments({
    groupId: group._id,
    status: GROUP_MEMBER_STATUS.ACTIVE,
  });
  if (activeCount >= group.memberLimit) {
    throw ApiError.badRequest('This group is full', 'GROUP_FULL');
  }

  const autoApprove = !group.requiresApproval;
  const status = autoApprove ? GROUP_MEMBER_STATUS.ACTIVE : GROUP_MEMBER_STATUS.PENDING;

  const member = existing
    ? Object.assign(existing, { status, payoutPosition: null, joinedAt: new Date(), exitedAt: null })
    : new GroupMember({
      groupId: group._id,
      userId: user._id,
      organizationId: group.organizationId,
      status,
    });

  if (autoApprove) {
    member.payoutPosition = await nextPayoutPosition(group._id);
    member.approvedAt = new Date();
  }
  await member.save();

  if (autoApprove) {
    await refreshMemberStats(group._id);
  } else {
    await notifications.notify({
      userId: group.organizerId,
      organizationId: group.organizationId,
      ...notifications.templates.groupJoinRequest(group, `${user.firstName} ${user.lastName}`),
      dedupeKey: `join:${group._id}:${user._id}`,
    });
  }

  return member;
}

async function nextPayoutPosition(groupId) {
  const last = await GroupMember.findOne({ groupId, payoutPosition: { $ne: null } })
    .sort({ payoutPosition: -1 })
    .lean();
  return (last?.payoutPosition || 0) + 1;
}

async function approveMember({ group, memberId, actor, approve }) {
  const member = await GroupMember.findOne({ _id: memberId, groupId: group._id });
  if (!member) throw ApiError.notFound('Membership request not found', 'MEMBER_NOT_FOUND');
  if (member.status !== GROUP_MEMBER_STATUS.PENDING) {
    throw ApiError.badRequest('This request has already been handled', 'ALREADY_HANDLED');
  }

  if (!approve) {
    member.status = GROUP_MEMBER_STATUS.REJECTED;
    await member.save();
    return member;
  }

  const activeCount = await GroupMember.countDocuments({ groupId: group._id, status: GROUP_MEMBER_STATUS.ACTIVE });
  if (activeCount >= group.memberLimit) throw ApiError.badRequest('This group is full', 'GROUP_FULL');

  member.status = GROUP_MEMBER_STATUS.ACTIVE;
  member.payoutPosition = member.payoutPosition || (await nextPayoutPosition(group._id));
  member.approvedAt = new Date();
  member.approvedBy = actor._id;
  await member.save();

  await refreshMemberStats(group._id);
  await notifications.notify({
    userId: member.userId,
    organizationId: group.organizationId,
    ...notifications.templates.groupMemberApproved(group),
    dedupeKey: `approved:${group._id}:${member.userId}`,
  });
  return member;
}

/** Organizer-defined rotation. Positions must be a permutation of 1..N. */
async function setPayoutOrder({ group, orderedMemberIds }) {
  if (group.status === GROUP_STATUS.ACTIVE) {
    throw ApiError.badRequest('The payout order is locked once a group starts', 'ORDER_LOCKED');
  }
  const members = await GroupMember.find({ groupId: group._id, status: GROUP_MEMBER_STATUS.ACTIVE });
  if (orderedMemberIds.length !== members.length) {
    throw ApiError.badRequest('The payout order must include every active member', 'INCOMPLETE_ORDER');
  }
  const known = new Set(members.map((m) => String(m._id)));
  if (!orderedMemberIds.every((id) => known.has(String(id)))) {
    throw ApiError.badRequest('The payout order contains an unknown member', 'UNKNOWN_MEMBER');
  }

  // Park positions out of range first so the unique index never sees a clash mid-swap.
  await GroupMember.updateMany({ groupId: group._id }, { $set: { payoutPosition: null } });
  await Promise.all(
    orderedMemberIds.map((id, index) =>
      GroupMember.updateOne({ _id: id, groupId: group._id }, { $set: { payoutPosition: index + 1 } })),
  );
  return GroupMember.find({ groupId: group._id, status: GROUP_MEMBER_STATUS.ACTIVE }).sort({ payoutPosition: 1 });
}

async function refreshMemberStats(groupId) {
  const activeMembers = await GroupMember.countDocuments({ groupId, status: GROUP_MEMBER_STATUS.ACTIVE });
  await SusuGroup.updateOne({ _id: groupId }, { $set: { 'stats.activeMembers': activeMembers } });
  return activeMembers;
}

/**
 * Materialise the whole timetable: one Contribution row per member per cycle and
 * one Payout row per cycle. Creating the rows up-front makes "missed" a real
 * state and lets the dashboard/calendar read the future without recomputing it.
 */
async function activateGroup(group) {
  if (group.status === GROUP_STATUS.ACTIVE) return group;

  const members = await GroupMember.find({ groupId: group._id, status: GROUP_MEMBER_STATUS.ACTIVE })
    .sort({ payoutPosition: 1 });
  if (members.length < 2) {
    throw ApiError.badRequest('A group needs at least 2 active members to start', 'NOT_ENOUGH_MEMBERS');
  }

  // The rotation only spans the members who actually joined.
  group.totalCycles = members.length;
  group.endDate = dates.addPeriods(group.startDate, group.contributionFrequency, members.length);
  group.stats.activeMembers = members.length;
  group.currentCycle = 1;
  group.status = GROUP_STATUS.ACTIVE;
  await group.save();

  const contributions = [];
  const payouts = [];

  for (let cycle = 1; cycle <= group.totalCycles; cycle += 1) {
    const dueDate = cycleDueDate(group, cycle);
    members.forEach((member) => {
      contributions.push({
        groupId: group._id,
        groupMemberId: member._id,
        userId: member.userId,
        organizationId: group.organizationId,
        cycle,
        dueDate,
        expectedAmountMinor: group.contributionAmountMinor,
        status: CONTRIBUTION_STATUS.PENDING,
      });
    });

    const recipient = members[cycle - 1];
    payouts.push({
      groupId: group._id,
      organizationId: group.organizationId,
      recipientId: recipient.userId,
      groupMemberId: recipient._id,
      cycle,
      scheduledDate: cyclePayoutDate(group, cycle),
      expectedAmountMinor: group.contributionAmountMinor * members.length,
      status: PAYOUT_STATUS.SCHEDULED,
    });
  }

  // `ordered: false` so a re-run after a partial failure fills only the gaps.
  await Contribution.insertMany(contributions, { ordered: false }).catch(swallowDuplicates);
  await Payout.insertMany(payouts, { ordered: false }).catch(swallowDuplicates);

  return group;
}

function swallowDuplicates(err) {
  if (err?.code === 11000 || err?.writeErrors?.every((e) => e.code === 11000)) return;
  throw err;
}

/** Everything the group detail page needs, computed server-side. */
async function getGroupOverview(group) {
  const [members, contributions, payouts] = await Promise.all([
    GroupMember.find({ groupId: group._id, status: { $ne: GROUP_MEMBER_STATUS.REJECTED } })
      .populate('userId', 'firstName lastName email avatarUrl')
      .sort({ payoutPosition: 1 })
      .lean(),
    Contribution.find({ groupId: group._id }).lean(),
    Payout.find({ groupId: group._id }).populate('recipientId', 'firstName lastName avatarUrl').sort({ cycle: 1 }).lean(),
  ]);

  // Pool figures are net of the platform fee withheld from each contribution.
  const poolValue = (c) => Math.max(0, c.paidAmountMinor - (c.platformFeeMinor || 0));
  const collectedMinor = contributions.reduce((sum, c) => sum + poolValue(c), 0);
  const currentCycleContributions = contributions.filter((c) => c.cycle === group.currentCycle);
  const currentPoolMinor = currentCycleContributions.reduce((sum, c) => sum + poolValue(c), 0);
  const nextPayout = payouts.find((p) => p.status !== 'completed') || null;

  return {
    group,
    members,
    payouts,
    nextPayout,
    totals: {
      collectedMinor,
      paidOutMinor: payouts.filter((p) => p.status === 'completed').reduce((s, p) => s + p.netAmountMinor, 0),
      currentPoolMinor,
      expectedPoolMinor: group.contributionAmountMinor * (group.stats?.activeMembers || 0),
      progressPercent: group.totalCycles
        ? Math.round((Math.min(group.currentCycle - 1, group.totalCycles) / group.totalCycles) * 100)
        : 0,
    },
  };
}

module.exports = {
  createGroup,
  buildSchedulePreview,
  requestToJoin,
  approveMember,
  setPayoutOrder,
  activateGroup,
  refreshMemberStats,
  getGroupOverview,
  cycleDueDate,
  cyclePayoutDate,
  nextPayoutPosition,
};
