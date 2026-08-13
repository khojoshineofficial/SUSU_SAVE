'use strict';

const express = require('express');
const ctrl = require('../controllers/organization.controller');
const { authenticate, requireRole } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { ROLES } = require('../models/constants');

const router = express.Router();
router.use(authenticate);

// Accepting an invitation is the one action an ordinary user performs here.
router.post('/invitations/accept', validate({ token: { required: true, checks: ['string'] } }), ctrl.acceptInvitation);

const adminOnly = requireRole(ROLES.ORG_ADMIN, ROLES.SUPER_ADMIN);

router.get('/current', adminOnly, ctrl.getOrganization);
router.patch('/current', adminOnly, ctrl.updateOrganization);
router.get('/current/members', adminOnly, ctrl.listMembers);
router.get('/current/groups', adminOnly, ctrl.listGroups);

router.post(
  '/current/members/invite',
  adminOnly,
  validate({ email: { required: true, checks: ['email'] }, name: { checks: ['string'] } }),
  ctrl.inviteMember,
);
router.delete('/current/members/:memberId', adminOnly, ctrl.removeMember);
router.post('/current/members/:memberId/suspend', adminOnly, ctrl.suspendMember);

// Explicit-id variants; resolveOrganization() rejects cross-tenant access.
router.get('/:id', adminOnly, ctrl.getOrganization);
router.patch('/:id', adminOnly, ctrl.updateOrganization);
router.get('/:id/members', adminOnly, ctrl.listMembers);
router.get('/:id/groups', adminOnly, ctrl.listGroups);

module.exports = router;
