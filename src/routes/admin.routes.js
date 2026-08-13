'use strict';

const express = require('express');
const ctrl = require('../controllers/admin.controller');
const { authenticate, requireSuperAdmin } = require('../middleware/auth');
const { validate } = require('../middleware/validate');

const router = express.Router();

// Every route below is Super Admin only — the platform owner's console.
router.use(authenticate, requireSuperAdmin);

router.get('/overview', ctrl.overview);
router.get('/charts', ctrl.charts);

router.get('/users', ctrl.listUsers);
router.get('/users/:id', ctrl.getUser);
router.post('/users/:id/status', validate({ status: { required: true, checks: ['string'] } }), ctrl.setUserStatus);
router.post('/users/:id/role', validate({ role: { required: true, checks: ['string'] } }), ctrl.setUserRole);
router.post('/users/:id/reset-password', ctrl.resetUserPassword);
router.post('/users/:id/recompute-wallet', ctrl.recomputeWallet);

router.get('/organizations', ctrl.listOrganizations);
router.post('/organizations/:id/status', validate({ status: { required: true, checks: ['string'] } }), ctrl.setOrganizationStatus);
router.post('/organizations/:id/plan', validate({ planCode: { required: true, checks: ['string'] } }), ctrl.updateOrganizationPlan);

router.get('/groups', ctrl.listGroups);
router.get('/transactions', ctrl.listTransactions);

router.get('/withdrawals', ctrl.listWithdrawals);
router.post('/withdrawals/:id/approve', ctrl.approveWithdrawal);
router.post('/withdrawals/:id/reject', ctrl.rejectWithdrawal);

router.get('/payouts', ctrl.listPayouts);
router.post('/payouts/run-due', ctrl.runDuePayouts);
router.post('/payouts/:id/run', ctrl.runPayout);

router.get('/settings', ctrl.getSettings);
router.patch('/settings', ctrl.updateSettings);

router.get('/plans', ctrl.listPlans);
router.post('/plans', validate({ code: { required: true, checks: ['string'] }, name: { required: true, checks: ['string'] } }), ctrl.upsertPlan);

router.get('/audit-logs', ctrl.listAuditLogs);
router.get('/reports/:kind', ctrl.reports);

module.exports = router;
