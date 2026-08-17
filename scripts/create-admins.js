'use strict';

/**
 * Provisions the two staff accounts and prints their credentials once.
 *
 *   npm run create-admins            create both, generating credentials
 *   npm run create-admins -- --reset rotate the credentials of existing accounts
 *
 * The provisioning itself lives in src/services/staff.service.js so that this
 * script and the boot-time BOOTSTRAP_STAFF path produce identical accounts.
 * Credentials are printed exactly once — nothing stores the plaintext, so if the
 * output is lost the only way back is to run this again with --reset.
 *
 * Both accounts can change their own username and password from the console
 * afterwards (My account tab), which is the intended path once they sign in.
 */

const { connectDatabase, disconnectDatabase } = require('../src/config/db');
const { provisionStaff, formatCredentials } = require('../src/services/staff.service');
const logger = require('../src/utils/logger');

const reset = process.argv.includes('--reset');

(async () => {
  await connectDatabase();
  const results = await provisionStaff({ reset });
  // Straight to stdout: this is the script's entire output, not a log line.
  // eslint-disable-next-line no-console
  console.log(formatCredentials(results, { reset }));
  await disconnectDatabase();
})().catch(async (err) => {
  logger.error('Failed to provision staff accounts:', err.message);
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
