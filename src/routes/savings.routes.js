'use strict';

const express = require('express');
const ctrl = require('../controllers/savings.controller');
const { authenticate, requireActiveAccount } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { financialLimiter } = require('../middleware/rateLimit');
const { SAVINGS_TYPE, SAVINGS_FREQUENCIES, values } = require('../models/constants');

const router = express.Router();
router.use(authenticate);

router.get('/', ctrl.listPlans);
router.get('/rent/overview', ctrl.rentOverview);
router.get('/quote', ctrl.quoteDeposit);

router.post(
  '/',
  requireActiveAccount,
  validate({
    name: { required: true, checks: ['string'], minLength: 2, maxLength: 80 },
    type: { enum: values(SAVINGS_TYPE) },
    targetAmount: { checks: ['number', 'positive'] },
    contributionAmount: { checks: ['number', 'positive'] },
    frequency: { enum: SAVINGS_FREQUENCIES },
    targetDate: { checks: ['date'] },
  }),
  ctrl.createPlan,
);

router.get('/:id', ctrl.getPlan);
router.patch('/:id', ctrl.updatePlan);

router.post(
  '/:id/deposit',
  requireActiveAccount,
  financialLimiter,
  validate({ amount: { required: true, checks: ['number', 'positive'] } }),
  ctrl.deposit,
);

router.post('/:id/release', requireActiveAccount, financialLimiter, ctrl.release);

module.exports = router;
