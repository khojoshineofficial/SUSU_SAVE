'use strict';

const mongoose = require('mongoose');

/** Subscription plans available to organizations. Configurable by Super Admin. */
const planSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, lowercase: true, index: true },
    name: { type: String, required: true },
    description: { type: String, default: '' },

    monthlyPriceMinor: { type: Number, default: 0, min: 0 },
    maxMembers: { type: Number, default: 25 },
    maxGroups: { type: Number, default: 3 },
    features: [{ type: String }],

    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true },
);

planSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('Plan', planSchema);
