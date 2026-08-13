'use strict';

/**
 * Development seed. Creates a Super Admin, an organization with its admin,
 * a handful of Ghanaian demo users, two live SUSU groups with real contribution
 * and payout history, individual savings, rent savings and notifications.
 *
 *   npm run seed            # wipes and reseeds the configured database
 *   npm run seed -- --keep  # seed without dropping existing data
 */

const mongoose = require('mongoose');
const { connectDatabase, disconnectDatabase } = require('../src/config/db');
const models = require('../src/models');
const {
  User, Organization, SusuGroup, GroupMember, SavingsPlan, Plan, SystemSetting,
  Notification, constants,
} = models;
const { ROLES, ACCOUNT_STATUS, ORG_STATUS, GROUP_ROLE, GROUP_MEMBER_STATUS, SAVINGS_TYPE, FREQUENCY } = constants;

const groupService = require('../src/services/group.service');
const contributionService = require('../src/services/contribution.service');
const payoutService = require('../src/services/payout.service');
const ledger = require('../src/services/ledger.service');
const settlement = require('../src/services/settlement.service');
const paymentService = require('../src/services/payment');
const savingsService = require('../src/services/savings.service');
const money = require('../src/utils/money');
const dates = require('../src/utils/dates');
const logger = require('../src/utils/logger');

const PASSWORD = 'Password123';
const keepExisting = process.argv.includes('--keep');

const PEOPLE = [
  ['Ama', 'Mensah', 'ama@sususave.test', '0244000001'],
  ['Kofi', 'Owusu', 'kofi@sususave.test', '0244000002'],
  ['Afia', 'Boateng', 'afia@sususave.test', '0244000003'],
  ['Kwame', 'Asante', 'kwame@sususave.test', '0244000004'],
  ['Akosua', 'Darko', 'akosua@sususave.test', '0244000005'],
  ['Yaa', 'Agyeman', 'yaa@sususave.test', '0244000006'],
  ['Kojo', 'Nkrumah', 'kojo@sususave.test', '0244000007'],
  ['Abena', 'Appiah', 'abena@sususave.test', '0244000008'],
  ['Daniel', 'Tetteh', 'daniel@sususave.test', '0244000009'],
  ['Michael', 'Quartey', 'michael@sususave.test', '0244000010'],
];

async function wipe() {
  const names = Object.keys(models).filter((key) => models[key]?.deleteMany);
  await Promise.all(names.map((name) => models[name].deleteMany({})));
  logger.info(`Cleared ${names.length} collections`);
}

async function createUser({ firstName, lastName, email, phone, role = ROLES.USER, organizationId = null }) {
  const user = await User.create({
    firstName,
    lastName,
    email,
    phone,
    passwordHash: await User.hashPassword(PASSWORD),
    role,
    organizationId,
    status: ACCOUNT_STATUS.ACTIVE,
    emailVerified: true,
    region: 'Greater Accra',
    onboardingCompleted: true,
  });
  await ledger.getOrCreateWallet(user._id, organizationId);
  return user;
}

/** Fund a wallet the way real money arrives: a payment that settles. */
async function fundWallet(user, majorAmount) {
  const payment = await paymentService.initiatePayment({
    userId: user._id,
    organizationId: user.organizationId,
    purpose: 'wallet_topup',
    amountMinor: money.toMinor(majorAmount),
    method: 'mobile_money',
    payerIdentifier: user.phone,
  });
  await settlement.settlePayment(payment, { verifiedStatus: 'successful' });
}

