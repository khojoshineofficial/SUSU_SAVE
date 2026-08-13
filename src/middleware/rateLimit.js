'use strict';

const rateLimit = require('express-rate-limit');
const env = require('../config/env');

const message = (text, code) => ({ success: false, message: text, errorCode: code });

const base = {
  standardHeaders: true,
  legacyHeaders: false,
  // Rate limiting distorts test timing; disable it outside real deployments.
  skip: () => env.nodeEnv === 'test',
};

/** Broad protection for the whole API surface. */
const apiLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: 600,
  message: message('Too many requests. Please slow down.', 'RATE_LIMITED'),
});

/** Credential endpoints are the ones worth brute-forcing, so they are tighter. */
const authLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: 12,
  skipSuccessfulRequests: true,
  message: message('Too many attempts. Try again in a few minutes.', 'RATE_LIMITED'),
});

/** Money-moving endpoints: enough for real use, low enough to blunt scripting. */
const financialLimiter = rateLimit({
  ...base,
  windowMs: 60 * 1000,
  limit: 20,
  message: message('Too many financial requests. Please wait a moment.', 'RATE_LIMITED'),
});

module.exports = { apiLimiter, authLimiter, financialLimiter };
