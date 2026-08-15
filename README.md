# SUSU SAVE

**Save Together, Grow Together.**

A multi-tenant digital savings platform built on the Ghanaian *Susu* tradition. Individuals,
groups, companies, schools, churches and associations each get their own isolated space to run
rotating group savings, personal savings goals and rent savings — with a real financial ledger
underneath.

---

## Contents

- [What it does](#what-it-does)
- [Tech stack](#tech-stack)
- [Financial integrity model](#financial-integrity-model)
- [Project structure](#project-structure)
- [Getting started](#getting-started)
- [Environment variables](#environment-variables)
- [Seed data and demo logins](#seed-data-and-demo-logins)
- [API reference](#api-reference)
- [Payment integration](#payment-integration)
- [Scheduled jobs](#scheduled-jobs)
- [Testing](#testing)
- [Deploying to Render](#deploying-to-render)
- [Production security checklist](#production-security-checklist)

---

## What it does

### Group SUSU
A group of *N* members contributes a fixed amount every cycle (daily or weekly). Each cycle the
collected pool is paid to one member, following the rotation order, until every member has
received exactly one payout. The platform generates the whole timetable when the group starts:
one contribution row per member per cycle, and one payout row per cycle.

### Individual savings
Personal, emergency, school, business, travel, goal and custom plans with a configurable
contribution rhythm and a monthly maturity/lock rule before funds can be released.

### Rent savings
A dedicated plan type that takes your rent and target date and tracks the monthly amount,
percentage complete, remaining balance and projected completion date.

### Multi-tenancy
Every organization is a separate tenant. A user in Organization A can never read, join or
transact against anything belonging to Organization B — enforced in middleware on every route,
not in the UI.

### Roles
| Role | Sees |
|---|---|
| **Super Admin** | Everything, and alone may change what the platform *is*: fees, limits, plans, roles, account and organization status, and maintenance mode |
| **Admin** (platform staff) | Payment analysis, approving and rejecting withdrawals, the immutable payment record, users and transactions — but no settings, plans or roles |
| **Organization Admin** | Only their own organization's members, groups, money and reports |
| **Group Organizer** | Their group's members, contributions and payout schedule |
| **User** | Their own groups, savings, wallet and transactions |

Both staff accounts are provisioned by a script rather than hard-coded:

```bash
npm run create-admins            # create both, printing credentials once
npm run create-admins -- --reset # rotate the username and password of existing accounts
```

The username carries random entropy so it cannot be guessed from the platform
name, and the password is 20 characters from `crypto.randomBytes`. Nothing
stores the plaintext — if the output is lost, run it again with `--reset`.
Both accounts change their own username and password from the console's
**My account** tab once signed in; staff may sign in with either their username
or their email.

### Maintenance mode

The super admin flips it under **Settings → Rules**. While it is on, an orange
banner appears on every page — landing, login, member app and console alike,
signed in or not — and every write request outside `/auth`, `/admin` and the
job runner is refused with `503 MAINTENANCE_MODE`. Reads keep working, so
people can still sign in and look at their balances.

---

## Tech stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 20+ |
| Server | Express 4 |
| Database | MongoDB + Mongoose |
| Auth | JWT access tokens + httpOnly refresh cookies, bcrypt hashing |
| Frontend | HTML5, CSS3, vanilla JavaScript (ES modules) — no framework |
| Jobs | node-cron |
| Tests | `node:test` + mongodb-memory-server |
| Deployment | Render + MongoDB Atlas |

There is no build step. The frontend ships as static files served by the same Express process.

---

## Financial integrity model

This is a financial application, so a handful of rules are enforced structurally rather than by
convention:

**1. Money is never a float.** Every amount is stored as an integer number of minor units
(pesewas). `src/utils/money.js` is the only place that converts, and it throws if handed a
non-integer. Division happens once, at render time.

**2. The ledger is append-only.** A `Transaction` row's amount, type and direction are never
edited after creation. Corrections are made by writing a compensating `refund` or `adjustment`
row — a rejected withdrawal leaves both the original debit and its reversal on the record.

**3. Wallets are a cache, not the truth.** `walletService.recompute(userId)` rebuilds every
balance and lifetime counter from the ledger. Super Admin can trigger it per user; it is also
what makes the cached projection safe to read.

**4. Debits cannot overdraw.** Wallet debits use an atomic `$inc` guarded by a
`availableBalanceMinor: { $gte: amount }` filter, so two concurrent requests cannot both pass an
availability check. If the ledger write then fails, the balance change is rolled back.

**5. Duplicates cannot create money.** Any operation that could be retried — webhooks, cron runs,
double-clicked buttons — carries a deterministic `idempotencyKey`. A unique partial index rejects
the second write and the original transaction is returned instead. Payouts are keyed
`payout:<groupId>:<cycle>`, so a cycle can only ever be paid once.

**6. Nothing financial is computed on the client.** Payout amounts are summed from contribution
rows at payout time; fees are quoted by the server; the browser only formats what it is given.

**7. Payments settle out-of-band.** A payment is money only after a signature-verified webhook
*and* a server-to-server verification with the provider. A client saying "I paid" merely triggers
that verification.

**8. Fees and limits are configuration, not code.** Every fee, limit, grace period and rule lives
in the `SystemSetting` document and is editable from the admin console. Organizations can override
selected fees.

---

## Project structure

```
susu-save/
├── src/
│   ├── config/            env loading, database connection
│   ├── models/            Mongoose schemas + shared enums (constants.js)
│   ├── middleware/        auth/RBAC/tenancy, validation, rate limits, errors
│   ├── services/          all business logic
│   │   ├── ledger.service.js        the only writer of money
│   │   ├── payout.service.js        the payout engine
│   │   ├── contribution.service.js  cycle payments and missed sweeps
│   │   ├── savings.service.js       plans, deposits, maturity, rent projection
│   │   ├── withdrawal.service.js    two-phase withdrawals with reversal
│   │   ├── settlement.service.js    applies verified payments to the ledger
│   │   ├── fee.service.js           every fee quote in the product
│   │   ├── payment/                 provider abstraction (+ mock provider)
│   │   └── …                        group, dashboard, report, notification, audit
│   ├── controllers/       thin HTTP layer over the services
│   ├── routes/            REST routing and per-route validation
│   ├── jobs/              cron schedule (reminders, payouts, fees, cleanup)
│   ├── utils/             money, dates, ids, errors, http helpers
│   ├── app.js             Express wiring
│   └── server.js          boot, scheduler, graceful shutdown
├── public/
│   ├── index.html         landing page
│   ├── pages/             app shell, admin shell, auth pages
│   ├── css/               design system, app, auth, landing
│   └── js/
│       ├── core/          api client, formatting, UI primitives, store
│       ├── views/         dashboard, groups, savings, wallet, account
│       ├── app.js         shell + client-side router
│       └── admin.js       Super Admin console
├── scripts/seed.js        realistic Ghanaian demo data
├── tests/                 money, ledger, susu, fees, api
└── render.yaml
```

---

## Getting started

### Prerequisites
- Node.js 20 or newer
- MongoDB running locally, or a MongoDB Atlas connection string

```bash
git clone <your-repo-url>
cd susu-save
npm install

cp .env.example .env
# edit .env — at minimum set MONGODB_URI, JWT_SECRET and JWT_REFRESH_SECRET

npm run seed     # optional but recommended: demo users, groups and history
npm run dev      # http://localhost:3000
```

Visit `http://localhost:3000` for the landing page, `/login` to sign in and `/admin` for the
Super Admin console.

### MongoDB Atlas setup
1. Create a free cluster at [mongodb.com/atlas](https://www.mongodb.com/atlas).
2. **Database Access** → add a user with *Read and write to any database*.
3. **Network Access** → allow your IP for local work; for Render, allow `0.0.0.0/0` (Render does
   not publish static egress IPs on lower plans).
4. **Connect** → *Drivers* → copy the connection string into `MONGODB_URI`, appending the
   database name (`/susu_save`).

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `MONGODB_URI` | ✅ | MongoDB connection string |
| `JWT_SECRET` | ✅ (prod) | Signs access tokens |
| `JWT_REFRESH_SECRET` | ✅ (prod) | Signs refresh tokens — must differ from the above |
| `PORT` | | Defaults to 3000; Render sets this automatically |
| `NODE_ENV` | | `development` \| `production` \| `test` |
| `APP_URL` | | Public URL, used in emails and checkout links |
| `JWT_ACCESS_TTL` / `JWT_REFRESH_TTL` | | Token lifetimes (default `30m` / `30d`) |
| `CURRENCY` / `CURRENCY_SYMBOL` | | Default `GHS` / `GH₵` |
| `PAYMENT_PROVIDER` | | Registered provider name (default `mock`) |
| `PAYMENT_PROVIDER_KEY` / `_SECRET` | | Provider credentials |
| `PAYMENT_WEBHOOK_SECRET` | ✅ (prod) | Secret used to verify webhook signatures |
| `EMAIL_DRIVER` | | `console` (default) or `smtp` |
| `EMAIL_*` | | SMTP settings when using a real mail driver |
| `ENABLE_JOBS` | | `false` disables cron on this instance |
| `CORS_ORIGINS` | | Comma-separated allowed origins |
| `MONGODB_TEST_URI` | | Point the test suite at a real database |

In production the app **refuses to start** without `MONGODB_URI`, `JWT_SECRET` and
`JWT_REFRESH_SECRET` — there are no insecure fallbacks outside development.

---

## Seed data and demo logins

```bash
npm run seed            # wipe and reseed
npm run seed -- --keep  # seed without wiping
```

All demo accounts use the password `Password123`.

| Role | Email |
|---|---|
| Super Admin | `admin@sususave.app` |
| Organization Admin | `grace@abccompany.test` |
| Member (Ama) | `ama@sususave.test` |
| Member (Kofi) | `kofi@sususave.test` |
| Member (Afia) | `afia@sususave.test` |

The seed creates three live groups — *Adom Susu Group* (daily, 10 members, mid-rotation),
*Market Queens Susu* (weekly, 6 members) and *ABC Staff Welfare Susu* — with genuine
contribution and payout history, plus emergency, school and rent savings plans. Nothing is
faked: every figure on the dashboard comes from real ledger rows created by the same services
the app uses at runtime.

> The seed disables the registration paywall so demo users can transact immediately. Turn
> `rules.requireRegistrationPayment` back on in the admin console to exercise the paid signup flow.

---

## API reference

All responses share one envelope:

```json
{ "success": true,  "message": "Contribution successful", "data": { } }
{ "success": false, "message": "Insufficient balance", "errorCode": "INSUFFICIENT_BALANCE" }
```

Authenticate with `Authorization: Bearer <accessToken>`. The refresh token is an httpOnly cookie;
`POST /api/auth/refresh` issues a new access token.

### Auth
| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/auth/register` | Personal or organization signup |
| POST | `/api/auth/login` | Sign in |
| POST | `/api/auth/refresh` | New access token from the refresh cookie |
| POST | `/api/auth/logout` | Clear the refresh cookie |
| POST | `/api/auth/forgot-password` | Request a reset link |
| POST | `/api/auth/reset-password` | Complete a reset |
| POST | `/api/auth/verify-email` | Verify an email address |

### Users, dashboard, search
`GET /api/users/me` · `PATCH /api/users/me` · `POST /api/users/me/password` ·
`GET /api/users/:id` · `GET /api/dashboard` · `GET /api/search?q=` ·
`GET /api/settings/public` (public)

### Groups
| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/groups` | Groups you belong to |
| POST | `/api/groups/preview` | Price a group before creating it |
| POST | `/api/groups` | Create a group |
| POST | `/api/groups/join` | Join with an invite code |
| GET | `/api/groups/lookup/:code` | Preview a group by code |
| GET | `/api/groups/:groupId` | Group overview |
| GET | `/api/groups/:groupId/schedule` | Full cycle timetable |
| GET | `/api/groups/:groupId/calendar` | Calendar data for a month |
| GET/POST | `/api/groups/:groupId/members…` | List, approve/reject, remove |
| POST | `/api/groups/:groupId/payout-order` | Set the rotation (organizer, pre-start) |
| POST | `/api/groups/:groupId/activate` | Start the group and build the schedule |
| GET/POST | `/api/groups/:groupId/contributions` | History and payment |
| GET | `/api/groups/:groupId/payouts` | Payout schedule |
| POST | `/api/groups/:groupId/payouts/:payoutId/run` | Run a payout (engine still decides) |

### Savings
`GET/POST /api/savings` · `GET/PATCH /api/savings/:id` · `POST /api/savings/:id/deposit` ·
`POST /api/savings/:id/release` · `GET /api/savings/rent/overview` · `GET /api/savings/quote`

### Wallet, transactions, withdrawals
`GET /api/wallet` · `POST /api/wallet/topup` ·
`POST /api/wallet/payments/:reference/confirm` · `GET /api/transactions` ·
`GET /api/transactions/:id` (includes a printable receipt) · `GET /api/withdrawals` ·
`GET /api/withdrawals/quote` · `POST /api/withdrawals`

### Organizations
`GET/PATCH /api/organizations/current` · `GET /api/organizations/current/members` ·
`POST /api/organizations/current/members/invite` · `DELETE …/members/:memberId` ·
`POST …/members/:memberId/suspend` · `GET /api/organizations/current/groups` ·
`POST /api/organizations/invitations/accept` · `GET /api/my-organization`

### Admin (Super Admin only)
`/api/admin/overview` · `/charts` · `/users` · `/users/:id` · `/users/:id/status` ·
`/users/:id/role` · `/users/:id/reset-password` · `/users/:id/recompute-wallet` ·
`/organizations` · `/organizations/:id/status` · `/organizations/:id/plan` · `/groups` ·
`/transactions` (`?format=csv`) · `/withdrawals` · `/withdrawals/:id/approve` ·
`/withdrawals/:id/reject` · `/payouts` · `/payouts/run-due` · `/payouts/:id/run` ·
`/settings` · `/plans` · `/audit-logs` · `/reports/:kind`

### Payments
`POST /api/payments/webhook` (unauthenticated, signature-verified) ·
`POST /api/payments/webhook/:provider` · `GET /api/payments/:reference`

### Health
`GET /health` → `{ "status": "ok", "database": "connected", … }`

---

## Payment integration

`PaymentService` is the only seam between SUSU SAVE and a money-movement provider. To add MTN
MoMo, Telecel Cash, a card processor or a bank rail:

1. Create `src/services/payment/<name>.provider.js` exporting `name`, `initiate`, `verify`,
   `disburse`, `verifySignature` and `signatureHeader`.
2. Register it: `paymentService.registerProvider(require('./<name>.provider'))`.
3. Set `PAYMENT_PROVIDER=<name>` and the provider credentials.

No savings, payout, wallet or ledger code changes — that is the point of the abstraction.

The money-in flow is deliberately indirect:

```
client requests top-up
  → PaymentService.initiate()      pending Payment, no money yet
  → user approves on their phone
  → provider POSTs the webhook
  → signature verified over the RAW body
  → server re-verifies with the provider
  → settlement.settlePayment()     idempotent ledger write
  → wallet credited, notification sent
```

Card credentials are never accepted or stored — only provider references.

---

## Scheduled jobs

Registered in `src/jobs/index.js`, all times Africa/Accra, all safe to re-run:

| Schedule | Job |
|---|---|
| 08:00 daily | Contribution reminders (one day ahead) |
| 09:00 daily | Due-today reminders |
| 09:30 daily | Upcoming payout reminders |
| 01:00 daily | Sweep overdue contributions into *missed* |
| 02:00 daily | Run all due payouts |
| 02:15 daily | Re-sync stalled group cycles |
| 03:00 on the 1st | Monthly platform fees |
| 04:00 daily | Expire invitations |
| 04:20 daily | Flag past-due subscriptions |
| 05:00 Sundays | Clean up old read notifications |

Set `ENABLE_JOBS=false` on any instance that should not run cron work (useful if you scale to
more than one web instance — otherwise every instance runs the same jobs).

---

## Testing

```bash
npm test
```

Five suites cover the parts where a bug costs someone money:

- **money** — minor-unit conversion, rounding, no floating-point drift across 1,000 fee calculations
- **ledger** — fee handling, insufficient-balance rejection, idempotent replays, concurrent
  debits that must not overdraw, rebuilding a wallet from the ledger
- **susu** — schedule generation, one payout per member, rotation order, contribution limits,
  payouts held on an incomplete pool, double-payout prevention, cycle ordering, missed sweeps
- **fees** — configured fee resolution, organization overrides, withdrawal minimums, withdrawal
  reversal, savings lock periods, rent projection
- **api** — registration and login over real HTTP, account enumeration resistance, RBAC,
  tenant isolation, query-operator injection, webhook signature rejection and replay safety

The pure-logic suite runs anywhere. The database-backed suites need MongoDB: they use
`mongodb-memory-server` (downloaded on first run) or `MONGODB_TEST_URI` if you set it. In an
environment with no access to either, those tests report the reason and skip rather than failing
with a confusing network error.

---

## Deploying to Render

1. **Push to GitHub.**
   ```bash
   git add .
   git commit -m "SUSU SAVE"
   git push -u origin main
   ```

2. **Create the MongoDB Atlas database** (see above) and copy the connection string.

3. **Create the Render Web Service** — New → Web Service → connect the repository.
   `render.yaml` supplies the configuration, or set it manually:
   - Runtime **Node**
   - Build command `npm ci --omit=dev`
   - Start command `npm start`
   - Health check path `/health`

4. **Add the environment variables** in the Render dashboard:
   `MONGODB_URI`, `APP_URL` (your Render URL), `JWT_SECRET`, `JWT_REFRESH_SECRET`,
   `PAYMENT_WEBHOOK_SECRET`, `NODE_ENV=production`, plus provider and email settings.

5. **Deploy**, then verify:
   ```bash
   curl https://<your-app>.onrender.com/health
   # {"status":"ok","database":"connected", …}
   ```

6. **Create the first Super Admin.** Register normally, then promote that user — either from an
   existing admin (`POST /api/admin/users/:id/role`) or directly in Atlas by setting
   `role: "super_admin"` on the user document.

7. **Custom domain** — Render → Settings → Custom Domains, add the CNAME your DNS provider needs,
   then update `APP_URL` so emails and checkout links point at the right host.

The server listens on `process.env.PORT`, serves the frontend itself, and shuts down gracefully
on `SIGTERM` (stops the scheduler, drains connections, closes MongoDB, with a 15-second hard
timeout).

---

## Production security checklist

- [ ] `JWT_SECRET` and `JWT_REFRESH_SECRET` are long, random and different from each other
- [ ] `.env` is not committed — confirm with `git log --all --full-history -- .env`
- [ ] `NODE_ENV=production` (hides stack traces, enables `secure` cookies)
- [ ] `PAYMENT_WEBHOOK_SECRET` matches your provider's signing secret
- [ ] Atlas database user has the narrowest workable role, with a strong password
- [ ] Atlas network access restricted as tightly as your hosting allows
- [ ] `CORS_ORIGINS` set to your real front-end origins
- [ ] A real `EMAIL_DRIVER` configured — the `console` driver silently drops mail
- [ ] Registration fee, platform fees and limits reviewed in the admin console
- [ ] First Super Admin created, and no demo/seed accounts left in the production database
- [ ] `ENABLE_JOBS=true` on exactly one instance if you run more than one
- [ ] Atlas backups enabled
- [ ] Audit log reviewed periodically (`/admin` → Audit logs)

Already handled in code: Helmet with a restrictive CSP, HSTS via Helmet defaults, CORS,
rate limiting (global, auth and financial tiers), bcrypt at cost 12, account lockout after five
failed logins, hashed single-use reset and verification tokens, MongoDB operator sanitisation,
allowlisted profile fields, tenant checks on every scoped route, immutable audit logs, and
masked mobile money numbers in API responses.

---

## Licence

MIT
