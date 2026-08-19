'use strict';

const express = require('express');
const ctrl = require('../controllers/auth.controller');
const { validate } = require('../middleware/validate');
const { authLimiter } = require('../middleware/rateLimit');

const router = express.Router();

router.post(
  '/register',
  authLimiter,
  validate({
    accountType: { enum: ['personal', 'organization'] },
    firstName: { required: true, checks: ['string'], maxLength: 60 },
    lastName: { required: true, checks: ['string'], maxLength: 60 },
    email: { required: true, checks: ['email'] },
    phone: { required: true, checks: ['phone'] },
    password: { required: true, checks: ['password'] },
    organizationName: { checks: ['string'], maxLength: 120 },
    joinCode: { checks: ['string'], maxLength: 16 },
  }),
  ctrl.register,
);

router.post(
  '/login',
  authLimiter,
  validate({
    email: { required: true, checks: ['string'] },
    password: { required: true, checks: ['string'] },
  }),
  ctrl.login,
);

router.post('/refresh', ctrl.refresh);
router.post('/logout', ctrl.logout);

router.post(
  '/forgot-password',
  authLimiter,
  validate({ email: { required: true, checks: ['email'] } }),
  ctrl.forgotPassword,
);

router.post(
  '/reset-password',
  authLimiter,
  validate({
    token: { required: true, checks: ['string'] },
    password: { required: true, checks: ['password'] },
  }),
  ctrl.resetPassword,
);

router.post('/verify-email', ctrl.verifyEmail);

module.exports = router;