async function seed() {
  await connectDatabase();
  if (!keepExisting) await wipe();

  /* ------------------------------- settings ------------------------------- */

  await SystemSetting.deleteMany({});
  await SystemSetting.create({
    key: 'platform',
    fees: {
      registrationFeeMinor: money.toMinor(20),
      monthlyPlatformFeeMinor: money.toMinor(5),
      groupCreationFeeMinor: 0,
      savingsFeePercent: 1,
      withdrawalFeePercent: 0.5,
      withdrawalFlatFeeMinor: money.toMinor(1),
      payoutFeePercent: 0,
    },
    // The demo runs without a registration paywall so seeded users can transact.
    rules: { requireRegistrationPayment: false, autoApproveWithdrawals: false },
  });

  await Plan.insertMany([
    { code: 'free', name: 'Free', monthlyPriceMinor: 0, maxMembers: 25, maxGroups: 3, sortOrder: 1, features: ['1 organization space', 'Up to 3 groups'] },
    { code: 'basic', name: 'Basic', monthlyPriceMinor: money.toMinor(150), maxMembers: 100, maxGroups: 10, sortOrder: 2, features: ['Up to 100 members', 'Reports'] },
    { code: 'professional', name: 'Professional', monthlyPriceMinor: money.toMinor(450), maxMembers: 500, maxGroups: 50, sortOrder: 3, features: ['Up to 500 members', 'Advanced analytics', 'Priority support'] },
    { code: 'enterprise', name: 'Enterprise', monthlyPriceMinor: money.toMinor(1200), maxMembers: 100000, maxGroups: 1000, sortOrder: 4, features: ['Unlimited members', 'Dedicated support'] },
  ]);

  /* --------------------------------- users -------------------------------- */

  const superAdmin = await createUser({
    firstName: 'Platform', lastName: 'Admin', email: 'admin@sususave.app', phone: '0200000000', role: ROLES.SUPER_ADMIN,
  });

  const orgAdmin = await createUser({
    firstName: 'Grace', lastName: 'Adjei', email: 'grace@abccompany.test', phone: '0244111111', role: ROLES.ORG_ADMIN,
  });

  const organization = await Organization.create({
    name: 'ABC Company Ltd',
    slug: 'abc-company-ltd',
    type: 'company',
    adminId: orgAdmin._id,
    contactEmail: orgAdmin.email,
    contactPhone: orgAdmin.phone,
    address: 'Ring Road Central, Accra',
    status: ORG_STATUS.ACTIVE,
    planCode: 'professional',
    limits: { maxMembers: 500, maxGroups: 50 },
  });
  orgAdmin.organizationId = organization._id;
  await orgAdmin.save();

  const people = [];
  for (const [firstName, lastName, email, phone] of PEOPLE) {
    // eslint-disable-next-line no-await-in-loop
    people.push(await createUser({ firstName, lastName, email, phone }));
  }

  // Give everyone a funded wallet so contributions can actually be made.
  for (const person of [...people, orgAdmin]) {
    // eslint-disable-next-line no-await-in-loop
    await fundWallet(person, 3000);
  }

  logger.info(`Created ${people.length + 2} users`);

  /* ----------------------------- group 1: daily ---------------------------- */

  const [ama, kofi, afia, kwame, akosua] = people;

  const daily = await buildGroup({
    organizer: ama,
    payload: {
      name: 'Adom Susu Group',
      description: 'Daily savings among friends and neighbours in Madina.',
      contributionAmount: 20,
      contributionFrequency: FREQUENCY.DAILY,
      memberLimit: 10,
      // Started 16 days ago so the dashboard shows a group mid-rotation.
      startDate: dates.addDays(new Date(), -15),
    },
    members: people.slice(1),
    cyclesToPay: 15,
  });

  /* ---------------------------- group 2: weekly ---------------------------- */

  const weekly = await buildGroup({
    organizer: afia,
    payload: {
      name: 'Market Queens Susu',
      description: 'Weekly contributions for the traders at Makola Market.',
      contributionAmount: 100,
      contributionFrequency: FREQUENCY.WEEKLY,
      memberLimit: 6,
      startDate: dates.addDays(new Date(), -14),
    },
    members: [ama, kofi, kwame, akosua, people[5]],
    cyclesToPay: 2,
  });

  /* -------------------------- organization group --------------------------- */

  const staffOrganizer = people[6];
  staffOrganizer.organizationId = organization._id;
  await staffOrganizer.save();
  const staffMembers = people.slice(7);
  for (const member of staffMembers) {
    member.organizationId = organization._id;
    // eslint-disable-next-line no-await-in-loop
    await member.save();
  }

  await buildGroup({
    organizer: staffOrganizer,
    payload: {
      name: 'ABC Staff Welfare Susu',
      description: 'Weekly staff savings scheme.',
      contributionAmount: 150,
      contributionFrequency: FREQUENCY.WEEKLY,
      memberLimit: 4,
      startDate: dates.addDays(new Date(), -7),
    },
    members: staffMembers,
    cyclesToPay: 1,
  });

  /* ------------------------------- savings -------------------------------- */

  const emergency = await savingsService.createPlan({
    actor: ama,
    payload: {
      name: 'Emergency Savings',
      type: SAVINGS_TYPE.EMERGENCY,
      targetAmount: 10000,
      contributionAmount: 500,
      frequency: FREQUENCY.MONTHLY,
      startDate: dates.addMonths(new Date(), -4),
      targetDate: dates.addMonths(new Date(), 8),
    },
  });
  await savingsService.deposit({ actor: ama, planId: emergency._id, amount: 500 });
  await savingsService.deposit({ actor: ama, planId: emergency._id, amount: 500 });

  const rent = await savingsService.createPlan({
    actor: ama,
    payload: {
      name: 'Rent 2026',
      type: SAVINGS_TYPE.RENT,
      targetAmount: 12000,
      contributionAmount: 1000,
      frequency: FREQUENCY.MONTHLY,
      startDate: dates.addMonths(new Date(), -7),
      targetDate: dates.addMonths(new Date(), 5),
      monthlyRent: 1000,
      propertyLabel: '2 bedroom, East Legon',
      landlordName: 'Mr. Owusu',
    },
  });
  // Seven monthly deposits → the 62.5% progress shown on the dashboard.
  for (let i = 0; i < 7; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await savingsService.deposit({ actor: ama, planId: rent._id, amount: 1000 });
  }

  await savingsService.createPlan({
    actor: kofi,
    payload: {
      name: 'School Fees — Term 2',
      type: SAVINGS_TYPE.SCHOOL,
      targetAmount: 4500,
      contributionAmount: 750,
      frequency: FREQUENCY.MONTHLY,
      targetDate: dates.addMonths(new Date(), 6),
    },
  });

  /* ----------------------------- notifications ----------------------------- */

  await Notification.create({
    userId: ama._id,
    type: 'announcement',
    title: 'Welcome to SUSU SAVE',
    body: 'Your demo account is ready. Explore your groups, savings goals and wallet.',
    icon: 'bell',
  });

  /* -------------------------------- summary -------------------------------- */

  const counts = {
    users: await User.countDocuments({}),
    organizations: await Organization.countDocuments({}),
    groups: await SusuGroup.countDocuments({}),
    contributions: await models.Contribution.countDocuments({}),
    payouts: await models.Payout.countDocuments({}),
    transactions: await models.Transaction.countDocuments({}),
    savingsPlans: await SavingsPlan.countDocuments({}),
  };

  logger.info('Seed complete');
  /* eslint-disable no-console */
  console.log(`
──────────────────────────────────────────────
  SUSU SAVE — seed data ready
──────────────────────────────────────────────
  Super Admin        admin@sususave.app     / ${PASSWORD}
  Organization Admin grace@abccompany.test  / ${PASSWORD}
  Member (Ama)       ama@sususave.test      / ${PASSWORD}
  Member (Kofi)      kofi@sususave.test     / ${PASSWORD}
  Member (Afia)      afia@sususave.test     / ${PASSWORD}

  Groups             ${daily.name}, ${weekly.name}, ABC Staff Welfare Susu
  Records            ${counts.users} users · ${counts.groups} groups ·
                     ${counts.contributions} contributions · ${counts.payouts} payouts ·
                     ${counts.transactions} ledger rows · ${counts.savingsPlans} savings plans
──────────────────────────────────────────────`);
  /* eslint-enable no-console */

  await disconnectDatabase();
}

