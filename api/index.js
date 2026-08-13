'use strict';

/**
 * Vercel serverless entry point.
 *
 * Vercel does not run `src/server.js` — there is no long-lived process to
 * listen on a port. It imports this module and calls the exported handler once
 * per request, reusing a warm container when it can.
 *
 * Two consequences the rest of the codebase depends on:
 *   1. The Mongoose connection is cached on `globalThis` (see src/config/db.js)
 *      so a warm container reuses it instead of opening a socket per request.
 *   2. The node-cron scheduler never starts here. Scheduled work is triggered
 *      over HTTP at /api/jobs/run-daily — see vercel.json's `crons` block.
 */

const { createApp } = require('../src/app');
const { connectDatabase } = require('../src/config/db');
const logger = require('../src/utils/logger');

const app = createApp();

let connecting = null;

/**
 * One shared connection attempt per container. A failed attempt clears the
 * cache so the next request retries — and it rejects rather than resolving,
 * so a request is never served against a database that is not there.
 */
function getConnection() {
  if (!connecting) {
    connecting = connectDatabase().catch((err) => {
      connecting = null;
      throw err;
    });
  }
  return connecting;
}

// Start connecting at module load so a cold start overlaps the connect with the
// rest of the boot instead of paying for it on the first request.
getConnection().catch((err) => logger.error('Initial database connection failed:', err.message));

module.exports = async (req, res) => {
  try {
    await getConnection();
  } catch (err) {
    logger.error('Database unavailable for request:', err.message);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      success: false,
      message: 'The database is temporarily unavailable. Please try again shortly.',
      errorCode: 'DATABASE_UNAVAILABLE',
    }));
    return;
  }

  app(req, res);
};
