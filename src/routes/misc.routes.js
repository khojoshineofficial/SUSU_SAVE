'use strict';

const express = require('express');
const ctrl = require('../controllers/misc.controller');
const { authenticate } = require('../middleware/auth');
const { validate } = require('../middleware/validate');

const router = express.Router();

// Public: the landing page and signup flow read fee/limit configuration here.
router.get('/settings/public', ctrl.publicSettings);

// Public: the join page shows who a sign-up link belongs to before anyone signs up.
router.get('/collectors/:code', ctrl.collectorByCode);

router.use(authenticate);

router.get('/dashboard', ctrl.getDashboard);
router.get('/search', ctrl.search);

router.get('/notifications', ctrl.listNotifications);
router.post('/notifications/read-all', ctrl.readAllNotifications);
router.post('/notifications/:id/read', ctrl.readNotification);

router.get('/support/tickets', ctrl.listTickets);
router.post(
  '/support/tickets',
  validate({
    subject: { required: true, checks: ['string'], maxLength: 140 },
    message: { required: true, checks: ['string'], maxLength: 4000 },
  }),
  ctrl.createTicket,
);
router.post(
  '/support/tickets/:id/reply',
  validate({ message: { required: true, checks: ['string'], maxLength: 4000 } }),
  ctrl.replyToTicket,
);

router.get('/my-organization', ctrl.organizationOverview);

module.exports = router;
