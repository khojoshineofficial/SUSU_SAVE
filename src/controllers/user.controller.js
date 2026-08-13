'use strict';

const { User, Organization, SavingsPlan, GroupMember, constants } = require('../models');
const { GROUP_MEMBER_STATUS } = constants;
const ledger = require('../services/ledger.service');
const audit = require('../services/audit.service');
const ApiError = require('../utils/apiError');
const { asyncHandler, ok } = require('../utils/http');

const me = asyncHandler(async (req, res) => {
  const [wallet, organization, groupCount, savingsCount] = await Promise.all([
    ledger.getOrCreateWallet(req.user._id, req.user.organizationId),
    req.user.organizationId ? Organization.findById(req.user.organizationId).lean() : null,
    GroupMember.countDocuments({ userId: req.user._id, status: GROUP_MEMBER_STATUS.ACTIVE }),
    SavingsPlan.countDocuments({ userId: req.user._id }),
  ]);

  return ok(res, {
    user: req.user.toJSON(),
    organization,
    wallet,
    counts: { groups: groupCount, savingsPlans: savingsCount },
  });
});

const updateProfile = asyncHandler(async (req, res) => {
  // Explicit allowlist: role, status and organizationId are never client-settable.
  const allowed = ['firstName', 'lastName', 'phone', 'country', 'region', 'avatarUrl'];
  allowed.forEach((field) => {
    if (req.body[field] !== undefined) req.user[field] = req.body[field];
  });

  if (req.body.notificationPreferences) {
    const prefs = req.body.notificationPreferences;
    ['email', 'sms', 'push'].forEach((channel) => {
      if (typeof prefs[channel] === 'boolean') req.user.notificationPreferences[channel] = prefs[channel];
    });
  }
  if (typeof req.body.onboardingCompleted === 'boolean') {
    req.user.onboardingCompleted = req.body.onboardingCompleted;
  }

  await req.user.save();
  await audit.log({ req, action: 'user.profile_updated', entityType: 'User', entityId: req.user._id });
  return ok(res, { user: req.user.toJSON() }, 'Profile updated');
});

const changePassword = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select('+passwordHash');
  const matches = await user.verifyPassword(req.body.currentPassword);
  if (!matches) throw ApiError.badRequest('Your current password is incorrect', 'WRONG_PASSWORD');

  user.passwordHash = await User.hashPassword(req.body.newPassword);
  await user.save();

  await audit.log({ req, action: 'user.password_changed', entityType: 'User', entityId: user._id });
  return ok(res, {}, 'Password changed');
});

/**
 * Reading another user is deliberately narrow: only members of a group you
 * share, and only the fields needed to render them.
 */
const getById = asyncHandler(async (req, res) => {
  const target = await User.findById(req.params.id);
  if (!target) throw ApiError.notFound('User not found', 'USER_NOT_FOUND');

  const isSelf = String(target._id) === String(req.user._id);
  if (!isSelf && req.user.role !== constants.ROLES.SUPER_ADMIN) {
    const [mine, theirs] = await Promise.all([
      GroupMember.find({ userId: req.user._id, status: GROUP_MEMBER_STATUS.ACTIVE }).distinct('groupId'),
      GroupMember.find({ userId: target._id, status: GROUP_MEMBER_STATUS.ACTIVE }).distinct('groupId'),
    ]);
    const shares = theirs.some((g) => mine.some((m) => String(m) === String(g)));
    if (!shares) throw ApiError.forbidden();

    return ok(res, {
      user: {
        id: target._id,
        firstName: target.firstName,
        lastName: target.lastName,
        avatarUrl: target.avatarUrl,
      },
    });
  }

  return ok(res, { user: target.toJSON() });
});

module.exports = { me, updateProfile, changePassword, getById };
