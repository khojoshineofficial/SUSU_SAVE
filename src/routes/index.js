'use strict';

const express = require('express');

const authRoutes = require('./auth.routes');
const userRoutes = require('./user.routes');
const groupRoutes = require('./group.routes');
const savingsRoutes = require('./savings.routes');
const walletRoutes = require('./wallet.routes');
const organizationRoutes = require('./organization.routes');
const adminRoutes = require('./admin.routes');
const paymentRoutes = require('./payment.routes');
const miscRoutes = require('./misc.routes');
const jobRoutes = require('./jobs.routes');

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/groups', groupRoutes);
router.use('/savings', savingsRoutes);
router.use('/organizations', organizationRoutes);
router.use('/admin', adminRoutes);
router.use('/payments', paymentRoutes);
// Secret-authenticated triggers for scheduled work (used on serverless hosts).
router.use('/jobs', jobRoutes);
// Wallet, transactions, withdrawals and the dashboard/notification endpoints.
router.use('/', walletRoutes);
router.use('/', miscRoutes);

module.exports = router;