/**
 * Creates a group, adds members, activates it and plays the first `cyclesToPay`
 * cycles forward so the demo has genuine history rather than invented numbers.
 */
async function buildGroup({ organizer, payload, members, cyclesToPay }) {
  const { group } = await groupService.createGroup({ actor: organizer, payload });

  for (const member of members.slice(0, payload.memberLimit - 1)) {
    // eslint-disable-next-line no-await-in-loop
    await GroupMember.create({
      groupId: group._id,
      userId: member._id,
      organizationId: group.organizationId,
      role: GROUP_ROLE.MEMBER,
      status: GROUP_MEMBER_STATUS.ACTIVE,
      payoutPosition: await groupService.nextPayoutPosition(group._id),
      approvedAt: new Date(),
      approvedBy: organizer._id,
    });
  }
  await groupService.refreshMemberStats(group._id);
  await groupService.activateGroup(group);

  const roster = await GroupMember.find({ groupId: group._id, status: GROUP_MEMBER_STATUS.ACTIVE }).lean();
  const byUser = new Map();
  for (const row of roster) {
    // eslint-disable-next-line no-await-in-loop
    byUser.set(String(row.userId), await User.findById(row.userId));
  }

  for (let cycle = 1; cycle <= cyclesToPay; cycle += 1) {
    for (const row of roster) {
      const actor = byUser.get(String(row.userId));
      try {
        // eslint-disable-next-line no-await-in-loop
        await contributionService.contribute({ actor, groupId: group._id, cycle });
      } catch (err) {
        // A deliberately missed contribution is realistic demo data.
        logger.debug(`seed: skipped contribution (${err.message})`);
      }
    }
  }

  // Run any payouts whose date has already passed.
  await payoutService.runDuePayouts();
  return group;
}

seed().catch(async (err) => {
  logger.error('Seed failed:', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
