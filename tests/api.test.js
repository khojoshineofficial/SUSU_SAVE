'use strict';

/**
 * End-to-end HTTP tests over the real Express app: registration, login,
 * authorization, tenant isolation and webhook idempotency.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  startDatabase, stopDatabase, resetDatabase, makeUser, dbTest,
} = require('./helpers');

let app;
let server;
let baseUrl;
let models;

async function request(method, path, { body, token, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, body: payload };
}

test.before(async () => {
  const connection = await startDatabase();
  models = require('../src/models');
  if (!connection) return;

  ({ createApp: app } = require('../src/app'));
  server = require('../src/app').createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server?.close();
  await stopDatabase();
});
test.beforeEach(async () => { await resetDatabase(); });

/* -------------------------------- infrastructure ------------------------------- */

dbTest('GET /health reports database status', async () => {
  const res = await request('GET', '/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
  assert.equal(res.body.database, 'connected');
});

dbTest('unknown API routes return a consistent error envelope', async () => {
  const res = await request('GET', '/api/does-not-exist');
  assert.equal(res.status, 404);
  assert.equal(res.body.success, false);
  assert.equal(res.body.errorCode, 'ROUTE_NOT_FOUND');
});

/* ------------------------------------ auth ------------------------------------ */

const REGISTRATION = {
  accountType: 'personal',
  firstName: 'Ama',
  lastName: 'Mensah',
  email: 'ama@test.local',
  phone: '0244123456',
  password: 'Password123',
};

dbTest('a user can register and receives an access token', async () => {
  const res = await request('POST', '/api/auth/register', { body: REGISTRATION });
  assert.equal(res.status, 201);
  assert.ok(res.body.data.accessToken);
  assert.equal(res.body.data.user.email, 'ama@test.local');
  assert.equal(res.body.data.user.passwordHash, undefined, 'the password hash is never returned');
});

dbTest('registration rejects a weak password and a bad phone number', async () => {
  const weak = await request('POST', '/api/auth/register', {
    body: { ...REGISTRATION, email: 'a@test.local', password: 'short' },
  });
  assert.equal(weak.status, 422);
  assert.ok(weak.body.details.password);

  const badPhone = await request('POST', '/api/auth/register', {
    body: { ...REGISTRATION, email: 'b@test.local', phone: '12345' },
  });
  assert.equal(badPhone.status, 422);
  assert.ok(badPhone.body.details.phone);
});

dbTest('a duplicate email is rejected', async () => {
  await request('POST', '/api/auth/register', { body: REGISTRATION });
  const again = await request('POST', '/api/auth/register', { body: REGISTRATION });
  assert.equal(again.status, 409);
  assert.equal(again.body.errorCode, 'EMAIL_TAKEN');
});

dbTest('login fails with the same message for unknown and wrong-password accounts', async () => {
  await request('POST', '/api/auth/register', { body: REGISTRATION });

  const wrongPassword = await request('POST', '/api/auth/login', {
    body: { email: REGISTRATION.email, password: 'WrongPassword1' },
  });
  const unknownUser = await request('POST', '/api/auth/login', {
    body: { email: 'nobody@test.local', password: 'WrongPassword1' },
  });

  assert.equal(wrongPassword.status, 401);
  assert.equal(unknownUser.status, 401);
  assert.equal(wrongPassword.body.message, unknownUser.body.message, 'the endpoint must not enumerate accounts');
});

/* -------------------------------- authorization ------------------------------- */

async function tokenFor(user, password = 'Password123') {
  const res = await request('POST', '/api/auth/login', { body: { email: user.email, password } });
  return res.body.data.accessToken;
}

dbTest('protected routes reject requests with no token', async () => {
  const res = await request('GET', '/api/dashboard');
  assert.equal(res.status, 401);
});

dbTest('a user cannot read another user by changing the id in the URL', async () => {
  const alice = await makeUser();
  const bob = await makeUser();
  const token = await tokenFor(alice);

  const res = await request('GET', `/api/users/${bob._id}`, { token });
  assert.equal(res.status, 403);
});

dbTest('an ordinary user cannot reach the admin API', async () => {
  const user = await makeUser();
  const token = await tokenFor(user);

  for (const path of ['/api/admin/overview', '/api/admin/users', '/api/admin/settings']) {
    // eslint-disable-next-line no-await-in-loop
    const res = await request('GET', path, { token });
    assert.equal(res.status, 403, `${path} must be forbidden`);
  }
});

dbTest('a super admin can reach the admin API', async () => {
  const admin = await makeUser({ role: 'super_admin' });
  const token = await tokenFor(admin);

  const res = await request('GET', '/api/admin/overview', { token });
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.data.totalUsers, 'number');
});

