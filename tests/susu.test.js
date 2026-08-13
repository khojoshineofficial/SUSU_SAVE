'use strict';

/** Group lifecycle, contributions, the payout engine and payout ordering. */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  startDatabase, stopDatabase, resetDatabase, makeUser, makeActiveGroup, walletOf, dbTest,
} = require('./helpers');

let groupService;
let contributionService;
let payoutService;
let models;
let money;
let dates;

test.before(async () => {
  await startDatabase();
  groupService = require('../src/services/group.service');
  contributionService = require('../src/services/contribution.service');
  payoutService = require('../src/services/payout.service');
  models = require('../src/models');
  money = require('../src/utils/money');
  dates = require('../src/utils/dates');
});
test.after(async () => { await stopDatabase(); });
test.beforeEach(async () => { await resetDatabase(); });

dbTest('activating a group builds one contribution per member per cycle', async () => {
  const organizer = await makeUser();
  const members = [await makeUser(), await makeUser()];
  const group = await makeActiveGroup({ organizer, members, contributionAmount: 100 });

  const contributions = await models.Contribution.countDocuments({ groupId: group._id });
  const payouts = await models.Payout.countDocuments({ groupId: group._id });

  assert.equal(group.totalCycles, 3);
  assert.equal(contributions, 9, '3 members × 3 cycles');
  assert.equal(payouts, 3, 'one payout per cycle');
});

dbTest('every member receives exactly one payout, in rotation order', async () => {
  const organizer = await makeUser();
  const members = [await makeUser(), await makeUser()];
  const group = await makeActiveGroup({ organizer, members });

  const payouts = await models.Payout.find({ groupId: group._id }).sort({ cycle: 1 }).lean();
  const recipients = payouts.map((p) => String(p.recipientId));
  assert.equal(new Set(recipients).size, 3, 'no member is paid twice');

  const roster = await models.GroupMember.find({ groupId: group._id }).sort({ payoutPosition: 1 }).lean();
  assert.deepEqual(recipients, roster.map((m) => String(m.userId)), 'payout order follows the rotation');
});

dbTest('a full contribution satisfies the cycle; the fee is withheld from the pool', async () => {
  const organizer = await makeUser({ fundMajor: 1000 });
  const member = await makeUser({ fundMajor: 1000 });
  const group = await makeActiveGroup({ organizer, members: [member], contributionAmount: 100 });

  await contributionService.contribute({ actor: member, groupId: group._id });

  const wallet = await walletOf(member);
  const contribution = await models.Contribution.findOne({ groupId: group._id, userId: member._id, cycle: 1 }).lean();

  // Default savings fee is 1%: GH₵100 leaves the wallet, GH₵99 reaches the pool,
  // and the member's obligation is measured against the GH₵100 they paid.
  assert.equal(wallet.availableBalanceMinor, money.toMinor(900));
  assert.equal(contribution.paidAmountMinor, money.toMinor(100));
  assert.equal(contribution.platformFeeMinor, money.toMinor(1));
  assert.equal(contribution.status, 'paid', 'paying in full must not leave a fee shortfall');
  assert.equal(contribution.expectedAmountMinor - contribution.paidAmountMinor, 0);
});

dbTest('a member cannot pay more than is outstanding for a cycle', async () => {
  const organizer = await makeUser();
  const member = await makeUser();
  const group = await makeActiveGroup({ organizer, members: [member], contributionAmount: 100 });

  await assert.rejects(
    contributionService.contribute({ actor: member, groupId: group._id, amount: 500 }),
    (err) => err.errorCode === 'AMOUNT_EXCEEDS_DUE',
  );
});

dbTest('a non-member cannot contribute to a group', async () => {
  const organizer = await makeUser();
  const outsider = await makeUser();
  const group = await makeActiveGroup({ organizer, members: [await makeUser()] });

  await assert.rejects(
    contributionService.contribute({ actor: outsider, groupId: group._id }),
    (err) => err.errorCode === 'NOT_A_MEMBER',
  );
});

dbTest('a payout is held while the cycle pool is incomplete', async () => {
  const organizer = await makeUser();
  const member = await makeUser();
  const group = await makeActiveGroup({
    organizer,
    members: [member],
    contributionAmount: 100,
    startDate: dates.addDays(new Date(), -14),
  });

  // Only one of the two members pays.
  await contributionService.contribute({ actor: member, groupId: group._id });

  const payout = await models.Payout.findOne({ groupId: group._id, cycle: 1 });
  const result = await payoutService.processPayout(payout._id);

  assert.equal(result.processed, false);
  assert.equal(result.verdict.code, 'POOL_INCOMPLETE');

  const reloaded = await models.Payout.findById(payout._id).lean();
  assert.equal(reloaded.status, 'on_hold');
  assert.ok(reloaded.holdReason);
});

