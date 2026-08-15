'use strict';

const express = require('express');
const ctrl = require('../controllers/admin.controller');
const { authenticate, requireSuperAdmin, requireStaff } = require('../middleware/auth');
const { validate } = require('../middleware/validate');

const router = express.Router();

/**
 * Two tiers inside one console.
 *
 * `requireStaff` — an admin may look at the platform's money and act on
 * payments: overview, users, transactions, withdrawals, payouts, audit.
 * `requireSuperAdmin` — only the owner may change what the platform *is*:
 * fees and limits, subscription plans, maintenance mode, roles, and the status
 * of users and organizations.
 */
router.use(authenticate, requireStaff);

router.get('/overview', ctrl.overview);
router.get('/charts', ctrl.charts);

router.get('/users', ctrl.listUsers);
router.get('/users/:id', ctrl.getUser);
router.post('/users/:id/status', requireSuperAdmin, validate({ status: { required: true, checks: ['string'] } }), ctrl.setUserStatus);
router.post('/users/:id/role', requireSuperAdmin, validate({ role: { required: true, checks: ['string'] } }), ctrl.setUserRole);
router.post('/users/:id/reset-password', requireSuperAdmin, ctrl.resetUserPassword);
router.post('/users/:id/recompute-wallet', requireSuperAdmin, ctrl.recomputeWallet);

router.get('/organizations', ctrl.listOrganizations);
router.post('/organizations/:id/status', requireSuperAdmin, validate({ status: { required: true, checks: ['string'] } }), ctrl.setOrganizationStatus);
router.post('/organizations/:id/plan', requireSuperAdmin, validate({ planCode: { required: true, checks: ['string'] } }), ctrl.updateOrganizationPlan);

router.get('/groups', ctrl.listGroups);
router.get('/transactions', ctrl.listTransactions);

router.get('/withdrawals', ctrl.listWithdrawals);
router.post('/withdrawals/:id/approve', ctrl.approveWithdrawal);
router.post('/withdrawals/:id/reject', ctrl.rejectWithdrawal);

router.get('/payouts', ctrl.listPayouts);
router.post('/payouts/run-due', requireSuperAdmin, ctrl.runDuePayouts);
router.post('/payouts/:id/run', requireSuperAdmin, ctrl.runPayout);

router.get('/settings', requireSuperAdmin, ctrl.getSettings);
router.patch('/settings', requireSuperAdmin, ctrl.updateSettings);

router.get('/plans', requireSuperAdmin, ctrl.listPlans);
router.post('/plans', requireSuperAdmin, validate({ code: { required: true, checks: ['string'] }, name: { required: true, checks: ['string'] } }), ctrl.upsertPlan);

router.get('/payments/analysis', ctrl.paymentAnalysis);
router.get('/payments/records', ctrl.paymentRecords);

router.get('/audit-logs', ctrl.listAuditLogs);
router.get('/reports/:kind', ctrl.reports);

module.exports = router;
