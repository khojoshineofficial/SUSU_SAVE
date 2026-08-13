'use strict';

const express = require('express');
const crypto = require('crypto');
const { jobs } = require('../jobs');
const env = require('../config/env');
const ApiError = require('../utils/apiError');
const logger = require('../utils/logger');
const { asyncHandler, ok } = require('../utils/http');

/**
 * HTTP triggers for the scheduled jobs.
 *
 * On a long-running server the node-cron scheduler in src/jobs runs these
 * in-process and these routes are simply unused. On a serverless platform
 * (Vercel, Lambda) there is no process to hold a timer, so an external
 * scheduler — Vercel Cron, GitHub Actions, cron-job.org — calls these instead.
 *
 * Access is by shared secret only: never a user session, never a role. Vercel
 * Cron sends `Authorization: Bearer $CRON_SECRET`; anything else may send the
 * same value in `x-cron-secret`.
 */
const router = express.Router();

function authorize(req) {
  if (!env.cronSecret) {
    throw ApiError.forbidden('CRON_SECRET is not configured on this deployment', 'CRON_NOT_CONFIGURED');
  }

  const header = req.get('authorization') || '';
  const supplied = header.startsWith('Bearer ') ? header.slice(7).trim() : (req.get('x-cron-secret') || '');

  const a = Buffer.from(supplied);
  const b = Buffer.from(env.cronSecret);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw ApiError.unauthorized('Invalid cron secret', 'INVALID_CRON_SECRET');
  }
}

/**
 * The daily batch, in dependency order: mark what was missed, pay what is due,
 * then re-sync any group whose cycle drifted.
 */
const DAILY_SEQUENCE = [
  'markMissedContributions',
  'runDuePayouts',
  'advanceStalledGroups',
  'contributionReminders',
  'dueTodayReminders',
  'payoutReminders',
  'expireInvitations',
  'expireSubscriptions',
];

/** Run the whole daily batch — the endpoint a once-a-day cron should call. */
router.all('/run-daily', asyncHandler(async (req, res) => {
  authorize(req);

  const results = {};
  for (const name of DAILY_SEQUENCE) {
    try {
      // Sequential on purpose: these jobs touch the same rows.
      // eslint-disable-next-line no-await-in-loop
      results[name] = await jobs[name]({});
    } catch (err) {
      logger.error(`[job:${name}] failed:`, err.message);
      results[name] = { error: err.message };
    }
  }

  return ok(res, { ran: DAILY_SEQUENCE, results }, 'Daily jobs finished');
}));

/** Run a single named job, for monthly work or manual re-runs. */
router.all('/run/:name', asyncHandler(async (req, res) => {
  authorize(req);

  const name = req.params.name;
  if (!jobs[name]) {
    throw ApiError.badRequest(`Unknown job: ${name}`, 'UNKNOWN_JOB', { available: Object.keys(jobs) });
  }

  const result = await jobs[name]({});
  return ok(res, { job: name, result }, `Job ${name} finished`);
}));

module.exports = router;
