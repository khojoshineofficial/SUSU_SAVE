'use strict';

const express = require('express');
const ctrl = require('../controllers/user.controller');
const { authenticate } = require('../middleware/auth');
const { validate } = require('../middleware/validate');

const router = express.Router();
router.use(authenticate);

router.get('/me', ctrl.me);
router.patch('/me', ctrl.updateProfile);

router.post(
  '/me/password',
  validate({
    currentPassword: { required: true, checks: ['string'] },
    newPassword: { required: true, checks: ['password'] },
  }),
  ctrl.changePassword,
);

// Scoped inside the controller: you may only read yourself, a group-mate, or
// (as super admin) anyone.
router.get('/:id', ctrl.getById);

module.exports = router;