dbTest('a suspended account cannot use the API', async () => {
  const user = await makeUser();
  const token = await tokenFor(user);
  await models.User.updateOne({ _id: user._id }, { $set: { status: 'suspended' } });

  const res = await request('GET', '/api/dashboard', { token });
  assert.equal(res.status, 403);
  assert.equal(res.body.errorCode, 'ACCOUNT_SUSPENDED');
});

/* ------------------------------ tenant isolation ------------------------------ */

dbTest('a group in one organization is invisible to another organization', async () => {
  const orgA = await models.Organization.create({
    name: 'Org A', slug: 'org-a', adminId: (await makeUser())._id, status: 'active',
  });
  const orgB = await models.Organization.create({
    name: 'Org B', slug: 'org-b', adminId: (await makeUser())._id, status: 'active',
  });

  const insider = await makeUser({ organizationId: orgA._id });
  const outsider = await makeUser({ organizationId: orgB._id });

  const groupService = require('../src/services/group.service');
  const { group } = await groupService.createGroup({
    actor: insider,
    payload: { name: 'Org A Susu', contributionAmount: 50, contributionFrequency: 'weekly', memberLimit: 4 },
  });

  const outsiderToken = await tokenFor(outsider);

  const read = await request('GET', `/api/groups/${group._id}`, { token: outsiderToken });
  assert.equal(read.status, 403);
  assert.equal(read.body.errorCode, 'CROSS_TENANT_DENIED');

  const join = await request('POST', '/api/groups/join', {
    token: outsiderToken,
    body: { inviteCode: group.inviteCode },
  });
  assert.equal(join.status, 404, 'the invite code must not even resolve across tenants');
});

/* --------------------------------- validation --------------------------------- */

dbTest('query operators cannot be smuggled through the request body', async () => {
  await request('POST', '/api/auth/register', { body: REGISTRATION });

  const res = await request('POST', '/api/auth/login', {
    body: { email: { $ne: null }, password: { $ne: null } },
  });
  assert.ok(res.status >= 400, 'an operator-injection attempt must not authenticate anyone');
  assert.notEqual(res.status, 200);
});

/* ---------------------------------- webhooks ---------------------------------- */

