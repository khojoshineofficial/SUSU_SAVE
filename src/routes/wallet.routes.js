'use strict';

const express = require('express');
const ctrl = require('../controllers/wallet.controller');
const { authenticate, requireActiveAccount } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { financialLimiter } = require('../middleware/rateLimit');
const { MOMO_PROVIDERS } = require('../models/constants');

const router = express.Router();
router.use(authenticate);

router.get('/wallet', ctrl.getWallet);

router.post(
  '/wallet/topup',
  requireActiveAccount,
  financialLimiter,
  validate({
    amount: { required: true, checks: ['number', 'positive'] },
    provider: { enum: MOMO_PROVIDERS },
    accountNumber: { checks: ['string'] },
  }),
  ctrl.topUp,
);

router.post('/wallet/payments/:reference/confirm', financialLimiter, ctrl.confirmPayment);

router.get('/transactions', ctrl.listTransactions);
router.get('/transactions/:id', ctrl.getTransaction);

router.get('/withdrawals', ctrl.listWithdrawals);
router.get('/withdrawals/quote', ctrl.quoteWithdrawal);
router.post(
  '/withdrawals',
  requireActiveAccount,
  financialLimiter,
  validate({
    amount: { required: true, checks: ['number', 'positive'] },
    accountNumber: { required: true, checks: ['string'] },
    provider: { enum: [...MOMO_PROVIDERS, 'bank'] },
    method: { enum: ['mobile_money', 'bank'] },
  }),
  ctrl.requestWithdrawal,
);

module.exports = router;
