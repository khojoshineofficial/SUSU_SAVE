'use strict';

const cron = require('node-cron');
const {
  SusuGroup, Contribution, Payout, Invitation, Notification, Organization, Subscription, constants,
} = require('../models');
const { CONTRIBUTION_STATUS, PAYOUT_STATUS, GROUP_STATUS, TRANSACTION_TYPE, PAYMENT_METHOD } = constants;
const contributionService = require('../services/contribution.service');
const payoutService = require('../services/payout.service');
const notifications = require('../services/notification.service');
const ledger = require('../services/ledger.service');
const { getSettings } = require('../services/settings.service');
const dates = require('../utils/dates');
const logger = require('../utils/logger');

/**
 * Scheduled work. Every job is written to be safe to re-run: reminders are
 * deduped by `dedupeKey`, payouts by their ledger idempotency key, and status
 * sweeps only ever move rows that genuinely qualify.
 */

/** Remind members the day before a contribution is due. */
async function contributionReminders({ now = new Date() } = {}) {
  const tomorrow = dates.addDays(now, 1);
  const rows = await Contribution.find({
    dueDate: { $gte: dates.startOfDay(tomorrow), $lt: dates.addDays(tomorrow, 1) },
    status: { $in: [CONTRIBUTION_STATUS.PENDING, CONTRIBUTION_STATUS.PARTIAL] },
  }).lean();

  let sent = 0;
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    const group = await SusuGroup.findById(row.groupId).lean();
    if (!group) continue;
    // eslint-disable-next-line no-await-in-loop
    const created = await notifications.notify({
      userId: row.userId,
      organizationId: row.organizationId,
      ...notifications.templates.contributionDue(
        group,
        row.expectedAmountMinor - row.paidAmountMinor,
        row.dueDate,
      ),
      dedupeKey: `due-1d:${row._id}`,
    });
    if (created) sent += 1;
  }
  return { sent };
}

/** Remind on the due date itself. */
async function dueTodayReminders({ now = new Date() } = {}) {
  const rows = await Contribution.find({
    dueDate: { $gte: dates.startOfDay(now), $lt: dates.addDays(now, 1) },
    status: { $in: [CONTRIBUTION_STATUS.PENDING, CONTRIBUTION_STATUS.PARTIAL] },
  }).lean();

  let sent = 0;
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    const group = await SusuGroup.findById(row.groupId).lean();
    if (!group) continue;
    // eslint-disable-next-line no-await-in-loop
    const created = await notifications.notify({
      userId: row.userId,
      organizationId: row.organizationId,
      ...notifications.templates.contributionDue(group, row.expectedAmountMinor - row.paidAmountMinor, row.dueDate),
      dedupeKey: `due-today:${row._id}`,
    });
    if (created) sent += 1;
  }
  return { sent };
}

/** Tell recipients a few days before their payout lands. */
async function payoutReminders({ now = new Date(), daysAhead = 3 } = {}) {
  const target = dates.addDays(now, daysAhead);
  const rows = await Payout.find({
    scheduledDate: { $gte: dates.startOfDay(target), $lt: dates.addDays(target, 1) },
    status: { $in: [PAYOUT_STATUS.SCHEDULED, PAYOUT_STATUS.READY] },
  }).lean();

  let sent = 0;
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    const group = await SusuGroup.findById(row.groupId).lean();
    if (!group) continue;
    // eslint-disable-next-line no-await-in-loop
    const created = await notifications.notify({
      userId: row.recipientId,
      organizationId: row.organizationId,
      ...notifications.templates.payoutUpcoming(group, row.expectedAmountMinor, row.scheduledDate),
      dedupeKey: `payout-soon:${row._id}`,
      alsoEmail: true,
    });
    if (created) sent += 1;
  }
  return { sent };
}

