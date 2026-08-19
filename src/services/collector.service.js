'use strict';

const { Organization, User, constants } = require('../models');
const env = require('../config/env');
const ApiError = require('../utils/apiError');

const { ORG_STATUS, ACCOUNT_STATUS } = constants;

/**
 * Public sign-up links.
 *
 * A susu collector works door to door: they need to hand a customer something
 * that turns into an account, without an email invitation round trip and
 * without the collector typing anything on the customer's behalf. That is what
 * a join link is — one URL per organization, shareable over WhatsApp, printed
 * on a card, or read out as an eight-character code.
 *
 * Everyone who signs up through the link lands inside the collector's
 * organization, so the existing tenant isolation does the rest: the collector
 * sees their own customers and nobody else's.
 */

/** Codes are compared uppercase and only ever contain the generator's alphabet. */
function normaliseCode(value) {
  const code = String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 8) throw ApiError.badRequest('That link is not valid', 'INVALID_JOIN_CODE');
  return code;
}

const linkFor = (code) => `${env.appUrl.replace(/\/+$/, '')}/join/${code}`;

/**
 * Returns the organization's code, minting one on first use. Organizations that
 * predate this feature have none, so the code is issued lazily rather than in a
 * migration. The retry covers the vanishingly rare generator collision.
 */
async function ensureJoinCode(organization) {
  if (organization.joinCode) return organization.joinCode;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    organization.joinCode = Organization.generateJoinCode();
    try {
      // eslint-disable-next-line no-await-in-loop
      await organization.save();
      return organization.joinCode;
    } catch (err) {
      if (err.code !== 11000) throw err;
    }
  }
  throw new ApiError(500, 'Could not generate a join code', 'JOIN_CODE_UNAVAILABLE');
}

/** Issues a fresh code, which immediately invalidates every link already shared. */
async function regenerateJoinCode(organization) {
  organization.joinCode = undefined;
  return ensureJoinCode(organization);
}

/**
 * Resolves a code to the organization behind it, for the public join page and
 * for registration. Refuses closed doors — a suspended collector, or one who
 * has switched their link off — with the same message either way, so the code
 * cannot be used to probe an organization's status.
 */
async function resolveJoinCode(code) {
  const organization = await Organization.findOne({ joinCode: normaliseCode(code) });
  const closed = ApiError.notFound('This sign-up link is no longer active', 'JOIN_LINK_CLOSED');

  if (!organization) throw closed;
  if (organization.settings?.allowPublicJoin === false) throw closed;
  if (organization.status !== ORG_STATUS.ACTIVE) throw closed;
  return organization;
}

/** What the join page shows a customer before they commit to signing up. */
async function publicProfile(code) {
  const organization = await resolveJoinCode(code);
  const collector = await User.findById(organization.adminId).select('firstName lastName').lean();

  return {
    joinCode: organization.joinCode,
    name: organization.name,
    type: organization.type,
    region: organization.region,
    logoUrl: organization.logoUrl,
    // A first name only: enough for the customer to recognise their collector,
    // without publishing contact details to anyone holding the link.
    collectorName: collector ? `${collector.firstName} ${collector.lastName}`.trim() : null,
  };
}

/**
 * Checks that one more member fits inside the collector's plan. Called during
 * registration, where exceeding the limit must stop the signup rather than
 * quietly creating an orphaned account.
 */
async function assertCapacity(organization) {
  const max = organization.limits?.maxMembers;
  if (!max) return;

  const members = await User.countDocuments({
    organizationId: organization._id,
    status: { $ne: ACCOUNT_STATUS.INACTIVE },
  });
  if (members >= max) {
    throw ApiError.badRequest(
      'This collector cannot take new customers right now. Please contact them.',
      'ORG_MEMBER_LIMIT',
    );
  }
}

module.exports = {
  ensureJoinCode,
  regenerateJoinCode,
  resolveJoinCode,
  publicProfile,
  assertCapacity,
  normaliseCode,
  linkFor,
};
