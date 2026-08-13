'use strict';

const express = require('express');
const ctrl = require('../controllers/group.controller');
const {
  authenticate, requireActiveAccount, requireGroupMember, requireGroupOrganizer,
} = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { financialLimiter } = require('../middleware/rateLimit');
const { GROUP_FREQUENCIES } = require('../models/constants');

const router = express.Router();
router.use(authenticate);

const groupSchema = {
  name: { required: true, checks: ['string'], minLength: 3, maxLength: 80 },
  description: { checks: ['string'], maxLength: 500 },
  contributionAmount: { required: true, checks: ['number', 'positive'] },
  contributionFrequency: { required: true, enum: GROUP_FREQUENCIES },
  memberLimit: { required: true, checks: ['integer'], min: 2, max: 200 },
  startDate: { checks: ['date'] },
  payoutOrderMode: { enum: ['automatic', 'manual'] },
};

router.get('/', ctrl.listMyGroups);
router.post('/preview', validate(groupSchema), ctrl.previewGroup);
router.post('/', requireActiveAccount, validate(groupSchema), ctrl.createGroup);

router.post(
  '/join',
  requireActiveAccount,
  validate({ inviteCode: { required: true, checks: ['string'] } }),
  ctrl.joinByCode,
);
router.get('/lookup/:code', ctrl.lookupByCode);

// Everything below resolves :groupId through requireGroupMember, which enforces
// both tenant isolation and membership before the handler sees the group.
router.get('/:groupId', requireGroupMember, ctrl.getGroup);
router.get('/:groupId/schedule', requireGroupMember, ctrl.getSchedule);
router.get('/:groupId/calendar', requireGroupMember, ctrl.getCalendar);

router.get('/:groupId/members', requireGroupMember, ctrl.listMembers);
router.post(
  '/:groupId/members/:memberId/review',
  requireGroupMember,
  requireGroupOrganizer,
  validate({ action: { required: true, enum: ['approve', 'reject'] } }),
  ctrl.reviewMember,
);
router.delete('/:groupId/members/:memberId', requireGroupMember, requireGroupOrganizer, ctrl.removeMember);

router.post('/:groupId/payout-order', requireGroupMember, requireGroupOrganizer, ctrl.setPayoutOrder);
router.post('/:groupId/activate', requireGroupMember, requireGroupOrganizer, ctrl.activateGroup);

router.get('/:groupId/contributions', requireGroupMember, ctrl.listContributions);
router.post(
  '/:groupId/contributions',
  requireGroupMember,
  requireActiveAccount,
  financialLimiter,
  validate({ amount: { checks: ['number', 'positive'] }, cycle: { checks: ['integer'] } }),
  ctrl.contribute,
);

router.get('/:groupId/payouts', requireGroupMember, ctrl.listPayouts);
router.post('/:groupId/payouts/:payoutId/run', requireGroupMember, requireGroupOrganizer, ctrl.runPayout);

module.exports = router;