dbTest('a webhook with an invalid signature is rejected', async () => {
  const res = await request('POST', '/api/payments/webhook', {
    body: { reference: 'PAY-TEST' },
    headers: { 'x-susu-signature': 'not-a-real-signature' },
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.errorCode, 'INVALID_SIGNATURE');
});

dbTest('a replayed webhook does not credit the wallet twice', async () => {
  const crypto = require('node:crypto');
  const env = require('../src/config/env');
  const paymentService = require('../src/services/payment');
  const money = require('../src/utils/money');

  const user = await makeUser({ fundMajor: 0 });
  const payment = await paymentService.initiatePayment({
    userId: user._id,
    purpose: 'wallet_topup',
    amountMinor: money.toMinor(250),
    method: 'mobile_money',
  });

  const body = { reference: payment.reference, event: 'payment.successful' };
  const raw = JSON.stringify(body);
  const signature = crypto.createHmac('sha256', env.payment.webhookSecret).update(raw).digest('hex');

  const send = () => fetch(`${baseUrl}/api/payments/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-susu-signature': signature },
    body: raw,
  }).then((r) => r.json());

  const first = await send();
  const second = await send();

  assert.equal(first.data.applied, true);
  assert.equal(second.data.applied, false, 'the replay must be ignored');

  const wallet = await models.Wallet.findOne({ userId: user._id }).lean();
  assert.equal(wallet.availableBalanceMinor, money.toMinor(250), 'the wallet is credited exactly once');

  const deposits = await models.Transaction.countDocuments({ userId: user._id, type: 'deposit' });
  assert.equal(deposits, 1);
});



/* ------------------------------ staff role split ----------------------------- */

dbTest('an admin can analyse payments and approve, but cannot change the platform', async () => {
  const admin = await makeUser({ role: 'admin' });
  const token = await tokenFor(admin);

  // Allowed: the money view and the payment record.
  for (const path of ['/api/admin/overview', '/api/admin/payments/analysis',
    '/api/admin/payments/records', '/api/admin/withdrawals', '/api/admin/transactions',
    '/api/admin/users', '/api/admin/audit-logs']) {
    // eslint-disable-next-line no-await-in-loop
    const res = await request('GET', path, { token });
    assert.equal(res.status, 200, `${path} should be open to an admin`);
  }

  // Refused: anything that changes what the platform is.
  const settings = await request('GET', '/api/admin/settings', { token });
  assert.equal(settings.status, 403, 'settings belong to the super admin');

  const maintenance = await request('PATCH', '/api/admin/settings', {
    token, body: { maintenanceMode: true },
  });
  assert.equal(maintenance.status, 403, 'an admin must not be able to trigger maintenance mode');

  const plans = await request('GET', '/api/admin/plans', { token });
  assert.equal(plans.status, 403);

  const promote = await request('POST', `/api/admin/users/${admin._id}/role`, {
    token, body: { role: 'super_admin' },
  });
  assert.equal(promote.status, 403, 'an admin must not be able to promote themselves');
});

dbTest('only the super admin can turn maintenance mode on, and it is public', async () => {
  const owner = await makeUser({ role: 'super_admin' });
  const token = await tokenFor(owner);

  const before = await request('GET', '/api/settings/public');
  assert.equal(before.body.data.maintenanceMode, false);

  const res = await request('PATCH', '/api/admin/settings', {
    token,
    body: { maintenanceMode: true, maintenanceMessage: 'Upgrading the payout engine.' },
  });
  assert.equal(res.status, 200);

  // Every page reads this endpoint, signed in or not, to show the banner.
  const after = await request('GET', '/api/settings/public');
  assert.equal(after.body.data.maintenanceMode, true);
  assert.equal(after.body.data.maintenanceMessage, 'Upgrading the payout engine.');

  // And members cannot transact while it is on.
  const member = await makeUser({ fundMajor: 500 });
  const blocked = await request('POST', '/api/withdrawals', {
    token: await tokenFor(member),
    body: { amount: 50, accountNumber: '0244123456', provider: 'mtn' },
  });
  assert.equal(blocked.status, 503);
  assert.equal(blocked.body.errorCode, 'MAINTENANCE_MODE');
});

dbTest('staff sign in with a username and can change it themselves', async () => {
  const admin = await makeUser({ role: 'admin' });
  await models.User.updateOne({ _id: admin._id }, { $set: { username: 'susu.admin.4kp2' } });

  // The username works at the login endpoint.
  const login = await request('POST', '/api/auth/login', {
    body: { email: 'susu.admin.4kp2', password: 'Password123' },
  });
  assert.equal(login.status, 200);
  const token = login.body.data.accessToken;

  // Changing it needs the current password.
  const wrong = await request('POST', '/api/users/me/username', {
    token, body: { username: 'newhandle', currentPassword: 'WrongPassword1' },
  });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.errorCode, 'WRONG_PASSWORD');

  const changed = await request('POST', '/api/users/me/username', {
    token, body: { username: 'Susu.Owner.9XY', currentPassword: 'Password123' },
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.data.user.username, 'susu.owner.9xy', 'usernames are stored lowercase');

  // The new handle signs in; the old one no longer resolves.
  const relogin = await request('POST', '/api/auth/login', {
    body: { email: 'susu.owner.9xy', password: 'Password123' },
  });
  assert.equal(relogin.status, 200);
  const stale = await request('POST', '/api/auth/login', {
    body: { email: 'susu.admin.4kp2', password: 'Password123' },
  });
  assert.equal(stale.status, 401);
});

dbTest('a username cannot be taken twice', async () => {
  const first = await makeUser({ role: 'admin' });
  const second = await makeUser({ role: 'admin' });
  await models.User.updateOne({ _id: first._id }, { $set: { username: 'taken.handle' } });

  const res = await request('POST', '/api/users/me/username', {
    token: await tokenFor(second),
    body: { username: 'taken.handle', currentPassword: 'Password123' },
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.errorCode, 'USERNAME_TAKEN');
});

/* --------------------------- organization console --------------------------- */

dbTest('an ordinary user cannot reach the organization console', async () => {
  const org = await models.Organization.create({
    name: 'Console Org', slug: 'console-org', adminId: (await makeUser())._id, status: 'active',
  });
  const member = await makeUser({ organizationId: org._id });
  const token = await tokenFor(member);

  for (const path of ['/api/organizations/current/dashboard',
    '/api/organizations/current/transactions',
    '/api/organizations/current/performance']) {
    // eslint-disable-next-line no-await-in-loop
    const res = await request('GET', path, { token });
    assert.equal(res.status, 403, `${path} must be admin-only`);
  }
});

dbTest('an org admin sees only their own tenant in the console', async () => {
  const adminA = await makeUser({ role: 'org_admin' });
  const adminB = await makeUser({ role: 'org_admin' });

  const orgA = await models.Organization.create({ name: 'Alpha', slug: 'alpha', adminId: adminA._id, status: 'active' });
  const orgB = await models.Organization.create({ name: 'Beta', slug: 'beta', adminId: adminB._id, status: 'active' });
  await models.User.updateOne({ _id: adminA._id }, { organizationId: orgA._id });
  await models.User.updateOne({ _id: adminB._id }, { organizationId: orgB._id });

  // A member and a transaction belonging to Beta only.
  const betaMember = await makeUser({ organizationId: orgB._id });
  await require('../src/services/ledger.service').post({
    userId: betaMember._id,
    organizationId: orgB._id,
    type: 'contribution',
    grossAmountMinor: 50000,
    paymentMethod: 'wallet',
    description: 'Beta contribution',
  });

  const tokenA = await tokenFor(adminA);
  const dashboard = await request('GET', '/api/organizations/current/dashboard', { token: tokenA });
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.body.data.organization.name, 'Alpha');
  assert.equal(dashboard.body.data.summary.totalSavedMinor, 0, 'Beta savings must not leak into Alpha');

  const transactions = await request('GET', '/api/organizations/current/transactions', { token: tokenA });
  assert.equal(transactions.body.data.transactions.length, 0, 'Alpha must see none of Beta\'s ledger');

  // And Beta's own admin does see it.
  const tokenB = await tokenFor(adminB);
  const betaView = await request('GET', '/api/organizations/current/transactions', { token: tokenB });
  assert.equal(betaView.body.data.transactions.length, 1);
});

dbTest('the org console reports arrears and plan usage', async () => {
  const admin = await makeUser({ role: 'org_admin' });
  const org = await models.Organization.create({
    name: 'Reporting Org', slug: 'reporting-org', adminId: admin._id, status: 'active',
    limits: { maxMembers: 10, maxGroups: 2 },
  });
  await models.User.updateOne({ _id: admin._id }, { organizationId: org._id });
  const token = await tokenFor(admin);

  const dashboard = await request('GET', '/api/organizations/current/dashboard', { token });
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.body.data.counts.maxMembers, 10);
  assert.equal(dashboard.body.data.counts.maxGroups, 2);

  const performance = await request('GET', '/api/organizations/current/performance', { token });
  assert.equal(performance.status, 200);
  assert.ok(Array.isArray(performance.body.data.groups));
  assert.ok(Array.isArray(performance.body.data.inArrears));
});

dbTest('only a super admin can manage subscription plans', async () => {
  const user = await makeUser();
  const admin = await makeUser({ role: 'super_admin' });

  const denied = await request('GET', '/api/admin/plans', { token: await tokenFor(user) });
  assert.equal(denied.status, 403);

  const token = await tokenFor(admin);
  const created = await request('POST', '/api/admin/plans', {
    token,
    body: { code: 'growth', name: 'Growth', monthlyPriceMinor: 25000, maxMembers: 200, maxGroups: 20 },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.plan.code, 'growth');

  const list = await request('GET', '/api/admin/plans', { token });
  assert.ok(list.body.data.plans.some((p) => p.code === 'growth'));
});

/* ----------------------------------- fees ------------------------------------- */

dbTest('public settings expose fees without leaking internal configuration', async () => {
  const res = await request('GET', '/api/settings/public');
  assert.equal(res.status, 200);
  assert.ok('registrationFeeMinor' in res.body.data);
  assert.equal(res.body.data.rules, undefined, 'internal rules are not published');
});

/* ------------------------------ collector links ------------------------------- */

/** An organization with a live join link, plus its admin. */
async function makeCollector() {
  const admin = await makeUser({ role: 'org_admin' });
  const suffix = Math.random().toString(36).slice(2, 8);
  const org = await models.Organization.create({
    name: `Collector ${suffix}`,
    slug: `collector-${suffix}`,
    adminId: admin._id,
    status: 'active',
  });
  await models.User.updateOne({ _id: admin._id }, { organizationId: org._id });
  admin.organizationId = org._id;

  const link = await request('GET', '/api/organizations/current/join-link', { token: await tokenFor(admin) });
  return { admin, org, link: link.body.data };
}

dbTest('a collector gets a shareable join link, and it identifies them publicly', async () => {
  const { link } = await makeCollector();

  assert.equal(link.joinCode.length, 8);
  assert.ok(link.url.endsWith(`/join/${link.joinCode}`));
  assert.equal(link.enabled, true);

  // The public lookup names the collector and leaks nothing else.
  const lookup = await request('GET', `/api/collectors/${link.joinCode}`);
  assert.equal(lookup.status, 200);
  assert.ok(lookup.body.data.collector.name);
  assert.equal(lookup.body.data.collector.limits, undefined, 'plan limits are not published');
  assert.equal(lookup.body.data.collector.feeOverrides, undefined, 'fee overrides are not published');
});

dbTest('a customer signing up through the link joins that collector', async () => {
  const { org, link } = await makeCollector();

  const res = await request('POST', '/api/auth/register', {
    body: {
      firstName: 'Ama', lastName: 'Mensah', email: 'ama.join@test.local',
      phone: '0244778899', password: 'Password123', joinCode: link.joinCode,
    },
  });
  assert.equal(res.status, 201);
  assert.equal(String(res.body.data.user.organizationId), String(org._id));
  assert.equal(res.body.data.user.role, 'user', 'a link customer is a saver, never an admin');

  // The collector now sees them, with a balance.
  const members = await request('GET', '/api/organizations/current/members', {
    token: await tokenFor(await models.User.findById(org.adminId)),
  });
  const customer = members.body.data.members.find((m) => m.email === 'ama.join@test.local');
  assert.ok(customer, 'the customer appears in the collector members list');
  assert.equal(customer.balanceMinor, 0);
});

dbTest('a join link cannot be used to become an organization admin', async () => {
  const { org, link } = await makeCollector();

  const res = await request('POST', '/api/auth/register', {
    body: {
      accountType: 'organization', organizationName: 'Sneaky Ltd',
      firstName: 'Kojo', lastName: 'Boateng', email: 'kojo.join@test.local',
      phone: '0244778800', password: 'Password123', joinCode: link.joinCode,
    },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.user.role, 'user');
  assert.equal(String(res.body.data.user.organizationId), String(org._id));
  assert.equal(await models.Organization.countDocuments({ name: 'Sneaky Ltd' }), 0);
});

dbTest('a closed or rotated link stops working', async () => {
  const { admin, link } = await makeCollector();
  const token = await tokenFor(admin);

  await request('PATCH', '/api/organizations/current', { token, body: { settings: { allowPublicJoin: false } } });
  const closed = await request('GET', `/api/collectors/${link.joinCode}`);
  assert.equal(closed.status, 404);
  assert.equal(closed.body.errorCode, 'JOIN_LINK_CLOSED');

  // Registration refuses it too, not just the page that displays it.
  const refused = await request('POST', '/api/auth/register', {
    body: {
      firstName: 'Yaa', lastName: 'Asare', email: 'yaa.join@test.local',
      phone: '0244778877', password: 'Password123', joinCode: link.joinCode,
    },
  });
  assert.equal(refused.status, 404);
  assert.equal(await models.User.countDocuments({ email: 'yaa.join@test.local' }), 0);

  await request('PATCH', '/api/organizations/current', { token, body: { settings: { allowPublicJoin: true } } });
  const rotated = await request('POST', '/api/organizations/current/join-link/rotate', { token, body: {} });
  assert.notEqual(rotated.body.data.joinCode, link.joinCode);
  assert.equal((await request('GET', `/api/collectors/${link.joinCode}`)).status, 404, 'the old code is dead');
  assert.equal((await request('GET', `/api/collectors/${rotated.body.data.joinCode}`)).status, 200);
});

dbTest('one collector cannot manage another collector link', async () => {
  const a = await makeCollector();
  const b = await makeCollector();
  assert.notEqual(a.link.joinCode, b.link.joinCode, 'each collector gets its own code');

  // /current is resolved from the caller's own tenant, so B's token yields B's link.
  const res = await request('GET', '/api/organizations/current/join-link', { token: await tokenFor(b.admin) });
  assert.equal(res.body.data.joinCode, b.link.joinCode);
});
