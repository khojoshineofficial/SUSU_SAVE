'use strict';

const mongoose = require('mongoose');

/**
 * Append-only record of administrative and financial actions. No route in the
 * application updates or deletes these documents; the pre-hooks below make an
 * accidental write fail loudly rather than silently rewrite history.
 */
const auditLogSchema = new mongoose.Schema(
  {
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    actorRole: { type: String, default: null },
    actorLabel: { type: String, default: 'system' },

    action: { type: String, required: true, index: true },
    entityType: { type: String, required: true },
    entityId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null, index: true },

    ip: { type: String, default: null },
    userAgent: { type: String, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

const immutable = function immutable(next) {
  next(new Error('Audit logs are immutable'));
};

auditLogSchema.pre('updateOne', immutable);
auditLogSchema.pre('updateMany', immutable);
auditLogSchema.pre('findOneAndUpdate', immutable);
auditLogSchema.pre('deleteOne', immutable);
auditLogSchema.pre('deleteMany', immutable);

auditLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
