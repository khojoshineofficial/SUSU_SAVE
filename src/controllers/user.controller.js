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

/**
 * Change the sign-in username. Staff are provisioned with one and can rotate it
 * whenever they like; the current password is required so a hijacked session
 * cannot quietly rename the account and lock the owner out.
 */
const changeUsername = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select('+passwordHash');

  const matches = await user.verifyPassword(req.body.currentPassword);
  if (!matches) throw ApiError.badRequest('Your current password is incorrect', 'WRONG_PASSWORD');

  let username;
  try {
    username = User.normaliseUsername(req.body.username);
  } catch (err) {
    throw ApiError.badRequest(err.message, 'INVALID_USERNAME');
  }

  const taken = await User.findOne({ username, _id: { $ne: user._id } });
  if (taken) throw ApiError.conflict('That username is already taken', 'USERNAME_TAKEN');

  const previous = user.username || null;
  user.username = username;
  await user.save();

  await audit.log({
    req,
    action: 'user.username_changed',
    entityType: 'User',
    entityId: user._id,
    metadata: { from: previous, to: username },
  });
  return ok(res, { user: user.toJSON() }, 'Username updated');
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

module.exports = { me, updateProfile, changeUsername, changePassword, getById };
