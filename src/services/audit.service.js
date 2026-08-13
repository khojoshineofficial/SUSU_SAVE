'use strict';

const { AuditLog } = require('../models');
const logger = require('../utils/logger');

/**
 * Audit writes must never break the action they describe — a logging failure is
 * reported but swallowed.
 */
async function log({ req = null, actor = null, action, entityType, entityId = null, organizationId = null, metadata = {} }) {
  const who = actor || req?.user || null;
  try {
    return await AuditLog.create({
      actorId: who?._id || null,
      actorRole: who?.role || null,
      actorLabel: who ? `${who.firstName} ${who.lastName}` : 'system',
      action,
      entityType,
      entityId,
      organizationId: organizationId ?? who?.organizationId ?? null,
      ip: req?.ip || null,
      userAgent: req?.get?.('user-agent') || null,
      metadata,
    });
  } catch (err) {
    logger.error('Failed to write audit log', action, err.message);
    return null;
  }
}

module.exports = { log };
