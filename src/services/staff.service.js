'use strict';

const crypto = require('crypto');
const { User, constants } = require('../models');
const ledger = require('./ledger.service');
const audit = require('./audit.service');

const { ROLES, ACCOUNT_STATUS } = constants;

/**
 * Provisioning for the two staff accounts.
 *
 * Shared by `npm run create-admins` and by the one-shot bootstrap at server
 * start, so both produce identical accounts. Credentials are generated here and
 * returned to the caller exactly once — the plaintext is never stored, so a lost
 * password can only be replaced, never recovered.
 */

/** Unambiguous alphabet: no O/0 or l/1 confusion when typing by hand. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const SYMBOLS = '!@#$%^&*-_=+';
const DIGITS = '23456789';

function randomFrom(pool, length) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += pool[bytes[i] % pool.length];
  return out;
}

/** 20 characters: far beyond brute force, still readable off a screen. */
const generatePassword = () => `${randomFrom(ALPHABET, 16)}${randomFrom(SYMBOLS, 2)}${randomFrom(DIGITS, 2)}`;

/** e.g. "susu.owner.7f3k" — recognisable, not guessable. */
const generateUsername = (prefix) => `${prefix}.${randomFrom('abcdefghijkmnopqrstuvwxyz23456789', 4)}`;

/** The shortest password we will accept from an operator. */
const MIN_PASSWORD_LENGTH = 10;

const STAFF = [
  {
    key: 'SUPER ADMIN',
    role: ROLES.SUPER_ADMIN,
    firstName: 'Platform',
    lastName: 'Owner',
    email: process.env.SUPER_ADMIN_EMAIL || 'owner@sususave.app',
    usernamePrefix: 'susu.owner',
    envPrefix: 'SUPER_ADMIN',
    powers: 'Everything: settings, fees, maintenance mode, plans, roles, organizations.',
  },
  {
    key: 'ADMIN',
    role: ROLES.ADMIN,
    firstName: 'Platform',
    lastName: 'Admin',
    email: process.env.ADMIN_EMAIL || 'admin@sususave.app',
    usernamePrefix: 'susu.admin',
    envPrefix: 'ADMIN',
    powers: 'Payment analysis, approving and rejecting withdrawals, audit records.',
  },
];

/**
 * Credentials supplied by the operator, e.g. SUPER_ADMIN_USERNAME and
 * SUPER_ADMIN_PASSWORD. Chosen credentials are authoritative: when they are
 * present the account is synced to them on every run, so changing the variable
 * and redeploying is a working password reset. Bad values throw rather than
 * being silently ignored — an admin who cannot sign in has no other recourse.
 */
function readChosen(spec) {
  const username = process.env[`${spec.envPrefix}_USERNAME`];
  const password = process.env[`${spec.envPrefix}_PASSWORD`];

  if (password && password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`${spec.envPrefix}_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  return {
    // Throws with a readable message if the username is not a legal one.
    username: username ? User.normaliseUsername(username) : null,
    password: password || null,
  };
}

/**
 * Creates a staff account, or rotates its credentials when `reset` is set.
 * An existing account is left untouched otherwise, so this is safe to re-run.
 */
async function provisionOne(spec, { reset = false } = {}) {
  let user = await User.findOne({ email: spec.email });
  const chosen = readChosen(spec);

  // Nothing to do only when the account exists, no credentials were chosen for
  // it, and this is not a reset.
  if (user && !reset && !chosen.username && !chosen.password) {
    return { ...spec, username: user.username, password: null, created: false };
  }

  // An existing account keeps its password unless one was chosen or this is a
  // reset — renaming an admin must not lock them out.
  const keepPassword = Boolean(user) && !chosen.password && !reset;
  const password = keepPassword ? null : (chosen.password || generatePassword());
  const passwordHash = password ? await User.hashPassword(password) : null;

  if (user) {
    // Keep the existing username when only the password was chosen.
    const username = chosen.username || (reset ? generateUsername(spec.usernamePrefix) : user.username);
    if (passwordHash) user.passwordHash = passwordHash;
    user.username = username;
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
      username: chosen.username || generateUsername(spec.usernamePrefix),
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

  return {
    ...spec,
    username: user.username,
    // A chosen password is never echoed back: the operator already has it, and
    // it would otherwise end up in the hosting platform's log.
    password: chosen.password ? null : password,
    chosenPassword: Boolean(chosen.password),
    keptPassword: keepPassword,
    created: true,
  };
}

async function provisionStaff({ reset = false } = {}) {
  const results = [];
  for (const spec of STAFF) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await provisionOne(spec, { reset }));
  }
  return results;
}

function describePassword(r) {
  if (r.password) return r.password;
  if (r.chosenPassword) return `(the one you set in ${r.envPrefix}_PASSWORD)`;
  return '(unchanged — account already existed)';
}

/** The credential block, formatted for a terminal or a hosting platform's log. */
function formatCredentials(results, { reset = false } = {}) {
  const lines = [
    '',
    '══════════════════════════════════════════════════════════════',
    '  SUSU SAVE — staff credentials',
    '  Shown once. Save them now; the passwords are not stored.',
    '══════════════════════════════════════════════════════════════',
  ];

  results.forEach((r) => {
    lines.push(
      '',
      `  ${r.key}`,
      '  ────────────────────────────────────────────────────────────',
      '  Sign in at   /login   (username or email both work)',
      `  Username     ${r.username}`,
      `  Email        ${r.email}`,
      `  Password     ${describePassword(r)}`,
      `  Access       ${r.powers}`,
    );
  });

  if (!reset && results.some((r) => !r.created)) {
    lines.push(
      '',
      '  Some accounts already existed and were left alone.',
      '  To rotate their username and password:  npm run create-admins -- --reset',
    );
  }

  lines.push(
    '',
    "  Both accounts can change their own username and password from",
    "  the console's My account tab once signed in.",
    '══════════════════════════════════════════════════════════════',
    '',
  );
  return lines.join('\n');
}

module.exports = { provisionStaff, formatCredentials, STAFF };
