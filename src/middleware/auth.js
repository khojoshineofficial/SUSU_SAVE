'use strict';

const { User, SusuGroup, GroupMember, constants } = require('../models');
const { ROLES, STAFF_ROLES, ACCOUNT_STATUS, GROUP_MEMBER_STATUS } = constants;
const tokens = require('../services/token.service');
const ApiError = require('../utils/apiError');
const { asyncHandler } = require('../utils/http');

/**
 * Authorization is enforced in layers, and every layer is server-side:
 *
 *   authenticate           — who are you
 *   requireActiveAccount   — may you transact
 *   requireRole            — what rank do you hold
 *   requireOrganization*   — tenant isolation
 *   requireGroup*          — per-resource membership
 *
 * No handler resolves an :id into a document without one of these first.
 */

const bearerFrom = (req) => {
  const header = req.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
};

const authenticate = asyncHandler(async (req, _res, next) => {
  const token = bearerFrom(req);
  if (!token) throw ApiError.unauthorized();

  const payload = tokens.verifyAccessToken(token);
  const user = await User.findById(payload.sub);
  if (!user) throw ApiError.unauthorized('Account no longer exists', 'USER_NOT_FOUND');
  if (user.status === ACCOUNT_STATUS.SUSPENDED) {
    throw ApiError.forbidden('This account has been suspended', 'ACCOUNT_SUSPENDED');
  }

  req.user = user;
  return next();
});

/** Attaches req.user when a token is present, but never rejects. */
const optionalAuth = asyncHandler(async (req, _res, next) => {
  const token = bearerFrom(req);
  if (!token) return next();
  try {
    const payload = tokens.verifyAccessToken(token);
    req.user = await User.findById(payload.sub);
  } catch {
    req.user = null;
  }
  return next();
});

/** Money movement requires a fully activated account. */
const requireActiveAccount = (req, _res, next) => {
  if (!req.user) return next(ApiError.unauthorized());
  if (req.user.status !== ACCOUNT_STATUS.ACTIVE) {
    return next(new ApiError(403, 'Complete your registration to use this feature', 'ACCOUNT_NOT_ACTIVE'));
  }
  return next();
};

const requireRole = (...roles) => (req, _res, next) => {
  if (!req.user) return next(ApiError.unauthorized());
  if (!roles.includes(req.user.role)) return next(ApiError.forbidden());
  return next();
};

const requireSuperAdmin = requireRole(ROLES.SUPER_ADMIN);

/**
 * Platform staff: an `admin` reviews payments, approves withdrawals and reads
 * the audit record. Anything that changes how the platform itself behaves —
 * fees, limits, plans, roles, maintenance mode — stays with the super admin.
 */
const requireStaff = requireRole(...STAFF_ROLES);

/**
 * Tenant isolation. A super admin may cross tenants; everyone else is pinned to
 * their own organizationId regardless of what the URL or body says.
 */
const requireOrganizationAccess = (paramName = 'orgId') => (req, _res, next) => {
  if (!req.user) return next(ApiError.unauthorized());
  if (STAFF_ROLES.includes(req.user.role)) return next();

  const requested = req.params[paramName] || req.body?.organizationId || req.query?.organizationId;
  if (!requested) return next();
  if (!req.user.organizationId || String(req.user.organizationId) !== String(requested)) {
    return next(ApiError.forbidden('This resource belongs to another organization', 'CROSS_TENANT_DENIED'));
  }
  return next();
};

/** Users may only ever address their own record, unless they are an admin. */
const requireSelfOrAdmin = (paramName = 'id') => (req, _res, next) => {
  if (!req.user) return next(ApiError.unauthorized());
  if (req.user.role === ROLES.SUPER_ADMIN) return next();
  if (String(req.user._id) !== String(req.params[paramName])) {
    return next(ApiError.forbidden());
  }
  return next();
};

/** Loads req.group and req.groupMember, enforcing both tenancy and membership. */
const requireGroupMember = asyncHandler(async (req, _res, next) => {
  const group = await SusuGroup.findById(req.params.groupId || req.params.id);
  if (!group) throw ApiError.notFound('Group not found', 'GROUP_NOT_FOUND');

  const isSuperAdmin = req.user.role === ROLES.SUPER_ADMIN;
  if (!isSuperAdmin && group.organizationId
      && String(group.organizationId) !== String(req.user.organizationId || '')) {
    throw ApiError.forbidden('This group belongs to another organization', 'CROSS_TENANT_DENIED');
  }

  const membership = await GroupMember.findOne({
    groupId: group._id,
    userId: req.user._id,
    status: GROUP_MEMBER_STATUS.ACTIVE,
  });
  if (!membership && !isSuperAdmin) {
    throw ApiError.forbidden('You are not a member of this group', 'NOT_A_MEMBER');
  }

  req.group = group;
  req.groupMember = membership;
  return next();
});

/** Must run after requireGroupMember. */
const requireGroupOrganizer = (req, _res, next) => {
  if (req.user.role === ROLES.SUPER_ADMIN) return next();
  const isOrganizer = String(req.group.organizerId) === String(req.user._id);
  const isOrgAdmin = req.user.role === ROLES.ORG_ADMIN
    && req.group.organizationId
    && String(req.group.organizationId) === String(req.user.organizationId);
  if (!isOrganizer && !isOrgAdmin) {
    return next(ApiError.forbidden('Only the group organizer can do this', 'NOT_ORGANIZER'));
  }
  return next();
};

module.exports = {
  authenticate,
  optionalAuth,
  requireActiveAccount,
  requireRole,
  requireSuperAdmin,
  requireStaff,
  requireOrganizationAccess,
  requireSelfOrAdmin,
  requireGroupMember,
  requireGroupOrganizer,
};
