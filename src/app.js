'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const mongoose = require('mongoose');

const env = require('./config/env');
const routes = require('./routes');
const { notFoundHandler, errorHandler } = require('./middleware/error');
const { sanitize } = require('./middleware/validate');
const { apiLimiter } = require('./middleware/rateLimit');
const { getSettings } = require('./services/settings.service');
const themeController = require('./controllers/theme.controller');
const { asyncHandler } = require('./utils/http');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function createApp() {
  const app = express();

  // Render/most PaaS terminate TLS upstream, so trust the proxy for req.ip
  // and for `secure` cookies to behave correctly.
  app.set('trust proxy', 1);

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://unpkg.com', 'https://cdn.jsdelivr.net'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));

  app.use(cors({
    origin: env.corsOrigins.length ? env.corsOrigins : true,
    credentials: true,
  }));

  app.use(compression());
  app.use(cookieParser());

  // The raw body is retained so webhook signatures can be verified over exactly
  // the bytes the provider signed.
  const keepRawBody = (req, _res, buf) => { req.rawBody = buf.toString('utf8'); };
  const standardJson = express.json({ limit: '1mb', verify: keepRawBody });
  // Flyers, logos and favicons are uploaded as base64 data URLs, which are a
  // third larger than the file. Only the two super-admin routes that accept an
  // image get the bigger ceiling; everything else stays at 1mb.
  const uploadJson = express.json({ limit: '8mb', verify: keepRawBody });
  const UPLOAD_ROUTES = /^\/api\/admin\/(announcements|theme)\b/;

  app.use((req, res, next) => (
    UPLOAD_ROUTES.test(req.path) ? uploadJson(req, res, next) : standardJson(req, res, next)
  ));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(sanitize);

  if (env.nodeEnv !== 'test') {
    app.use(morgan(env.isProduction ? 'combined' : 'dev'));
  }

  /* --------------------------------- health --------------------------------- */

  app.get('/health', (req, res) => {
    const dbState = mongoose.connection.readyState;
    res.status(dbState === 1 ? 200 : 503).json({
      status: dbState === 1 ? 'ok' : 'degraded',
      database: ['disconnected', 'connected', 'connecting', 'disconnecting'][dbState] || 'unknown',
      uptimeSeconds: Math.round(process.uptime()),
      environment: env.nodeEnv,
      version: require('../package.json').version,
    });
  });

  /* ----------------------------------- api ---------------------------------- */

  // Maintenance mode blocks writes but leaves reads and auth working.
  app.use('/api', asyncHandler(async (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    // Admin, auth and scheduled jobs must keep working during maintenance.
    if (['/admin', '/auth', '/jobs'].some((prefix) => req.path.startsWith(prefix))) return next();

    const settings = await getSettings();
    if (settings.maintenanceMode) {
      return res.status(503).json({
        success: false,
        message: settings.maintenanceMessage || 'SUSU SAVE is under maintenance. Please try again shortly.',
        errorCode: 'MAINTENANCE_MODE',
      });
    }
    return next();
  }));

  app.use('/api', apiLimiter, routes);

  /* --------------------------------- frontend -------------------------------- */

  // Generated from the super admin's appearance settings and loaded by every
  // page after the design system, so it overrides tokens rather than replacing
  // the stylesheet. Declared before express.static so it is never shadowed.
  app.get('/theme.css', themeController.stylesheet);

  app.use(express.static(PUBLIC_DIR, { maxAge: env.isProduction ? '7d' : 0, index: false }));

  // Client-side routes are served by their own HTML file where one exists, and
  // fall back to the app shell otherwise.
  const PAGES = {
    '/': 'index.html',
    '/login': 'pages/login.html',
    '/register': 'pages/register.html',
    '/forgot-password': 'pages/forgot-password.html',
    '/reset-password': 'pages/reset-password.html',
    '/admin': 'pages/admin.html',
  };

  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    const explicit = PAGES[req.path];
    if (explicit) return res.sendFile(path.join(PUBLIC_DIR, explicit));
    if (req.path.startsWith('/admin')) return res.sendFile(path.join(PUBLIC_DIR, 'pages/admin.html'));
    // /join/<code> — a collector's public sign-up link. The code is read from
    // the path by the page itself.
    if (req.path.startsWith('/join/')) return res.sendFile(path.join(PUBLIC_DIR, 'pages/join.html'));
    return res.sendFile(path.join(PUBLIC_DIR, 'pages/app.html'));
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp, PUBLIC_DIR };
