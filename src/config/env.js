'use strict';

require('dotenv').config();

const required = (key, fallback) => {
  const value = process.env[key] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};

const isProduction = process.env.NODE_ENV === 'production';

// In production every secret must be supplied explicitly. In development we
// fall back to obvious placeholders so `npm run dev` works out of the box.
const devFallback = (value) => (isProduction ? undefined : value);

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction,
  port: Number(process.env.PORT || 3000),
  appUrl: process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`,

  mongoUri: required('MONGODB_URI', devFallback('mongodb://127.0.0.1:27017/susu_save')),

  jwt: {
    secret: required('JWT_SECRET', devFallback('dev-access-secret-change-me')),
    refreshSecret: required('JWT_REFRESH_SECRET', devFallback('dev-refresh-secret-change-me')),
    accessTtl: process.env.JWT_ACCESS_TTL || '30m',
    refreshTtl: process.env.JWT_REFRESH_TTL || '30d',
  },

  currency: process.env.CURRENCY || 'GHS',
  currencySymbol: process.env.CURRENCY_SYMBOL || 'GH₵',
  country: process.env.DEFAULT_COUNTRY || 'Ghana',

  payment: {
    provider: process.env.PAYMENT_PROVIDER || 'mock',
    key: process.env.PAYMENT_PROVIDER_KEY || '',
    secret: process.env.PAYMENT_PROVIDER_SECRET || '',
    webhookSecret: process.env.PAYMENT_WEBHOOK_SECRET || 'dev-webhook-secret',
  },

  email: {
    driver: process.env.EMAIL_DRIVER || 'console',
    host: process.env.EMAIL_HOST || '',
    port: Number(process.env.EMAIL_PORT || 587),
    user: process.env.EMAIL_USER || '',
    password: process.env.EMAIL_PASSWORD || '',
    from: process.env.EMAIL_FROM || 'SUSU SAVE <no-reply@sususave.app>',
  },

  adminEmail: process.env.ADMIN_EMAIL || 'admin@sususave.app',

  // Vercel/Lambda set these. On a serverless platform there is no long-lived
  // process, so the in-process cron scheduler is never started — jobs are
  // triggered over HTTP instead (see src/routes/jobs.routes.js).
  isServerless: Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME),
  enableJobs: process.env.ENABLE_JOBS !== 'false'
    && !process.env.VERCEL && !process.env.AWS_LAMBDA_FUNCTION_NAME,
  /** Shared secret required to trigger scheduled jobs over HTTP. */
  cronSecret: process.env.CRON_SECRET || '',

  corsOrigins: (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
};

module.exports = env;
