'use strict';

const {
  Organization, User, SusuGroup, Invitation, constants,
} = require('../models');
const { ROLES, ACCOUNT_STATUS } = constants;
const email = require('../services/email.service');
const audit = require('../services/audit.service');
const ids = require('../utils/ids');
const ApiError = require('../utils/apiError');
const { asyncHandler, ok, created } = require('../utils/http');

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
    ['allowMemberGroupCreation', 'requireGroupApproval'].forEach((key) => {
      if (typeof req.body.settings[key] === 'boolean') organization.settings[key] = req.body.settings[key];
    });
  }
  await organization.save();

  await audit.log({ req, action: 'organization.updated', entityType: 'Organization', entityId: organization._id });
  return ok(res, { organization }, 'Organization updated');
});

const listMembers = asyncHandler(async (req, res) => {
  const organization = await resolveOrganization(req);
  const members = await User.find({ organizationId: organization._id })
    .select('firstName lastName email phone role status createdAt lastLoginAt avatarUrl')
    .sort({ createdAt: -1 })
    .lean();
  return ok(res, { members });
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

module.exports = {
  getOrganization,
  updateOrganization,
  listMembers,
  inviteMember,
  acceptInvitation,
  removeMember,
  listGroups,
  suspendMember,
};
