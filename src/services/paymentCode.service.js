'use strict';

const crypto = require('crypto');
const QRCode = require('qrcode');
const {
  PaymentCode, SusuGroup, GroupMember, Contribution, User, constants,
} = require('../models');
const env = require('../config/env');
const ApiError = require('../utils/apiError');

const { GROUP_MEMBER_STATUS, CONTRIBUTION_STATUS } = constants;

/**
 * QR codes for group contributions.
 *
 * The organizer prints or shares a code; a member scans it and lands on the
 * contribution page for the right group — and, for a personal code, with their
 * own outstanding cycle already resolved. What the code carries is deliberately
 * thin: a URL and 22 random characters. Everything else is looked up server
 * side, behind the member's own session.
 */

/** URL-safe, 132 bits of entropy — not guessable, and short enough to print. */
const newCode = () => crypto.randomBytes(17).toString('base64url');

const urlFor = (code) => `${env.appUrl.replace(/\/+$/, '')}/pay/${code}`;

/**
 * Returns the live code for a target, minting one if there is none. Safe to
 * call repeatedly: an organizer opening the QR tab twice gets the same code,
 * so anything already printed keeps working.
 */
async function ensureCode({ group, userId = null, actorId }) {
  const existing = await PaymentCode.findOne({
    groupId: group._id,
    userId,
    revokedAt: null,
  });
  if (existing) return existing;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await PaymentCode.create({
        code: newCode(),
        groupId: group._id,
        userId,
        organizationId: group.organizationId || null,
        createdBy: actorId,
      });
    } catch (err) {
      // A duplicate on `code` is a generator collision worth retrying; a
      // duplicate on the target means a concurrent request just made one.
      if (err.code !== 11000) throw err;
      // eslint-disable-next-line no-await-in-loop
      const raced = await PaymentCode.findOne({ groupId: group._id, userId, revokedAt: null });
      if (raced) return raced;
    }
  }
  throw new ApiError(500, 'Could not generate a QR code', 'QR_CODE_UNAVAILABLE');
}

/** Revokes a code. Anything already printed with it stops working immediately. */
async function revoke(paymentCode, actorId) {
  paymentCode.revokedAt = new Date();
  paymentCode.revokedBy = actorId;
  await paymentCode.save();
  return paymentCode;
}

/* --------------------------------- images --------------------------------- */

const QR_OPTIONS = {
  // Level M survives a fold, a smudge or a phone camera at an angle.
  errorCorrectionLevel: 'M',
  margin: 2,
  color: { dark: '#101828', light: '#ffffff' },
};

const svgFor = (code) => QRCode.toString(urlFor(code), { ...QR_OPTIONS, type: 'svg', width: 512 });
const pngDataUrlFor = (code) => QRCode.toDataURL(urlFor(code), { ...QR_OPTIONS, width: 720 });

/* -------------------------------- resolving -------------------------------- */

/**
 * Turns a scanned code into everything the payment page needs.
 *
 * The scan itself carries no authority. `viewer` is the signed-in user, and a
 * personal code belonging to someone else tells them nothing beyond "this is
 * not yours" — which is what an organizer scanning a member's card should see
 * too, since an organizer must never be able to pay from a member's wallet.
 */
async function resolveForPayment(code, viewer) {
  const paymentCode = await PaymentCode.findOne({ code: String(code || '') });
  const dead = ApiError.notFound('This QR code is not valid or has been revoked', 'INVALID_PAYMENT_CODE');
  if (!paymentCode || paymentCode.revokedAt) throw dead;

  const group = await SusuGroup.findById(paymentCode.groupId);
  if (!group) throw dead;

  // Record the scan before any membership check: an organizer investigating a
  // code wants to know it was used, whatever the outcome.
  await PaymentCode.updateOne(
    { _id: paymentCode._id },
    { $inc: { scanCount: 1 }, $set: { lastScannedAt: new Date() } },
  );

  const personal = Boolean(paymentCode.userId);
  const belongsToViewer = !personal || String(paymentCode.userId) === String(viewer._id);

  const membership = await GroupMember.findOne({
    groupId: group._id,
    userId: viewer._id,
    status: GROUP_MEMBER_STATUS.ACTIVE,
  });

  // The member the code names, if it names one — used only to explain to a
  // scanner that the card is not theirs.
  let owner = null;
  if (personal && !belongsToViewer) {
    const named = await User.findById(paymentCode.userId).select('firstName lastName').lean();
    owner = named ? `${named.firstName} ${named.lastName[0] || ''}.`.trim() : 'another member';
  }

  const summary = {
    code: paymentCode.code,
    kind: personal ? 'member' : 'group',
    group: {
      _id: group._id,
      name: group.name,
      status: group.status,
      contributionAmountMinor: group.contributionAmountMinor,
      contributionFrequency: group.contributionFrequency,
      currentCycle: group.currentCycle,
      totalCycles: group.totalCycles,
    },
    belongsToViewer,
    forMemberName: owner,
    isMember: Boolean(membership),
    due: null,
  };

  if (!membership) return summary;

  // What the viewer owes right now, in their own name — never anybody else's.
  const due = await Contribution.findOne({
    groupId: group._id,
    userId: viewer._id,
    status: {
      $in: [
        CONTRIBUTION_STATUS.PENDING, CONTRIBUTION_STATUS.PARTIAL,
        CONTRIBUTION_STATUS.MISSED, CONTRIBUTION_STATUS.LATE,
      ],
    },
  }).sort({ cycle: 1 }).lean();

  if (due) {
    summary.due = {
      cycle: due.cycle,
      dueDate: due.dueDate,
      status: due.status,
      expectedAmountMinor: due.expectedAmountMinor,
      paidAmountMinor: due.paidAmountMinor,
      outstandingMinor: Math.max(0, due.expectedAmountMinor - due.paidAmountMinor),
    };
  }
  return summary;
}

module.exports = {
  ensureCode,
  revoke,
  resolveForPayment,
  urlFor,
  svgFor,
  pngDataUrlFor,
};
