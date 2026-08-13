'use strict';

const express = require('express');
const ctrl = require('../controllers/payment.controller');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// Unauthenticated by design — the provider proves itself with a signature over
// the raw request body (see app.js, which captures req.rawBody).
router.post('/webhook', ctrl.webhook);
router.post('/webhook/:provider', ctrl.webhook);

router.get('/:reference', authenticate, ctrl.getPayment);

module.exports = router;
