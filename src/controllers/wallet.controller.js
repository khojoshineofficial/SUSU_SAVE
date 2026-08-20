'use strict';

const { Transaction, Withdrawal, Payment } = require('../models');
const ledger = require('../services/ledger.service');
const paymentService = require('../services/payment');
const withdrawalService = require('../services/withdrawal.service');
const feeService = require('../services/fee.service');
const settlement = require('../services/settlement.service');
const money = require('../utils/money');
const ApiError = require('../utils/apiError');
const env = require('../config/env');
const { asyncHandler, ok, created, paginate, meta } = require('../utils/http');

const getWallet = asyncHandler(async (req, res) => {
  const wallet = await ledger.getOrCreateWallet(req.user._id, req.user.organizationId);
  const pendingMinor = await ledger.pendingSum({ userId: req.user._id });
  return ok(res, { wallet, pendingMinor });
});

/** Start a top-up. Money only lands once the provider webhook is verified. */
const topUp = asyncHandler(async (req, res) => {
  const amountMinor = money.toMinor(req.body.amount);
  if (amountMinor <= 0) throw ApiError.badRequest('Amount must be positive', 'INVALID_AMOUNT');

  const payment = await paymentService.initiatePayment({
    userId: req.user._id,
    organizationId: req.user.organizationId,
    purpose: 'wallet_topup',
    amountMinor,
    method: req.body.method || 'mobile_money',
    payerIdentifier: req.body.accountNumber || req.user.phone,
    // Paystack and most card rails require an email on every transaction.
    payerEmail: req.user.email,
    metadata: { provider: req.body.provider || 'mtn' },
  });

  return created(res, {
    payment: {
      reference: payment.reference,
      amountMinor: payment.amountMinor,
      status: payment.status,
      checkoutUrl: payment.checkoutUrl,
    },
  }, 'Top-up started — approve the payment on your phone');
});

/**
 * Client-driven status check. It re-verifies with the provider rather than
 * trusting the caller, and settles through the same idempotent path as webhooks.
 */
const confirmPayment = asyncHandler(async (req, res) => {
  const payment = await Payment.findOne({ reference: req.params.reference, userId: req.user._id });
  if (!payment) throw ApiError.notFound('Payment not found', 'PAYMENT_NOT_FOUND');

  if (payment.settledAt) return ok(res, { payment, applied: false }, 'Payment already settled');

  const verification = await paymentService.verifyPayment(payment);
  const result = await settlement.settlePayment(payment, { verifiedStatus: verification.status });

  return ok(res, {
    payment: result.payment || payment,
    applied: result.applied,
  }, result.applied ? 'Payment confirmed' : 'Payment not settled yet');
});

const listTransactions = asyncHandler(async (req, res) => {
  const { page, limit, skip } = paginate(req.query, { defaultLimit: 25 });
  const filter = { userId: req.user._id };
  if (req.query.type) filter.type = req.query.type;
  if (req.query.status) filter.status = req.query.status;
  if (req.query.groupId) filter.groupId = req.query.groupId;
  if (req.query.from || req.query.to) {
    filter.createdAt = {};
    if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
    if (req.query.to) filter.createdAt.$lte = new Date(req.query.to);
  }

  const [rows, total] = await Promise.all([
    Transaction.find(filter)
      .populate('groupId', 'name')
      .populate('savingsPlanId', 'name')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Transaction.countDocuments(filter),
  ]);

  return ok(res, { transactions: rows, meta: meta(page, limit, total) });
});

const getTransaction = asyncHandler(async (req, res) => {
  const transaction = await Transaction.findOne({
    $or: [{ _id: isObjectId(req.params.id) ? req.params.id : null }, { transactionId: req.params.id }],
    userId: req.user._id,
  })
    .populate('groupId', 'name')
    .populate('savingsPlanId', 'name')
    .lean();

  if (!transaction) throw ApiError.notFound('Transaction not found', 'TRANSACTION_NOT_FOUND');

  return ok(res, {
    transaction,
    receipt: {
      platform: 'SUSU SAVE',
      transactionId: transaction.transactionId,
      customer: `${req.user.firstName} ${req.user.lastName}`,
      amount: money.format(transaction.grossAmountMinor),
      fee: money.format(transaction.feeMinor),
      net: money.format(transaction.netAmountMinor),
      currency: env.currency,
      status: transaction.status,
      method: transaction.paymentMethod,
      date: transaction.createdAt,
      reference: transaction.providerReference,
    },
  });
});

const isObjectId = (value) => /^[a-f\d]{24}$/i.test(String(value));

const quoteWithdrawal = asyncHandler(async (req, res) => {
  const amountMinor = money.toMinor(req.query.amount || req.body.amount);
  const quote = await feeService.quoteWithdrawalFee(amountMinor, null);
  return ok(res, { quote });
});

const requestWithdrawal = asyncHandler(async (req, res) => {
  const result = await withdrawalService.requestWithdrawal({ actor: req.user, payload: req.body });
  return created(res, result, 'Withdrawal requested — you will be notified once it is processed');
});

const listWithdrawals = asyncHandler(async (req, res) => {
  const { page, limit, skip } = paginate(req.query);
  const filter = { userId: req.user._id };
  if (req.query.status) filter.status = req.query.status;

  const [rows, total] = await Promise.all([
    Withdrawal.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Withdrawal.countDocuments(filter),
  ]);
  return ok(res, { withdrawals: rows.map((w) => w.toJSON()), meta: meta(page, limit, total) });
});

module.exports = {
  getWallet,
  topUp,
  confirmPayment,
  listTransactions,
  getTransaction,
  quoteWithdrawal,
  requestWithdrawal,
  listWithdrawals,
};
