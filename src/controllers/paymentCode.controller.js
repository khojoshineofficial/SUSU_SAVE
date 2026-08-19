'use strict';

const {
  PaymentCode, GroupMember, Contribution, Transaction, constants,
} = require('../models');
const codes = require('../services/paymentCode.service');
const audit = require('../services/audit.service');
const ApiError = require('../utils/apiError');
const { asyncHandler, ok } = require('../utils/http');

const { GROUP_MEMBER_STATUS, CONTRIBUTION_STATUS, TRANSACTION_TYPE, TRANSACTION_STATUS } = constants;

/* ------------------------------ organizer side ------------------------------ */

/**
 * The group's QR code and one per active member, minting any that are missing.
 * `req.group` is resolved and access-checked by requireGroupMember /
 * requireGroupOrganizer before this runs.
 */
const listCodes = asyncHandler(async (req, res) => {
  const group = req.group;

  const groupCode = await codes.ensureCode({ group, userId: null, actorId: req.user._id });
  const members = await GroupMember.find({ groupId: group._id, status: GROUP_MEMBER_STATUS.ACTIVE })
    .populate('userId', 'firstName lastName avatarUrl')
    .sort({ payoutPosition: 1 })
    .lean();

  const memberCodes = [];
  for (const member of members) {
    if (!member.userId) continue;
    // Sequential: a group of 200 members is 200 tiny upserts, and issuing them
    // in a burst would race the unique index against itself.
    // eslint-disable-next-line no-await-in-loop
    const code = await codes.ensureCode({ group, userId: member.userId._id, actorId: req.user._id });
    memberCodes.push({
      _id: code._id,
      code: code.code,
      url: codes.urlFor(code.code),
      scanCount: code.scanCount,
      lastScannedAt: code.lastScannedAt,
      member: {
        _id: member.userId._id,
        name: `${member.userId.firstName} ${member.userId.lastName}`,
        payoutPosition: member.payoutPosition,
      },
    });
  }

  return ok(res, {
    group: { _id: group._id, name: group.name, contributionAmountMinor: group.contributionAmountMinor },
    groupCode: {
      _id: groupCode._id,
      code: groupCode.code,
      url: codes.urlFor(groupCode.code),
      scanCount: groupCode.scanCount,
      lastScannedAt: groupCode.lastScannedAt,
    },
    memberCodes,
  });
});

/** The QR image itself: `?format=svg` for print, PNG data URL otherwise. */
const codeImage = asyncHandler(async (req, res) => {
  const paymentCode = await PaymentCode.findOne({ _id: req.params.codeId, groupId: req.group._id });
  if (!paymentCode || paymentCode.revokedAt) {
    throw ApiError.notFound('QR code not found', 'PAYMENT_CODE_NOT_FOUND');
  }

  if (req.query.format === 'svg') {
    const svg = await codes.svgFor(paymentCode.code);
    res.type('image/svg+xml');
    res.set('Cache-Control', 'private, max-age=300');
    return res.send(svg);
  }

  return ok(res, {
    code: paymentCode.code,
    url: codes.urlFor(paymentCode.code),
    png: await codes.pngDataUrlFor(paymentCode.code),
  });
});

/** Revokes a code and immediately issues its replacement. */
const rotateCode = asyncHandler(async (req, res) => {
  const paymentCode = await PaymentCode.findOne({ _id: req.params.codeId, groupId: req.group._id });
  if (!paymentCode) throw ApiError.notFound('QR code not found', 'PAYMENT_CODE_NOT_FOUND');

  if (!paymentCode.revokedAt) await codes.revoke(paymentCode, req.user._id);
  const replacement = await codes.ensureCode({
    group: req.group,
    userId: paymentCode.userId,
    actorId: req.user._id,
  });

  await audit.log({
    req,
    action: 'group.qr_code_rotated',
    entityType: 'PaymentCode',
    entityId: paymentCode._id,
    organizationId: req.group.organizationId,
    metadata: { groupId: String(req.group._id), scope: paymentCode.userId ? 'member' : 'group' },
  });

  return ok(res, {
    code: replacement.code,
    url: codes.urlFor(replacement.code),
  }, 'New QR code issued. The previous one no longer works.');
});

/** Disables a code without replacing it — for a lost or misprinted card. */
const revokeCode = asyncHandler(async (req, res) => {
  const paymentCode = await PaymentCode.findOne({ _id: req.params.codeId, groupId: req.group._id });
  if (!paymentCode) throw ApiError.notFound('QR code not found', 'PAYMENT_CODE_NOT_FOUND');
  if (!paymentCode.revokedAt) await codes.revoke(paymentCode, req.user._id);

  await audit.log({
    req,
    action: 'group.qr_code_revoked',
    entityType: 'PaymentCode',
    entityId: paymentCode._id,
    organizationId: req.group.organizationId,
    metadata: { groupId: String(req.group._id) },
  });
  return ok(res, {}, 'QR code revoked');
});