/** Roll a group forward when its collection window has closed without a payout. */
async function advanceStalledGroups({ now = new Date() } = {}) {
  const groups = await SusuGroup.find({ status: GROUP_STATUS.ACTIVE }).lean();
  let advanced = 0;

  for (const group of groups) {
    // eslint-disable-next-line no-await-in-loop
    const pending = await Payout.findOne({
      groupId: group._id,
      status: { $ne: PAYOUT_STATUS.COMPLETED },
    }).sort({ cycle: 1 }).lean();
    if (!pending) continue;

    const expectedCycle = pending.cycle;
    if (group.currentCycle !== expectedCycle && new Date(pending.scheduledDate) > now) {
      // eslint-disable-next-line no-await-in-loop
      await SusuGroup.updateOne({ _id: group._id }, { $set: { currentCycle: expectedCycle } });
      advanced += 1;
    }
  }
  return { advanced };
}

/** Charge the monthly platform fee to organizations on a paid plan. */
async function monthlyPlatformFees({ now = new Date() } = {}) {
  const settings = await getSettings();
  const feeMinor = settings.fees.monthlyPlatformFeeMinor;
  if (!feeMinor) return { charged: 0 };

  const organizations = await Organization.find({ status: 'active' }).lean();
  const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  let charged = 0;

  for (const org of organizations) {
    // eslint-disable-next-line no-await-in-loop
    await ledger.record({
      userId: org.adminId,
      organizationId: org._id,
      type: TRANSACTION_TYPE.PLATFORM_FEE,
      grossAmountMinor: feeMinor,
      paymentMethod: PAYMENT_METHOD.SYSTEM,
      description: `Monthly platform fee (${period})`,
      // One charge per organization per month, whatever happens to the schedule.
      idempotencyKey: `platform-fee:${org._id}:${period}`,
    });
    charged += 1;
  }
  return { charged };
}

async function expireInvitations({ now = new Date() } = {}) {
  const result = await Invitation.updateMany(
    { status: 'pending', expiresAt: { $lt: now } },
    { $set: { status: 'expired' } },
  );
  return { expired: result.modifiedCount || 0 };
}

async function expireSubscriptions({ now = new Date() } = {}) {
  const result = await Subscription.updateMany(
    { status: 'active', currentPeriodEnd: { $lt: now } },
    { $set: { status: 'past_due' } },
  );
  return { pastDue: result.modifiedCount || 0 };
}

/** Read notifications older than 90 days are noise; drop them. */
async function cleanupNotifications({ now = new Date(), days = 90 } = {}) {
  const result = await Notification.deleteMany({
    readAt: { $ne: null, $lt: dates.addDays(now, -days) },
  });
  return { removed: result.deletedCount || 0 };
}

const jobs = {
  contributionReminders,
  dueTodayReminders,
  payoutReminders,
  markMissedContributions: contributionService.markMissedContributions,
  runDuePayouts: payoutService.runDuePayouts,
  advanceStalledGroups,
  monthlyPlatformFees,
  expireInvitations,
  expireSubscriptions,
  cleanupNotifications,
};

const tasks = [];

const wrap = (name, fn) => async () => {
  try {
    const result = await fn({});
    logger.info(`[job:${name}]`, JSON.stringify(result));
  } catch (err) {
    logger.error(`[job:${name}] failed:`, err.message);
  }
};

/** Called once from server.js after the database connects. */
function startScheduler() {
  const schedule = [
    ['0 8 * * *', 'contributionReminders'],
    ['0 9 * * *', 'dueTodayReminders'],
    ['30 9 * * *', 'payoutReminders'],
    ['0 1 * * *', 'markMissedContributions'],
    ['0 2 * * *', 'runDuePayouts'],
    ['15 2 * * *', 'advanceStalledGroups'],
    ['0 3 1 * *', 'monthlyPlatformFees'],
    ['0 4 * * *', 'expireInvitations'],
    ['20 4 * * *', 'expireSubscriptions'],
    ['0 5 * * 0', 'cleanupNotifications'],
  ];

  schedule.forEach(([expression, name]) => {
    tasks.push(cron.schedule(expression, wrap(name, jobs[name]), { timezone: 'Africa/Accra' }));
  });

  logger.info(`Scheduler started with ${tasks.length} jobs`);
  return tasks;
}

function stopScheduler() {
  tasks.forEach((task) => task.stop());
  tasks.length = 0;
}

module.exports = { jobs, startScheduler, stopScheduler };
