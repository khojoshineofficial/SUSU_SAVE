'use strict';

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

    settings: {
      allowMemberGroupCreation: { type: Boolean, default: true },
      requireGroupApproval: { type: Boolean, default: true },
    },

    suspendedAt: { type: Date, default: null },
    suspensionReason: { type: String, default: null },
  },
  { timestamps: true },
);

organizationSchema.statics.slugify = (name) =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

organizationSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('Organization', organizationSchema);
module.exports.ORG_TYPES = ORG_TYPES;
