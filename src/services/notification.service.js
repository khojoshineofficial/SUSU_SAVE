'use strict';

const { Notification, User } = require('../models');
const money = require('../utils/money');
const dates = require('../utils/dates');
const email = require('./email.service');
const logger = require('../utils/logger');

const DUPLICATE_KEY = 11000;

/**
 * Creating a notification is best-effort: it must never fail the financial
 * action that triggered it. `dedupeKey` makes reminder jobs safe to re-run.
 */
async function notify({ userId, organizationId = null, type, title, body, link = null, icon = 'bell', dedupeKey = null, metadata = {}, alsoEmail = false }) {
  try {
    const notification = await Notification.create({
      userId, organizationId, type, title, body, link, icon, dedupeKey, metadata,
    });

    if (alsoEmail) {
      const user = await User.findById(userId).lean();
      if (user?.notificationPreferences?.email !== false && user?.email) {
        await email.send({ to: user.email, subject: title, text: body });
      }
    }
    return notification;
  } catch (err) {
    if (err?.code === DUPLICATE_KEY) return null; // already sent for this event
    logger.error('Failed to create notification', type, err.message);
    return null;
  }
}

const templates = {
  contributionDue: (group, amountMinor, dueDate) => ({
    type: 'contribution_due',
    title: 'Contribution due',
    body: `Your ${money.format(amountMinor)} contribution to ${group.name} is due ${dates.relativeLabel(dueDate).toLowerCase()}.`,
    icon: 'calendar-clock',
    link: `/groups/${group._id}`,
  }),

  contributionSuccessful: (group, amountMinor) => ({
    type: 'contribution_successful',
    title: 'Contribution received',
    body: `We received your ${money.format(amountMinor)} contribution to ${group.name}.`,
    icon: 'check-circle',
    link: `/groups/${group._id}`,
  }),

  contributionMissed: (group, amountMinor) => ({
    type: 'contribution_missed',
    title: 'Missed contribution',
    body: `You missed your ${money.format(amountMinor)} contribution to ${group.name}.`,
    icon: 'alert-circle',
    link: `/groups/${group._id}`,
  }),

  payoutUpcoming: (group, amountMinor, date) => ({
    type: 'payout_upcoming',
    title: 'Your payout is coming',
    body: `Your payout of ${money.format(amountMinor)} from ${group.name} is scheduled for ${dates.formatDate(date)}.`,
    icon: 'gift',
    link: `/groups/${group._id}`,
  }),

  payoutCompleted: (group, amountMinor) => ({
    type: 'payout_completed',
    title: 'Payout received',
    body: `${money.format(amountMinor)} from ${group.name} has been credited to your wallet.`,
    icon: 'banknote',
    link: '/wallet',
  }),

  groupJoinRequest: (group, applicantName) => ({
    type: 'group_join_request',
    title: 'New join request',
    body: `${applicantName} asked to join ${group.name}.`,
    icon: 'user-plus',
    link: `/groups/${group._id}/members`,
  }),

  groupMemberApproved: (group) => ({
    type: 'group_member_approved',
    title: 'You are in!',
    body: `Your membership of ${group.name} has been approved.`,
    icon: 'users',
    link: `/groups/${group._id}`,
  }),

  withdrawalRequested: (amountMinor) => ({
    type: 'withdrawal_requested',
    title: 'Withdrawal requested',
    body: `Your withdrawal of ${money.format(amountMinor)} is being reviewed.`,
    icon: 'arrow-up-right',
    link: '/wallet',
  }),

  withdrawalCompleted: (amountMinor) => ({
    type: 'withdrawal_completed',
    title: 'Withdrawal sent',
    body: `${money.format(amountMinor)} has been sent to your mobile money account.`,
    icon: 'check-circle',
    link: '/wallet',
  }),

  withdrawalFailed: (amountMinor, reason) => ({
    type: 'withdrawal_failed',
    title: 'Withdrawal failed',
    body: `Your withdrawal of ${money.format(amountMinor)} could not be completed. ${reason || ''}`.trim(),
    icon: 'alert-triangle',
    link: '/wallet',
  }),

  savingsMilestone: (plan, percent) => ({
    type: 'savings_milestone',
    title: `${percent}% of your goal reached`,
    body: `You have saved ${money.format(plan.currentAmountMinor)} towards ${plan.name}. Keep going!`,
    icon: 'target',
    link: `/savings/${plan._id}`,
  }),

  registrationPayment: (amountMinor) => ({
    type: 'registration_payment',
    title: 'Registration complete',
    body: `Your registration fee of ${money.format(amountMinor)} was received. Your account is now active.`,
    icon: 'badge-check',
    link: '/dashboard',
  }),
};

const markRead = (userId, notificationId) =>
  Notification.findOneAndUpdate({ _id: notificationId, userId, readAt: null }, { readAt: new Date() }, { new: true });

const markAllRead = (userId) =>
  Notification.updateMany({ userId, readAt: null }, { readAt: new Date() });

const unreadCount = (userId) => Notification.countDocuments({ userId, readAt: null });

module.exports = { notify, templates, markRead, markAllRead, unreadCount };
