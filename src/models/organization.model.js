'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const { ORG_STATUS, values } = require('./constants');

const ORG_TYPES = [
  'company',
  'school',
  'church',
  'association',
  'cooperative',
  'ngo',
  'government',
  'community',
  'other',
];

const organizationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, unique: true },
    slug: { type: String, required: true, unique: true, lowercase: true, index: true },
    type: { type: String, enum: ORG_TYPES, default: 'company' },
    description: { type: String, default: '' },

    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    contactEmail: { type: String, lowercase: true, trim: true },
    contactPhone: { type: String, trim: true },
    address: { type: String, default: '' },
    country: { type: String, default: 'Ghana' },
    region: { type: String, default: null },
    logoUrl: { type: String, default: null },

    status: { type: String, enum: values(ORG_STATUS), default: ORG_STATUS.PENDING, index: true },

    // A snapshot of plan limits so quota checks never need a second lookup.
    planCode: { type: String, default: 'free' },
    limits: {
      maxMembers: { type: Number, default: 25 },
      maxGroups: { type: Number, default: 3 },
    },

    // Organization-level overrides of the platform fee schedule. Any field left
    // null falls back to the global SystemSetting values.
    feeOverrides: {
      savingsFeePercent: { type: Number, default: null },
      withdrawalFeePercent: { type: Number, default: null },
      groupCreationFeeMinor: { type: Number, default: null },
    },

    /**
     * The code in a collector's public sign-up link, /join/<joinCode>. Anyone
     * holding the link can create an account inside this organization, which is
     * how a susu collector onboards the customers they visit. Sparse-unique:
     * organizations created before this feature simply have none until their
     * admin opens the link for the first time.
     */
    joinCode: { type: String, uppercase: true, trim: true, default: undefined },

    settings: {
      allowMemberGroupCreation: { type: Boolean, default: true },
      requireGroupApproval: { type: Boolean, default: true },
      /** Turn the public link off without discarding the code. */
      allowPublicJoin: { type: Boolean, default: true },
    },

    suspendedAt: { type: Date, default: null },
    suspensionReason: { type: String, default: null },
  },
  { timestamps: true },
);

organizationSchema.index(
  { joinCode: 1 },
  { unique: true, partialFilterExpression: { joinCode: { $type: 'string' } } },
);

/**
 * A code short enough to read down a phone line, from an alphabet with no
 * characters that look alike (no O/0, I/1, S/5) — collectors dictate these.
 */
organizationSchema.statics.generateJoinCode = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i += 1) code += alphabet[bytes[i] % alphabet.length];
  return code;
};

organizationSchema.statics.slugify = (name) =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

organizationSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('Organization', organizationSchema);
module.exports.ORG_TYPES = ORG_TYPES;