/* -------------------------------- member side ------------------------------- */

/** What a scanned code resolves to for whoever is signed in. */
const resolveCode = asyncHandler(async (req, res) => {
  const summary = await codes.resolveForPayment(req.params.code, req.user);
  return ok(res, summary);
});

/* ---------------------------- organizer payments ---------------------------- */

/**
 * Who has paid and who has not, for the organizer.
 *
 * Built from the existing Contribution rows rather than a parallel payment
 * table: a contribution row already carries the amount, the status and the
 * transactions that settled it, so this is a read over the same records the
 * ledger writes.
 */
const groupPayments = asyncHandler(async (req, res) => {
  const group = req.group;
  const cycle = req.query.cycle ? Number(req.query.cycle) : group.currentCycle;

  const [members, cycleRows, allRows] = await Promise.all([
    GroupMember.find({ groupId: group._id, status: GROUP_MEMBER_STATUS.ACTIVE })
      .populate('userId', 'firstName lastName phone avatarUrl')
      .sort({ payoutPosition: 1 })
      .lean(),
    Contribution.find({ groupId: group._id, cycle }).lean(),
    Contribution.find({ groupId: group._id }).select('status paidAmountMinor expectedAmountMinor').lean(),
  ]);

  const byUser = new Map(cycleRows.map((row) => [String(row.userId), row]));

  // Every transaction that settled a contribution this cycle, for the reference
  // numbers the organizer needs when a member queries a payment.
  const transactionIds = cycleRows.flatMap((row) => row.transactionIds || []);
  const transactions = await Transaction.find({ _id: { $in: transactionIds } })
    .select('userId transactionId grossAmountMinor paymentMethod status createdAt providerReference')
    .lean();
  const receiptsByUser = new Map();
  transactions.forEach((t) => {
    const key = String(t.userId);
    if (!receiptsByUser.has(key)) receiptsByUser.set(key, []);
    receiptsByUser.get(key).push(t);
  });

  const rows = members.map((member) => {
    const contribution = byUser.get(String(member.userId?._id));
    const expected = contribution?.expectedAmountMinor ?? group.contributionAmountMinor;
    const paid = contribution?.paidAmountMinor || 0;

    return {
      userId: member.userId?._id,
      name: member.userId ? `${member.userId.firstName} ${member.userId.lastName}` : '—',
      phone: member.userId?.phone || null,
      payoutPosition: member.payoutPosition,
      cycle,
      // The row's own status is the truth: it is only marked paid once a
      // verified payment has moved through the ledger.
      status: contribution?.status || CONTRIBUTION_STATUS.PENDING,
      expectedAmountMinor: expected,
      paidAmountMinor: paid,
      outstandingMinor: Math.max(0, expected - paid),
      dueDate: contribution?.dueDate || null,
      paidAt: contribution?.paidAt || null,
      daysLate: contribution?.daysLate || 0,
      totalContributedMinor: member.totalContributedMinor || 0,
      receipts: (receiptsByUser.get(String(member.userId?._id)) || []).map((t) => ({
        transactionId: t.transactionId,
        providerReference: t.providerReference || null,
        amountMinor: t.grossAmountMinor,
        method: t.paymentMethod,
        status: t.status,
        at: t.createdAt,
      })),
    };
  });

  const paidStatuses = [CONTRIBUTION_STATUS.PAID, CONTRIBUTION_STATUS.LATE];
  const summary = {
    cycle,
    totalCycles: group.totalCycles,
    members: rows.length,
    paid: rows.filter((r) => paidStatuses.includes(r.status)).length,
    partial: rows.filter((r) => r.status === CONTRIBUTION_STATUS.PARTIAL).length,
    unpaid: rows.filter((r) => r.status === CONTRIBUTION_STATUS.PENDING).length,
    missed: rows.filter((r) => r.status === CONTRIBUTION_STATUS.MISSED).length,
    collectedThisCycleMinor: rows.reduce((sum, r) => sum + r.paidAmountMinor, 0),
    expectedThisCycleMinor: rows.reduce((sum, r) => sum + r.expectedAmountMinor, 0),
    collectedAllTimeMinor: allRows.reduce((sum, r) => sum + r.paidAmountMinor, 0),
    expectedAllTimeMinor: allRows.reduce((sum, r) => sum + r.expectedAmountMinor, 0),
  };

  // A pending payment is money the member has started but not settled: it is
  // reported, and deliberately does not count towards `paid`.
  const pending = await Transaction.countDocuments({
    groupId: group._id,
    type: TRANSACTION_TYPE.CONTRIBUTION,
    status: { $in: [TRANSACTION_STATUS.PENDING, TRANSACTION_STATUS.PROCESSING] },
  });
  summary.pendingPayments = pending;

  return ok(res, { summary, rows });
});

module.exports = { listCodes, codeImage, rotateCode, revokeCode, resolveCode, groupPayments };