dbTest('a completed payout credits the recipient the pooled amount and advances the cycle', async () => {
  const organizer = await makeUser({ fundMajor: 1000 });
  const member = await makeUser({ fundMajor: 1000 });
  const group = await makeActiveGroup({
    organizer,
    members: [member],
    contributionAmount: 100,
    startDate: dates.addDays(new Date(), -14),
  });

  await contributionService.contribute({ actor: organizer, groupId: group._id });
  await contributionService.contribute({ actor: member, groupId: group._id });

  const payout = await models.Payout.findOne({ groupId: group._id, cycle: 1 });
  const before = await walletOf(payout.recipientId.equals(organizer._id) ? organizer : member);

  const result = await payoutService.processPayout(payout._id);
  assert.equal(result.processed, true);

  const recipient = payout.recipientId.equals(organizer._id) ? organizer : member;
  const after = await walletOf(recipient);
  const collected = money.toMinor(198); // two GH₵100 contributions, less 1% each

  assert.equal(after.availableBalanceMinor - before.availableBalanceMinor, collected);
  assert.equal(result.payout.netAmountMinor, collected);

  const reloadedGroup = await models.SusuGroup.findById(group._id).lean();
  assert.equal(reloadedGroup.currentCycle, 2, 'the group advances to the next cycle');
  assert.equal(reloadedGroup.stats.completedPayouts, 1);
});

dbTest('running a payout twice cannot pay the same cycle twice', async () => {
  const organizer = await makeUser({ fundMajor: 1000 });
  const member = await makeUser({ fundMajor: 1000 });
  const group = await makeActiveGroup({
    organizer, members: [member], contributionAmount: 100, startDate: dates.addDays(new Date(), -14),
  });

  await contributionService.contribute({ actor: organizer, groupId: group._id });
  await contributionService.contribute({ actor: member, groupId: group._id });

  const payout = await models.Payout.findOne({ groupId: group._id, cycle: 1 });
  await payoutService.processPayout(payout._id);
  const recipient = payout.recipientId.equals(organizer._id) ? organizer : member;
  const afterFirst = await walletOf(recipient);

  const second = await payoutService.processPayout(payout._id, { force: true });
  const afterSecond = await walletOf(recipient);

  assert.equal(second.processed, false);
  assert.equal(afterSecond.availableBalanceMinor, afterFirst.availableBalanceMinor, 'no money is created by a re-run');

  const payoutTransactions = await models.Transaction.countDocuments({
    groupId: group._id,
    type: 'payout',
  });
  assert.equal(payoutTransactions, 1);
});

dbTest('cycle 2 cannot pay out before cycle 1 is settled', async () => {
  const organizer = await makeUser({ fundMajor: 1000 });
  const member = await makeUser({ fundMajor: 1000 });
  const group = await makeActiveGroup({
    organizer, members: [member], contributionAmount: 100, startDate: dates.addDays(new Date(), -30),
  });

  const second = await models.Payout.findOne({ groupId: group._id, cycle: 2 });
  const result = await payoutService.processPayout(second._id);

  assert.equal(result.processed, false);
  assert.ok(['EARLIER_CYCLE_OPEN', 'NOTHING_COLLECTED'].includes(result.verdict.code));
});

dbTest('overdue contributions are swept into "missed" and counted once', async () => {
  const organizer = await makeUser();
  const member = await makeUser();
  const group = await makeActiveGroup({
    organizer, members: [member], contributionAmount: 100, startDate: dates.addDays(new Date(), -30),
  });

  await contributionService.markMissedContributions();
  await contributionService.markMissedContributions(); // re-run must be a no-op

  const missed = await models.Contribution.countDocuments({ groupId: group._id, status: 'missed' });
  assert.ok(missed > 0, 'overdue rows are marked missed');

  const membership = await models.GroupMember.findOne({ groupId: group._id, userId: member._id }).lean();
  const missedForMember = await models.Contribution.countDocuments({
    groupId: group._id, userId: member._id, status: 'missed',
  });
  assert.equal(membership.missedContributions, missedForMember, 'the counter is not double-incremented');
});

dbTest('a group refuses more members than its limit', async () => {
  const organizer = await makeUser();
  const { group } = await groupService.createGroup({
    actor: organizer,
    payload: { name: 'Tiny Group', contributionAmount: 50, contributionFrequency: 'weekly', memberLimit: 2 },
  });

  const first = await makeUser();
  await groupService.requestToJoin({ group, user: first });
  await groupService.approveMember({
    group,
    memberId: (await models.GroupMember.findOne({ groupId: group._id, userId: first._id }))._id,
    actor: organizer,
    approve: true,
  });

  const second = await makeUser();
  await groupService.requestToJoin({ group, user: second });
  const pending = await models.GroupMember.findOne({ groupId: group._id, userId: second._id });

  await assert.rejects(
    groupService.approveMember({ group, memberId: pending._id, actor: organizer, approve: true }),
    (err) => err.errorCode === 'GROUP_FULL',
  );
});

dbTest('the payout order is locked once a group is active', async () => {
  const organizer = await makeUser();
  const member = await makeUser();
  const group = await makeActiveGroup({ organizer, members: [member] });

  await assert.rejects(
    groupService.setPayoutOrder({ group, orderedMemberIds: [] }),
    (err) => err.errorCode === 'ORDER_LOCKED',
  );
});
