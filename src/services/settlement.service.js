'use strict';

const { Payment, User, Organization, constants } = require('../models');
const { TRANSACTION_STATUS, TRANSACTION_TYPE, PAYMENT_METHOD, ACCOUNT_STATUS, ORG_STATUS } = constants;
const ledger = require('./ledger.service');
const notifications = require('./notification.service');
const audit = require('./audit.service');
const logger = require('../utils/logger');

/**
 * Applies a *verified* payment to the ledger. This is the only path by which
 * external money enters SUSU SAVE, and it is idempotent in two layers:
 *
 *   1. `payment.settledAt` short-circuits a replayed webhook.
 *   2. Every ledger row it writes carries `idempotencyKey = payment:<id>`, so
 *      even a race between two concurrent webhook deliveries cannot double-credit.
 */
async function settlePayment(paymentOrId, { verifiedStatus = 'successful' } = {}) {
  const payment = typeof paymentOrId === 'object' && paymentOrId.save
    ? paymentOrId
    : await Payment.findById(paymentOrId);

  if (!payment) return { applied: false, reason: 'payment_not_found' };
  if (payment.settledAt) return { applied: false, reason: 'already_settled', payment };

  if (verifiedStatus !== 'successful') {
    payment.status = TRANSACTION_STATUS.FAILED;
    payment.failureReason = `Provider reported: ${verifiedStatus}`;
    await payment.save();
    return { applied: false, reason: 'not_successful', payment };
  }

  const key = `payment:${payment._id}`;
  const common = {
    userId: payment.userId,
    organizationId: payment.organizationId,
    paymentMethod: payment.method || PAYMENT_METHOD.MOBILE_MONEY,
    provider: payment.provider,
    providerReference: payment.providerReference,
    idempotencyKey: key,
    metadata: { paymentReference: payment.reference, purpose: payment.purpose },
  };

  let transaction = null;

  switch (payment.purpose) {
    case 'registration_fee': {
      // A fee is money the platform keeps: it is recorded as a debit but the
      // user's wallet never held it, so it is a ledger row without a balance move.
      transaction = await ledger.record({
        ...common,
        type: TRANSACTION_TYPE.REGISTRATION_FEE,
        grossAmountMinor: payment.amountMinor,
        description: 'Registration fee',
      });
      await activateAfterRegistration(payment);
      await notifications.notify({
        userId: payment.userId,
        ...notifications.templates.registrationPayment(payment.amountMinor),
        dedupeKey: `${key}:notify`,
      });
      break;
    }

    case 'group_creation_fee': {
      transaction = await ledger.record({
        ...common,
        type: TRANSACTION_TYPE.GROUP_CREATION_FEE,
        groupId: payment.metadata?.groupId || null,
        grossAmountMinor: payment.amountMinor,
        description: 'Group creation fee',
      });
      break;
    }

    case 'subscription': {
      transaction = await ledger.record({
        ...common,
        type: TRANSACTION_TYPE.SUBSCRIPTION,
        grossAmountMinor: payment.amountMinor,
        description: `Subscription — ${payment.metadata?.planCode || 'plan'}`,
      });
      break;
    }

    case 'wallet_topup':
    case 'contribution':
    default: {
      // Money genuinely lands in the user's wallet.
      const posted = await ledger.post({
        ...common,
        type: TRANSACTION_TYPE.DEPOSIT,
        grossAmountMinor: payment.amountMinor,
        description: 'Wallet top-up',
      });
      transaction = posted.transaction;
      break;
    }
  }

  payment.status = TRANSACTION_STATUS.SUCCESSFUL;
  payment.settledAt = new Date();
  await payment.save();

  await audit.log({
    action: 'payment.settled',
    entityType: 'Payment',
    entityId: payment._id,
    organizationId: payment.organizationId,
    metadata: { purpose: payment.purpose, amountMinor: payment.amountMinor },
  });

  logger.info(`Settled payment ${payment.reference} (${payment.purpose})`);
  return { applied: true, payment, transaction };
}

/** Registration fee paid → activate the user (and their organization, if any). */
async function activateAfterRegistration(payment) {
  const user = await User.findById(payment.userId);
  if (user && user.status === ACCOUNT_STATUS.PENDING_PAYMENT) {
    user.status = ACCOUNT_STATUS.ACTIVE;
    await user.save();
  }
  if (payment.organizationId) {
    const org = await Organization.findById(payment.organizationId);
    if (org && org.status === ORG_STATUS.PENDING) {
      org.status = ORG_STATUS.ACTIVE;
      await org.save();
    }
  }
}

module.exports = { settlePayment };
