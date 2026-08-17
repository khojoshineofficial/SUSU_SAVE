'use strict';

const env = require('./config/env');
const { createApp } = require('./app');
const { connectDatabase, disconnectDatabase } = require('./config/db');
const { startScheduler, stopScheduler } = require('./jobs');
const { getSettings } = require('./services/settings.service');
const logger = require('./utils/logger');

async function start() {
  await connectDatabase();
  // Materialise the settings document on first boot so every fee lookup works.
  await getSettings({ fresh: true });

  // Hosts without a shell can provision staff here instead: BOOTSTRAP_STAFF=true
  // prints the credentials to the platform's log viewer exactly once.
  if (env.bootstrapStaff) {
    const staff = require('./services/staff.service');
    const results = await staff.provisionStaff({ reset: env.bootstrapStaffReset });
    logger.info(staff.formatCredentials(results, { reset: env.bootstrapStaffReset }));
    logger.warn('BOOTSTRAP_STAFF is set — remove it from the environment now that the credentials are printed.');
  }

  const app = createApp();
  const server = app.listen(env.port, () => {
    logger.info(`SUSU SAVE listening on port ${env.port} (${env.nodeEnv})`);
  });

  if (env.enableJobs) startScheduler();

  /**
   * Graceful shutdown: stop accepting connections, stop the scheduler mid-flight,
   * then close the database. A hard exit after 15s guards against a hung socket.
   */
  const shutdown = async (signal) => {
    logger.info(`${signal} received — shutting down`);
    const timer = setTimeout(() => {
      logger.error('Shutdown timed out; forcing exit');
      process.exit(1);
    }, 15000);
    timer.unref();

    stopScheduler();
    server.close(async () => {
      await disconnectDatabase();
      clearTimeout(timer);
      logger.info('Shutdown complete');
      process.exit(0);
    });
  };

  ['SIGTERM', 'SIGINT'].forEach((signal) => process.on(signal, () => shutdown(signal)));

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection:', reason);
  });
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception:', err);
    shutdown('uncaughtException');
  });

  return server;
}

if (require.main === module) {
  start().catch((err) => {
    logger.error('Failed to start SUSU SAVE:', err);
    process.exit(1);
  });
}

module.exports = { start };
