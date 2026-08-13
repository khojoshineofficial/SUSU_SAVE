'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
process.env.ENABLE_JOBS = 'false';
process.env.LOG_LEVEL = 'error';

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let mongod;
let skipReason = null;

/**
 * Starts an ephemeral MongoDB.
 *
 * Set MONGODB_TEST_URI to point at a real server (a replica set, Atlas, or a
 * local mongod); otherwise an in-memory server is downloaded on first run.
 * In a sandbox with no access to the MongoDB download host the suite reports
 * the reason and skips rather than failing with a confusing network error.
 */
async function startDatabase() {
  const uri = process.env.MONGODB_TEST_URI;
  try {
    if (uri) {
      await mongoose.connect(uri);
    } else {
      mongod = await MongoMemoryServer.create();
      await mongoose.connect(mongod.getUri('susu_save_test'));
    }
    return mongoose.connection;
  } catch (err) {
    skipReason = `MongoDB is unavailable for tests: ${err.message.split('\n')[0]}`;
    return null;
  }
}

/** True once startDatabase has succeeded. Guards every DB-backed test. */
const dbReady = () => mongoose.connection.readyState === 1;
const dbSkipReason = () => skipReason || 'MongoDB not connected';

/**
 * Registers a test that needs a database. The check happens when the test runs,
 * not when it is registered, so it sees the result of the `before` hook.
 */
const dbTest = (name, fn) => require('node:test')(name, async (t) => {
  if (!dbReady()) {
    t.skip(dbSkipReason());
    return;
  }
  await fn(t);
});

async function stopDatabase() {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  await mongod?.stop();
}

async function resetDatabase() {
  if (!dbReady()) return;
  const models = require('../src/models');
  await Promise.all(
    Object.values(models)
      .filter((m) => typeof m?.deleteMany === 'function')
      .map((m) => m.deleteMany({})),
  );
  require('../src/services/settings.service').invalidate();
}

/** Create an active user with a funded wallet, bypassing the payment flow. */
async function makeUser(overrides = {}) {
  const { User, constants } = require('../src/models');
  const ledger = require('../src/services/ledger.service');
  const money = require('../src/utils/money');

  const suffix = Math.random().toString(36).slice(2, 8);
  const user = await User.create({
    firstName: overrides.firstName || 'Test',
    lastName: overrides.lastName || 'User',
    email: overrides.email || `user-${suffix}@test.local`,
    phone: overrides.phone || `02440${suffix.slice(0, 5)}`,
    passwordHash: await User.hashPassword(overrides.password || 'Password123'),
    role: overrides.role || constants.ROLES.USER,
    organizationId: overrides.organizationId || null,
    status: constants.ACCOUNT_STATUS.ACTIVE,
    emailVerified: true,
  });

  await ledger.getOrCreateWallet(user._id, user.organizationId);
  const fund = overrides.fundMajor ?? 5000;
  if (fund > 0) {
    await ledger.post({
      userId: user._id,
      organizationId: user.organizationId,
      type: constants.TRANSACTION_TYPE.DEPOSIT,
      grossAmountMinor: money.toMinor(fund),
      paymentMethod: constants.PAYMENT_METHOD.SYSTEM,
      description: 'Test funding',
    });
  }
  return user;
}

/** Build an activated group with the given members, ready to collect. */
async function makeActiveGroup({ organizer, members = [], contributionAmount = 100, frequency = 'weekly', startDate = new Date() }) {
  const groupService = require('../src/services/group.service');
  const { GroupMember, constants } = require('../src/models');

  const { group } = await groupService.createGroup({
    actor: organizer,
    payload: {
      name: `Test Group ${Math.random().toString(36).slice(2, 6)}`,
      contributionAmount,
      contributionFrequency: frequency,
      memberLimit: members.length + 1,
      startDate,
    },
  });

  for (const member of members) {
    // eslint-disable-next-line no-await-in-loop
    await GroupMember.create({
      groupId: group._id,
      userId: member._id,
      status: constants.GROUP_MEMBER_STATUS.ACTIVE,
      payoutPosition: await groupService.nextPayoutPosition(group._id),
      approvedAt: new Date(),
    });
  }
  await groupService.refreshMemberStats(group._id);
  await groupService.activateGroup(group);
  return group;
}

const walletOf = async (user) => require('../src/models').Wallet.findOne({ userId: user._id }).lean();

module.exports = {
  startDatabase, stopDatabase, resetDatabase, makeUser, makeActiveGroup, walletOf,
  dbReady, dbSkipReason, dbTest,
};
