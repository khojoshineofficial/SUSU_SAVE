'use strict';

/**
 * Provisions the two staff accounts and prints their credentials once.
 *
 *   npm run create-admins            create both, generating credentials
 *   npm run create-admins -- --reset rotate the passwords of existing accounts
 *
 * Credentials are generated here rather than hard-coded anywhere: the username
 * carries random entropy so it cannot be guessed from the platform name, and
 * the password is drawn from crypto.randomBytes. They are printed exactly once
 * — nothing stores the plaintext, so if the output is lost the only way back is
 * to run this again with --reset.
 *
 * Both accounts can change their own username and password from the console
 * afterwards (Account tab), which is the intended path once they have signed in.
 */

const crypto = require('crypto');
const { connectDatabase, disconnectDatabase } = require('../src/config/db');
const { User, constants } = require('../src/models');
const ledger = require('../src/services/ledger.service');
const audit = require('../src/services/audit.service');
const logger = require('../src/utils/logger');

const { ROLES, ACCOUNT_STATUS } = constants;
const reset = process.argv.includes('--reset');

/** Unambiguous alphabet: no O/0, l/1 confusion when typing a password by hand. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const SYMBOLS = '!@#$%^&*-_=+';

function randomFrom(pool, length) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += pool[bytes[i] % pool.length];
  return out;
}

/**
 * 20 characters mixing both pools. Well beyond anything a brute force reaches,
 * and still typable if someone has to read it off a screen.
 */
const generatePassword = () => `${randomFrom(ALPHABET, 16)}${randomFrom(SYMBOLS, 2)}${randomFrom('23456789', 2)}`;

/** e.g. "susu.owner.7f3k" — recognisable, but not guessable. */
const generateUsername = (prefix) => `${prefix}.${randomFrom('abcdefghijkmnopqrstuvwxyz23456789', 4)}`;

const STAFF = [
  {
    key: 'SUPER ADMIN',
    role: ROLES.SUPER_ADMIN,
    firstName: 'Platform',
    lastName: 'Owner',
    email: process.env.SUPER_ADMIN_EMAIL || 'owner@sususave.app',
    usernamePrefix: 'susu.owner',
    powers: 'Everything: settings, fees, maintenance mode, plans, roles, organizations.',
  },
  {
    key: 'ADMIN',
    role: ROLES.ADMIN,
    firstName: 'Platform',
    lastName: 'Admin',
    email: process.env.ADMIN_EMAIL || 'admin@sususave.app',
    usernamePrefix: 'susu.admin',
    powers: 'Payment analysis, approving and rejecting withdrawals, audit records.',
  },
];

async function provision(spec) {
  const password = generatePassword();
  const passwordHash = await User.hashPassword(password);

  let user = await User.findOne({ email: spec.email });

  if (user && !reset) {
    return { ...spec, username: user.username, password: null, created: false };
  }

  if (user) {
    // --reset: rotate the password and issue a fresh username.
    user.passwordHash = passwordHash;
    user.username = generateUsername(spec.usernamePrefix);
    user.role = spec.role;
    user.status = ACCOUNT_STATUS.ACTIVE;
    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
    await user.save();
  } else {
    user = await User.create({
      firstName: spec.firstName,
      lastName: spec.lastName,
      email: spec.email,
      username: generateUsername(spec.usernamePrefix),
      phone: null,
      passwordHash,
      role: spec.role,
      status: ACCOUNT_STATUS.ACTIVE,
      emailVerified: true,
      onboardingCompleted: true,
    });
  }

  await ledger.getOrCreateWallet(user._id, null);
  await audit.log({
    action: reset ? 'staff.credentials_reset' : 'staff.account_provisioned',
    entityType: 'User',
    entityId: user._id,
    metadata: { role: spec.role },
  });

  return { ...spec, username: user.username, password, created: true };
}

(async () => {
  await connectDatabase();

  const results = [];
  for (const spec of STAFF) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await provision(spec));
  }

  /* eslint-disable no-console */
  console.log(`
══════════════════════════════════════════════════════════════
  SUSU SAVE — staff credentials
  Shown once. Save them now; they are not stored anywhere.
══════════════════════════════════════════════════════════════`);

  results.forEach((r) => {
    console.log(`
  ${r.key}
  ────────────────────────────────────────────────────────────
  Sign in at   /login  (username or email both work)
  Username     ${r.username}
  Email        ${r.email}
  Password     ${r.password || '(unchanged — account already existed)'}
  Access       ${r.powers}`);
  });

  if (results.some((r) => !r.created)) {
    console.log(`
  Some accounts already existed and were left alone.
  Run with --reset to rotate their username and password:
      npm run create-admins -- --reset`);
  }

  console.log(`
  Both accounts can change their own username and password
  from the console's Account tab once signed in.
══════════════════════════════════════════════════════════════
`);
  /* eslint-enable no-console */

  await disconnectDatabase();
})().catch(async (err) => {
  logger.error('Failed to provision staff accounts:', err.message);
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
