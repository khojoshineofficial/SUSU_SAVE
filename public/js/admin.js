/** Super Admin console: platform overview, users, organizations, money and settings. */

import { api, bootstrapSession } from './core/api.js';
import { money, date, dateTime, escape, statusBadge, titleCase } from './core/format.js';
import {
  icon, emptyState, errorState, skeletonLines, skeletonCards, toastSuccess, toastError,
  modal, confirmDialog, buttonLoading, avatar,
} from './core/ui.js';
import { mountBackToTop, mountCredit, mountMaintenanceBanner } from './core/chrome.js';

let currentUser = null;

/**
 * Tabs marked `owner: true` change what the platform is, and belong to the
 * super admin alone. The rest are the admin's job: look at the money, act on
 * payments, and keep the record.
 */
const TABS = [
  ['overview', 'Overview', 'dashboard'],
  ['payments', 'Payments', 'credit-card'],
  ['withdrawals', 'Approvals', 'arrow-up-right'],
  ['records', 'Records', 'receipt'],
  ['users', 'Users', 'users'],
  ['transactions', 'Transactions', 'receipt'],
  ['organizations', 'Organizations', 'building', true],
  ['groups', 'Groups', 'piggy-bank', true],
  ['payouts', 'Payouts', 'gift', true],
  ['reports', 'Reports', 'pie-chart', true],
  ['plans', 'Plans', 'credit-card', true],
  ['audit', 'Audit logs', 'shield'],
  ['settings', 'Settings', 'settings', true],
  ['account', 'My account', 'user'],
];

const isOwner = () => currentUser?.role === 'super_admin';
const visibleTabs = () => TABS.filter(([, , , ownerOnly]) => !ownerOnly || isOwner());

/* --------------------------------- overview -------------------------------- */

async function overviewTab(root) {
  root.innerHTML = skeletonCards(4);
  try {
    const [data, charts] = await Promise.all([api.get('/admin/overview'), api.get('/admin/charts')]);

    root.innerHTML = `
      <div class="stat-grid">
        ${stat('purple', 'users', 'Total users', String(data.totalUsers), `${data.activeUsers} active`)}
        ${stat('blue', 'building', 'Organizations', String(data.totalOrganizations), `${data.activeOrganizations} active`)}
        ${stat('green', 'piggy-bank', 'Total savings', money(data.totalSavedMinor), 'Net of fees')}
        ${stat('orange', 'gift', 'Total payouts', money(data.totalPaidOutMinor), 'Paid to members')}
      </div>
      <div class="stat-grid">
        ${stat('purple', 'trending-up', 'Platform revenue', money(data.platformRevenueMinor),
    `${money(data.revenueBreakdown.withheldFeesMinor)} withheld + ${money(data.revenueBreakdown.directChargesMinor)} charged`)}
        ${stat('orange', 'arrow-up-right', 'Pending withdrawals', String(data.pendingWithdrawals), 'Awaiting review')}
        ${stat('blue', 'users', 'Active groups', String(data.activeGroups), `${data.totalGroups} total`)}
        ${stat('green', 'check-circle', 'Active users', String(data.activeUsers), 'Can transact')}
      </div>

      <div class="dash-grid">
        <div class="card">
          <div class="card-head"><h3>Savings over time</h3><span class="badge">Last 30 days</span></div>
          <div class="card-body">${sparkline(charts.savings)}</div>
        </div>
        <div class="card">
          <div class="card-head"><h3>Payouts over time</h3><span class="badge">Last 30 days</span></div>
          <div class="card-body">${sparkline(charts.payouts, 'var(--orange-500)')}</div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>New users</h3></div>
        <div class="card-body">${sparkline(charts.growth.users.map((r) => ({ period: r.period, totalMinor: r.count * 100 })), 'var(--green-500)')}</div>
      </div>`;
  } catch (err) {
    root.innerHTML = errorState(err.message);
  }
}

const stat = (tone, iconName, label, value, meta) => `
  <div class="stat ${tone}">
    <div class="stat-icon">${icon(iconName)}</div>
    <div class="stat-label">${escape(label)}</div>
    <div class="stat-value" style="font-size:1.6rem">${escape(value)}</div>
    <div class="stat-meta">${escape(meta)}</div>
  </div>`;

/** A dependency-free SVG sparkline — no chart library, no external request. */
function sparkline(series, color = 'var(--purple-600)') {
  if (!series?.length) return '<p class="muted small center" style="padding:32px 0">No data for this period yet.</p>';
  const values = series.map((p) => p.totalMinor);
  const max = Math.max(...values, 1);
  const width = 100;
  const height = 40;
  const points = series.map((p, i) => {
    const x = series.length === 1 ? width / 2 : (i / (series.length - 1)) * width;
    const y = height - (p.totalMinor / max) * (height - 4) - 2;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');

  const total = values.reduce((a, b) => a + b, 0);
  return `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" style="width:100%;height:120px">
      <polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.4"
        stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
    </svg>
    <div class="row-between small muted" style="margin-top:10px">
      <span>${escape(series[0].period)}</span>
      <span class="strong">Total ${money(total)}</span>
      <span>${escape(series[series.length - 1].period)}</span>
    </div>`;
}

/* ---------------------------------- users ---------------------------------- */

async function usersTab(root) {
  root.innerHTML = `
    <div class="card">
      <div class="card-head">
        <div class="row wrap">
          <input class="input" id="q" placeholder="Search name, email or phone" style="width:280px">
          <select class="select" id="status" style="width:auto">
            <option value="">All statuses</option>
            ${['active', 'pending_payment', 'suspended', 'inactive'].map((s) => `<option value="${s}">${titleCase(s)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div id="list">${skeletonLines(8)}</div>
    </div>`;

  const load = async () => {
    const list = root.querySelector('#list');
    list.innerHTML = skeletonLines(8);
    try {
      const { users } = await api.get('/admin/users', {
        q: root.querySelector('#q').value,
        status: root.querySelector('#status').value,
        limit: 50,
      });
      list.innerHTML = users.length ? `
        <div class="table-wrap"><table class="table">
          <thead><tr><th>User</th><th>Phone</th><th>Organization</th><th>Role</th><th>Status</th><th>Joined</th><th></th></tr></thead>
          <tbody>${users.map((u) => `
            <tr>
              <td data-label="User"><div class="row">${avatar(u.firstName, u.lastName, u.avatarUrl, 'avatar-sm')}
                <div><div class="strong">${escape(u.firstName)} ${escape(u.lastName)}</div>
                <div class="tiny muted">${escape(u.email)}</div></div></div></td>
              <td data-label="Phone">${escape(u.phone || '—')}</td>
              <td data-label="Organization">${escape(u.organizationId?.name || '—')}</td>
              <td data-label="Role">${titleCase(u.role)}</td>
              <td data-label="Status">${statusBadge(u.status)}</td>
              <td data-label="Joined">${date(u.createdAt)}</td>
              <td data-label=""><button class="btn btn-secondary btn-sm" data-view="${u.id || u._id}">View</button></td>
            </tr>`).join('')}</tbody>
        </table></div>`
        : emptyState({ icon: 'users', title: 'No users found', message: 'Try a different search or filter.' });

      list.querySelectorAll('[data-view]').forEach((btn) =>
        btn.addEventListener('click', () => openUserModal(btn.dataset.view, load)));
    } catch (err) {
      list.innerHTML = errorState(err.message);
    }
  };

  let timer;
  root.querySelector('#q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 350); });
  root.querySelector('#status').addEventListener('change', load);
  load();
}

async function openUserModal(userId, reload) {
  const dialog = modal({ title: 'User', body: skeletonLines(5), size: 'modal-lg' });
  try {
    const { user, wallet, transactions } = await api.get(`/admin/users/${userId}`);
    dialog.root.querySelector('.modal-body').innerHTML = `
      <div class="row" style="margin-bottom:20px">
        ${avatar(user.firstName, user.lastName, user.avatarUrl, 'avatar-lg')}
        <div>
          <h3>${escape(user.firstName)} ${escape(user.lastName)}</h3>
          <div class="small muted">${escape(user.email)} · ${escape(user.phone || 'no phone')}</div>
          <div class="row" style="margin-top:6px">${statusBadge(user.status)}<span class="badge">${titleCase(user.role)}</span></div>
        </div>
      </div>

      <div class="review-list">
        <div class="review-row"><span class="k">Wallet balance</span><span class="v">${money(wallet.availableBalanceMinor)}</span></div>
        <div class="review-row"><span class="k">Total contributed</span><span class="v">${money(wallet.totalContributedMinor)}</span></div>
        <div class="review-row"><span class="k">Total received</span><span class="v">${money(wallet.totalReceivedMinor)}</span></div>
        <div class="review-row"><span class="k">Total withdrawn</span><span class="v">${money(wallet.totalWithdrawnMinor)}</span></div>
        <div class="review-row"><span class="k">Fees paid</span><span class="v">${money(wallet.totalFeesPaidMinor)}</span></div>
        <div class="review-row"><span class="k">Joined</span><span class="v">${date(user.createdAt)}</span></div>
      </div>

      <h4 style="margin:20px 0 8px">Recent transactions</h4>
      ${transactions.length ? transactions.slice(0, 8).map((t) => `
        <div class="row-between small" style="padding:8px 0;border-bottom:1px solid var(--border)">
          <span>${escape(t.description || titleCase(t.type))}<br><span class="tiny muted">${dateTime(t.createdAt)}</span></span>
          <span class="${t.direction === 'credit' ? 'money-in' : 'money-out'}">${money(t.grossAmountMinor)}</span>
        </div>`).join('') : '<p class="muted small">No transactions.</p>'}

      <div class="row wrap" style="margin-top:20px;gap:8px">
        <button class="btn btn-secondary btn-sm" data-act="${user.status === 'suspended' ? 'activate' : 'suspend'}">
          ${user.status === 'suspended' ? 'Reactivate account' : 'Suspend account'}</button>
        <button class="btn btn-secondary btn-sm" data-act="reset">Issue password reset</button>
        <button class="btn btn-secondary btn-sm" data-act="recompute">Recompute wallet from ledger</button>
      </div>`;

    dialog.root.querySelectorAll('[data-act]').forEach((btn) => btn.addEventListener('click', async () => {
      const restore = buttonLoading(btn);
      try {
        if (btn.dataset.act === 'reset') {
          await api.post(`/admin/users/${userId}/reset-password`);
          toastSuccess('Password reset link issued');
        } else if (btn.dataset.act === 'recompute') {
          await api.post(`/admin/users/${userId}/recompute-wallet`);
          toastSuccess('Wallet recomputed from the ledger');
        } else {
          await api.post(`/admin/users/${userId}/status`, {
            status: btn.dataset.act === 'suspend' ? 'suspended' : 'active',
          });
          toastSuccess('Account status updated');
          dialog.close();
          reload();
        }
      } catch (err) {
        toastError(err.message);
      } finally {
        restore();
      }
    }));
  } catch (err) {
    dialog.root.querySelector('.modal-body').innerHTML = errorState(err.message);
  }
}

/* ------------------------------ organizations ------------------------------ */

async function organizationsTab(root) {
  root.innerHTML = `<div class="card"><div class="card-head"><h3>Organizations</h3></div><div id="list">${skeletonLines(6)}</div></div>`;

  const load = async () => {
    try {
      const { organizations } = await api.get('/admin/organizations', { limit: 50 });
      root.querySelector('#list').innerHTML = organizations.length ? `
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Organization</th><th>Type</th><th>Admin</th><th>Members</th><th>Groups</th><th>Saved</th><th>Plan</th><th>Status</th><th></th></tr></thead>
          <tbody>${organizations.map((o) => `
            <tr>
              <td data-label="Organization"><div class="strong">${escape(o.name)}</div>
                <div class="tiny muted">${date(o.createdAt)}</div></td>
              <td data-label="Type">${titleCase(o.type)}</td>
              <td data-label="Admin">${escape(o.adminId ? `${o.adminId.firstName} ${o.adminId.lastName}` : '—')}</td>
              <td data-label="Members">${o.memberCount}</td>
              <td data-label="Groups">${o.groupCount}</td>
              <td data-label="Saved">${money(o.totalSavedMinor)}</td>
              <td data-label="Plan">${titleCase(o.planCode)}</td>
              <td data-label="Status">${statusBadge(o.status)}</td>
              <td data-label=""><button class="btn btn-secondary btn-sm"
                data-toggle="${o._id}" data-status="${o.status}">
                ${o.status === 'suspended' ? 'Activate' : 'Suspend'}</button></td>
            </tr>`).join('')}</tbody>
        </table></div>`
        : emptyState({ icon: 'building', title: 'No organizations yet', message: 'Organizations appear here once they register.' });

      root.querySelectorAll('[data-toggle]').forEach((btn) => btn.addEventListener('click', async () => {
        const suspending = btn.dataset.status !== 'suspended';
        const confirmed = await confirmDialog({
          title: suspending ? 'Suspend this organization?' : 'Reactivate this organization?',
          message: suspending
            ? 'All of its members will be suspended too and will not be able to transact.'
            : 'The organization will be able to operate again. Member accounts must be reactivated individually.',
          confirmLabel: suspending ? 'Suspend' : 'Activate',
          danger: suspending,
        });
        if (!confirmed) return;
        try {
          await api.post(`/admin/organizations/${btn.dataset.toggle}/status`, {
            status: suspending ? 'suspended' : 'active',
          });
          toastSuccess('Organization updated');
          load();
        } catch (err) {
          toastError(err.message);
        }
      }));
    } catch (err) {
      root.querySelector('#list').innerHTML = errorState(err.message);
    }
  };
  load();
}

/* ---------------------------------- groups --------------------------------- */

async function groupsTab(root) {
  root.innerHTML = `<div class="card"><div class="card-head"><h3>All SUSU groups</h3></div><div id="list">${skeletonLines(6)}</div></div>`;
  try {
    const { groups } = await api.get('/admin/groups', { limit: 50 });
    root.querySelector('#list').innerHTML = groups.length ? `
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Group</th><th>Organization</th><th>Organizer</th><th>Members</th><th>Contribution</th><th>Cycle</th><th>Collected</th><th>Status</th></tr></thead>
        <tbody>${groups.map((g) => `
          <tr>
            <td data-label="Group"><div class="strong">${escape(g.name)}</div><div class="tiny muted">${escape(g.inviteCode)}</div></td>
            <td data-label="Organization">${escape(g.organizationId?.name || 'Personal')}</td>
            <td data-label="Organizer">${escape(g.organizerId ? `${g.organizerId.firstName} ${g.organizerId.lastName}` : '—')}</td>
            <td data-label="Members">${g.stats?.activeMembers || 0}/${g.memberLimit}</td>
            <td data-label="Contribution">${money(g.contributionAmountMinor)} ${escape(g.contributionFrequency)}</td>
            <td data-label="Cycle">${g.currentCycle}/${g.totalCycles}</td>
            <td data-label="Collected">${money(g.stats?.totalCollectedMinor || 0)}</td>
            <td data-label="Status">${statusBadge(g.status)}</td>
          </tr>`).join('')}</tbody>
      </table></div>`
      : emptyState({ icon: 'users', title: 'No groups yet', message: 'Groups appear here as members create them.' });
  } catch (err) {
    root.querySelector('#list').innerHTML = errorState(err.message);
  }
}

/* ------------------------------- transactions ------------------------------ */

async function transactionsTab(root) {
  root.innerHTML = `
    <div class="card">
      <div class="card-head">
        <div class="row wrap">
          <select class="select" id="type" style="width:auto">
            <option value="">All types</option>
            ${['contribution', 'payout', 'deposit', 'withdrawal', 'registration_fee', 'platform_fee', 'refund']
    .map((t) => `<option value="${t}">${titleCase(t)}</option>`).join('')}
          </select>
        </div>
        <a class="btn btn-secondary btn-sm" id="export" href="/api/admin/transactions?format=csv">${icon('download', 'icon icon-sm')} Export CSV</a>
      </div>
      <div id="list">${skeletonLines(8)}</div>
    </div>`;

  const load = async () => {
    try {
      const { transactions } = await api.get('/admin/transactions', {
        type: root.querySelector('#type').value,
        limit: 50,
      });
      root.querySelector('#list').innerHTML = transactions.length ? `
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Transaction</th><th>User</th><th>Type</th><th>Amount</th><th>Fee</th><th>Net</th><th>Status</th><th>Date</th></tr></thead>
          <tbody>${transactions.map((t) => `
            <tr>
              <td data-label="Transaction"><span class="small">${escape(t.transactionId)}</span></td>
              <td data-label="User">${escape(t.userId ? `${t.userId.firstName} ${t.userId.lastName}` : '—')}</td>
              <td data-label="Type">${titleCase(t.type)}</td>
              <td data-label="Amount" class="${t.direction === 'credit' ? 'money-in' : 'money-out'}">${money(t.grossAmountMinor)}</td>
              <td data-label="Fee">${money(t.feeMinor)}</td>
              <td data-label="Net">${money(t.netAmountMinor)}</td>
              <td data-label="Status">${statusBadge(t.status)}</td>
              <td data-label="Date">${dateTime(t.createdAt)}</td>
            </tr>`).join('')}</tbody>
        </table></div>`
        : emptyState({ icon: 'receipt', title: 'No transactions', message: 'Ledger rows will appear here as members transact.' });
    } catch (err) {
      root.querySelector('#list').innerHTML = errorState(err.message);
    }
  };

  root.querySelector('#type').addEventListener('change', load);
  load();
}

/* -------------------------------- withdrawals ------------------------------- */

async function withdrawalsTab(root) {
  root.innerHTML = `
    <div class="card">
      <div class="card-head"><h3>Withdrawal requests</h3>
        <select class="select" id="status" style="width:auto">
          <option value="pending">Pending</option>
          <option value="">All</option>
          <option value="completed">Completed</option>
          <option value="rejected">Rejected</option>
          <option value="failed">Failed</option>
        </select>
      </div>
      <div id="list">${skeletonLines(5)}</div>
    </div>`;

  const load = async () => {
    try {
      const { withdrawals } = await api.get('/admin/withdrawals', {
        status: root.querySelector('#status').value,
        limit: 50,
      });
      root.querySelector('#list').innerHTML = withdrawals.length ? `
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Reference</th><th>User</th><th>Amount</th><th>Fee</th><th>Payable</th><th>Destination</th><th>Status</th><th></th></tr></thead>
          <tbody>${withdrawals.map((w) => `
            <tr>
              <td data-label="Reference"><span class="small">${escape(w.reference)}</span><div class="tiny muted">${dateTime(w.createdAt)}</div></td>
              <td data-label="User">${escape(w.userId ? `${w.userId.firstName} ${w.userId.lastName}` : '—')}
                <div class="tiny muted">${escape(w.userId?.phone || '')}</div></td>
              <td data-label="Amount">${money(w.amountMinor)}</td>
              <td data-label="Fee">${money(w.feeMinor)}</td>
              <td data-label="Payable" class="strong">${money(w.netAmountMinor)}</td>
              <td data-label="Destination">${titleCase(w.destination.provider)}<div class="tiny muted">${escape(w.destination.accountNumberMasked || '')}</div></td>
              <td data-label="Status">${statusBadge(w.status)}</td>
              <td data-label="">${w.status === 'pending' ? `
                <div class="row">
                  <button class="btn btn-success btn-sm" data-approve="${w._id}">Approve</button>
                  <button class="btn btn-secondary btn-sm" data-reject="${w._id}">Reject</button>
                </div>` : ''}</td>
            </tr>`).join('')}</tbody>
        </table></div>`
        : emptyState({ icon: 'arrow-up-right', title: 'Nothing to review', message: 'Withdrawal requests appear here for approval.' });

      root.querySelectorAll('[data-approve]').forEach((btn) => btn.addEventListener('click', async () => {
        const restore = buttonLoading(btn);
        try {
          const result = await api.post(`/admin/withdrawals/${btn.dataset.approve}/approve`);
          if (result.completed) toastSuccess('Withdrawal sent');
          else toastError(result.error || 'The provider declined this disbursement — funds were returned to the wallet');
          load();
        } catch (err) {
          toastError(err.message);
          restore();
        }
      }));

      root.querySelectorAll('[data-reject]').forEach((btn) => btn.addEventListener('click', async () => {
        const confirmed = await confirmDialog({
          title: 'Reject this withdrawal?',
          message: 'The full amount will be returned to the user\'s wallet.',
          confirmLabel: 'Reject',
          danger: true,
        });
        if (!confirmed) return;
        try {
          await api.post(`/admin/withdrawals/${btn.dataset.reject}/reject`, { note: 'Rejected by administrator' });
          toastSuccess('Withdrawal rejected and funds returned');
          load();
        } catch (err) {
          toastError(err.message);
        }
      }));
    } catch (err) {
      root.querySelector('#list').innerHTML = errorState(err.message);
    }
  };

  root.querySelector('#status').addEventListener('change', load);
  load();
}

/* --------------------------------- payouts --------------------------------- */

async function payoutsTab(root) {
  root.innerHTML = `
    <div class="card">
      <div class="card-head"><h3>Payout schedule</h3>
        <button class="btn btn-sm" id="run-due">Run all due payouts</button></div>
      <div id="list">${skeletonLines(6)}</div>
    </div>`;

  const load = async () => {
    try {
      const { payouts } = await api.get('/admin/payouts');
      root.querySelector('#list').innerHTML = payouts.length ? `
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Group</th><th>Cycle</th><th>Recipient</th><th>Scheduled</th><th>Expected</th><th>Paid</th><th>Status</th><th></th></tr></thead>
          <tbody>${payouts.slice(0, 80).map((p) => `
            <tr>
              <td data-label="Group">${escape(p.groupId?.name || '—')}</td>
              <td data-label="Cycle">${p.cycle}</td>
              <td data-label="Recipient">${escape(p.recipientId ? `${p.recipientId.firstName} ${p.recipientId.lastName}` : '—')}</td>
              <td data-label="Scheduled">${date(p.scheduledDate)}</td>
              <td data-label="Expected">${money(p.expectedAmountMinor)}</td>
              <td data-label="Paid">${p.status === 'completed' ? money(p.netAmountMinor) : '—'}</td>
              <td data-label="Status">${statusBadge(p.status)}${p.holdReason ? `<div class="tiny muted">${escape(p.holdReason)}</div>` : ''}</td>
              <td data-label="">${p.status !== 'completed' ? `<button class="btn btn-sm" data-run="${p._id}">Run</button>` : ''}</td>
            </tr>`).join('')}</tbody>
        </table></div>`
        : emptyState({ icon: 'gift', title: 'No payouts scheduled', message: 'Payouts appear once groups are activated.' });

      root.querySelectorAll('[data-run]').forEach((btn) => btn.addEventListener('click', async () => {
        const restore = buttonLoading(btn);
        try {
          const result = await api.post(`/admin/payouts/${btn.dataset.run}/run`, {});
          if (result.processed) toastSuccess('Payout completed');
          else toastError(result.verdict?.reason || result.error || 'Not eligible yet', 'Payout held');
          load();
        } catch (err) {
          toastError(err.message);
          restore();
        }
      }));
    } catch (err) {
      root.querySelector('#list').innerHTML = errorState(err.message);
    }
  };

  root.querySelector('#run-due').addEventListener('click', async (e) => {
    const restore = buttonLoading(e.target, 'Running…');
    try {
      const result = await api.post('/admin/payouts/run-due', {});
      toastSuccess(`${result.processed} processed · ${result.held} held · ${result.failed} failed`);
      load();
    } catch (err) {
      toastError(err.message);
    } finally {
      restore();
    }
  });

  load();
}

/* -------------------------------- audit logs ------------------------------- */

async function auditTab(root) {
  root.innerHTML = `<div class="card"><div class="card-head"><h3>Audit log</h3>
    <span class="tiny muted">Append-only record of administrative and financial actions</span></div>
    <div id="list">${skeletonLines(8)}</div></div>`;
  try {
    const { logs } = await api.get('/admin/audit-logs', { limit: 50 });
    root.querySelector('#list').innerHTML = logs.length ? `
      <div class="table-wrap"><table class="table">
        <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>IP</th></tr></thead>
        <tbody>${logs.map((l) => `
          <tr>
            <td data-label="When">${dateTime(l.createdAt)}</td>
            <td data-label="Actor">${escape(l.actorLabel)}<div class="tiny muted">${escape(l.actorRole || '')}</div></td>
            <td data-label="Action"><span class="badge">${escape(l.action)}</span></td>
            <td data-label="Entity">${escape(l.entityType)}<div class="tiny muted">${escape(String(l.entityId || ''))}</div></td>
            <td data-label="IP">${escape(l.ip || '—')}</td>
          </tr>`).join('')}</tbody>
      </table></div>`
      : emptyState({ icon: 'shield', title: 'No audit entries', message: 'Administrative actions are recorded here.' });
  } catch (err) {
    root.querySelector('#list').innerHTML = errorState(err.message);
  }
}

/* --------------------------------- settings -------------------------------- */

async function settingsTab(root) {
  root.innerHTML = `<div class="card card-body">${skeletonLines(8)}</div>`;
  let settings;
  try {
    ({ settings } = await api.get('/admin/settings'));
  } catch (err) {
    root.innerHTML = errorState(err.message);
    return;
  }

  const moneyField = (id, label, value, hint = '') => `
    <div class="field"><label for="${id}">${label}</label>
      <div class="input-group"><span class="prefix">GH₵</span>
        <input class="input" id="${id}" type="number" step="0.01" min="0" value="${(value / 100).toFixed(2)}"></div>
      ${hint ? `<span class="hint">${hint}</span>` : ''}</div>`;

  const percentField = (id, label, value) => `
    <div class="field"><label for="${id}">${label}</label>
      <input class="input" id="${id}" type="number" step="0.01" min="0" max="100" value="${value}">
      <span class="hint">Percentage</span></div>`;

  root.innerHTML = `
    <div class="dash-grid">
      <div class="card">
        <div class="card-head"><h3>Fees</h3></div>
        <div class="card-body">
          <p class="small muted" style="margin-bottom:16px">
            Nothing about pricing is hard-coded — these values drive every fee calculation on the platform.</p>
          ${moneyField('registrationFeeMinor', 'Registration fee', settings.fees.registrationFeeMinor, 'Charged once at sign-up')}
          ${moneyField('monthlyPlatformFeeMinor', 'Monthly platform fee', settings.fees.monthlyPlatformFeeMinor)}
          ${moneyField('groupCreationFeeMinor', 'Group creation fee', settings.fees.groupCreationFeeMinor)}
          ${percentField('savingsFeePercent', 'Savings service fee', settings.fees.savingsFeePercent)}
          ${percentField('withdrawalFeePercent', 'Withdrawal fee', settings.fees.withdrawalFeePercent)}
          ${moneyField('withdrawalFlatFeeMinor', 'Withdrawal flat fee', settings.fees.withdrawalFlatFeeMinor)}
          ${percentField('payoutFeePercent', 'Payout fee', settings.fees.payoutFeePercent)}
          <button class="btn" id="save-fees">Save fees</button>
        </div>
      </div>

      <div class="dash-col">
        <div class="card">
          <div class="card-head"><h3>Limits</h3></div>
          <div class="card-body">
            ${moneyField('minContributionMinor', 'Minimum contribution', settings.limits.minContributionMinor)}
            ${moneyField('maxContributionMinor', 'Maximum contribution', settings.limits.maxContributionMinor)}
            ${moneyField('minWithdrawalMinor', 'Minimum withdrawal', settings.limits.minWithdrawalMinor)}
            ${moneyField('maxWithdrawalMinor', 'Maximum withdrawal', settings.limits.maxWithdrawalMinor)}
            <div class="field"><label for="maxGroupMembers">Maximum group members</label>
              <input class="input" id="maxGroupMembers" type="number" min="2" value="${settings.limits.maxGroupMembers}"></div>
            <button class="btn" id="save-limits">Save limits</button>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>Rules</h3></div>
          <div class="card-body col">
            ${[
    ['requireRegistrationPayment', 'Require a registration payment'],
    ['requireCleanRecordForPayout', 'Recipients must have no missed contributions'],
    ['autoApproveWithdrawals', 'Automatically approve withdrawals'],
    ['lateFeeEnabled', 'Charge late fees'],
  ].map(([key, label]) => `
              <label class="checkbox"><input type="checkbox" data-rule="${key}" ${settings.rules[key] ? 'checked' : ''}>
                <span>${label}</span></label>`).join('')}
            <div class="field" style="margin-top:12px"><label for="defaultGracePeriodDays">Default grace period (days)</label>
              <input class="input" id="defaultGracePeriodDays" type="number" min="0" value="${settings.rules.defaultGracePeriodDays}"></div>
            <div class="field"><label for="individualSavingsLockDays">Individual savings lock (days)</label>
              <input class="input" id="individualSavingsLockDays" type="number" min="0" value="${settings.rules.individualSavingsLockDays}"></div>
            <label class="checkbox"><input type="checkbox" id="maintenanceMode" ${settings.maintenanceMode ? 'checked' : ''}>
              <span class="strong">Maintenance mode</span></label>
            <button class="btn" id="save-rules">Save rules</button>
          </div>
        </div>
      </div>
    </div>`;

  const minorOf = (id) => Math.round(Number(root.querySelector(`#${id}`).value) * 100);
  const numberOf = (id) => Number(root.querySelector(`#${id}`).value);

  const save = async (button, patch) => {
    const restore = buttonLoading(button);
    try {
      await api.patch('/admin/settings', patch);
      toastSuccess('Settings saved');
    } catch (err) {
      toastError(err.message);
    } finally {
      restore();
    }
  };

  root.querySelector('#save-fees').addEventListener('click', (e) => save(e.target, {
    fees: {
      registrationFeeMinor: minorOf('registrationFeeMinor'),
      monthlyPlatformFeeMinor: minorOf('monthlyPlatformFeeMinor'),
      groupCreationFeeMinor: minorOf('groupCreationFeeMinor'),
      savingsFeePercent: numberOf('savingsFeePercent'),
      withdrawalFeePercent: numberOf('withdrawalFeePercent'),
      withdrawalFlatFeeMinor: minorOf('withdrawalFlatFeeMinor'),
      payoutFeePercent: numberOf('payoutFeePercent'),
    },
  }));

  root.querySelector('#save-limits').addEventListener('click', (e) => save(e.target, {
    limits: {
      minContributionMinor: minorOf('minContributionMinor'),
      maxContributionMinor: minorOf('maxContributionMinor'),
      minWithdrawalMinor: minorOf('minWithdrawalMinor'),
      maxWithdrawalMinor: minorOf('maxWithdrawalMinor'),
      maxGroupMembers: numberOf('maxGroupMembers'),
    },
  }));

  root.querySelector('#save-rules').addEventListener('click', (e) => {
    const rules = { defaultGracePeriodDays: numberOf('defaultGracePeriodDays'), individualSavingsLockDays: numberOf('individualSavingsLockDays') };
    root.querySelectorAll('[data-rule]').forEach((box) => { rules[box.dataset.rule] = box.checked; });
    save(e.target, { rules, maintenanceMode: root.querySelector('#maintenanceMode').checked });
  });
}


/* ---------------------------------- reports --------------------------------- */

async function reportsTab(root) {
  root.innerHTML = `
    <div class="card">
      <div class="card-head">
        <div class="row wrap">
          <select class="select" id="kind" style="width:auto">
            <option value="group-performance">Group performance</option>
            <option value="payout-schedule">Payout schedule</option>
            <option value="revenue">Revenue</option>
          </select>
        </div>
      </div>
      <div id="report">${skeletonLines(8)}</div>
    </div>`;

  const renderers = {
    'group-performance': (rows) => (rows.length ? table(
      ['Group', 'Cycle', 'On time', 'Missed', 'Compliance', 'Collected'],
      rows.map((g) => [
        escape(g.name),
        `${g.currentCycle} / ${g.totalCycles}`,
        g.onTimeContributions,
        g.missedContributions,
        g.complianceRate === null ? '—' : `${g.complianceRate}%`,
        money(g.stats?.totalCollectedMinor || 0),
      ]),
    ) : emptyState({ icon: 'pie-chart', title: 'No group data', message: 'Groups appear once members start contributing.' })),

    'payout-schedule': (rows) => (rows.length ? table(
      ['Group', 'Cycle', 'Recipient', 'Scheduled', 'Expected', 'Status'],
      rows.slice(0, 100).map((p) => [
        escape(p.groupId?.name || '—'),
        p.cycle,
        escape(p.recipientId ? `${p.recipientId.firstName} ${p.recipientId.lastName}` : '—'),
        date(p.scheduledDate),
        money(p.expectedAmountMinor),
        statusBadge(p.status),
      ]),
    ) : emptyState({ icon: 'gift', title: 'No payouts scheduled', message: 'Activate a group to generate a schedule.' })),

    revenue: (rows) => {
      const r = rows[0] || {};
      return `
        <div class="card-body">
          <div class="review-list">
            <div class="review-row"><span class="k">Platform revenue</span><span class="v">${money(r.platformRevenueMinor)}</span></div>
            <div class="review-row"><span class="k">Fees withheld inside transactions</span><span class="v">${money(r.revenueBreakdown?.withheldFeesMinor)}</span></div>
            <div class="review-row"><span class="k">Charged directly (registration, subscriptions)</span><span class="v">${money(r.revenueBreakdown?.directChargesMinor)}</span></div>
            <hr class="divider">
            <div class="review-row"><span class="k">Total saved by members</span><span class="v">${money(r.totalSavedMinor)}</span></div>
            <div class="review-row"><span class="k">Total paid out</span><span class="v">${money(r.totalPaidOutMinor)}</span></div>
            <div class="review-row"><span class="k">Active users</span><span class="v">${r.activeUsers} of ${r.totalUsers}</span></div>
            <div class="review-row"><span class="k">Active groups</span><span class="v">${r.activeGroups} of ${r.totalGroups}</span></div>
          </div>
        </div>`;
    },
  };

  const load = async () => {
    const kind = root.querySelector('#kind').value;
    const host = root.querySelector('#report');
    host.innerHTML = skeletonLines(8);
    try {
      const { rows } = await api.get(`/admin/reports/${kind}`);
      host.innerHTML = renderers[kind](rows);
    } catch (err) {
      host.innerHTML = errorState(err.message);
    }
  };

  root.querySelector('#kind').addEventListener('change', load);
  load();
}

/** Small helper: rows in, responsive table out. */
const table = (headers, rows) => `
  <div class="table-wrap"><table class="table">
    <thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((cells) => `<tr>${cells.map((c, i) => `<td data-label="${headers[i]}">${c}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>`;

/* ----------------------------------- plans ---------------------------------- */

async function plansTab(root) {
  root.innerHTML = `
    <div class="card">
      <div class="card-head"><h3>Subscription plans</h3>
        <button class="btn btn-sm" id="new-plan">${icon('plus', 'icon icon-sm')} New plan</button></div>
      <div id="list">${skeletonLines(5)}</div>
    </div>`;

  const load = async () => {
    try {
      const { plans } = await api.get('/admin/plans');
      root.querySelector('#list').innerHTML = plans.length ? `
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Plan</th><th>Code</th><th>Monthly price</th><th>Max members</th><th>Max groups</th><th>Status</th><th></th></tr></thead>
          <tbody>${plans.map((p) => `
            <tr>
              <td data-label="Plan"><div class="strong">${escape(p.name)}</div>
                <div class="tiny muted">${escape(p.description || '')}</div></td>
              <td data-label="Code"><span class="badge">${escape(p.code)}</span></td>
              <td data-label="Monthly price">${money(p.monthlyPriceMinor)}</td>
              <td data-label="Max members">${p.maxMembers}</td>
              <td data-label="Max groups">${p.maxGroups}</td>
              <td data-label="Status">${p.isActive ? '<span class="badge badge-success">Active</span>' : '<span class="badge">Hidden</span>'}</td>
              <td data-label=""><button class="btn btn-secondary btn-sm" data-edit='${escape(JSON.stringify(p))}'>Edit</button></td>
            </tr>`).join('')}</tbody>
        </table></div>`
        : emptyState({ icon: 'credit-card', title: 'No plans yet', message: 'Create the plans organizations can subscribe to.' });

      root.querySelectorAll('[data-edit]').forEach((btn) =>
        btn.addEventListener('click', () => openPlan(JSON.parse(btn.dataset.edit), load)));
    } catch (err) {
      root.querySelector('#list').innerHTML = errorState(err.message);
    }
  };

  root.querySelector('#new-plan').addEventListener('click', () => openPlan(null, load));
  load();
}

function openPlan(plan, reload) {
  const value = (key, fallback = '') => escape(plan?.[key] ?? fallback);
  const dialog = modal({
    title: plan ? `Edit ${plan.name}` : 'New plan',
    body: `
      <div class="row wrap" style="gap:16px">
        <div class="field grow"><label for="name">Name</label>
          <input class="input" id="name" value="${value('name')}" placeholder="Professional"></div>
        <div class="field grow"><label for="code">Code</label>
          <input class="input" id="code" value="${value('code')}" placeholder="professional" ${plan ? 'readonly' : ''}>
          <span class="hint">Lowercase identifier, fixed once created.</span></div>
      </div>
      <div class="field"><label for="description">Description</label>
        <input class="input" id="description" value="${value('description')}"></div>
      <div class="row wrap" style="gap:16px">
        <div class="field grow"><label for="price">Monthly price</label>
          <div class="input-group"><span class="prefix">GH₵</span>
            <input class="input" id="price" type="number" step="0.01" min="0"
              value="${plan ? (plan.monthlyPriceMinor / 100).toFixed(2) : '0.00'}"></div></div>
        <div class="field grow"><label for="maxMembers">Max members</label>
          <input class="input" id="maxMembers" type="number" min="1" value="${value('maxMembers', 25)}"></div>
        <div class="field grow"><label for="maxGroups">Max groups</label>
          <input class="input" id="maxGroups" type="number" min="1" value="${value('maxGroups', 3)}"></div>
      </div>
      <label class="checkbox"><input type="checkbox" id="isActive" ${plan?.isActive !== false ? 'checked' : ''}>
        <span>Available to organizations</span></label>
      <div id="plan-error" class="error"></div>`,
    footer: '<button class="btn btn-secondary" data-close>Cancel</button><button class="btn" data-submit>Save plan</button>',
  });

  dialog.root.querySelector('[data-submit]').addEventListener('click', async (e) => {
    const restore = buttonLoading(e.target);
    const field = (id) => dialog.root.querySelector(`#${id}`);
    try {
      await api.post('/admin/plans', {
        code: field('code').value.trim().toLowerCase(),
        name: field('name').value.trim(),
        description: field('description').value,
        monthlyPriceMinor: Math.round(Number(field('price').value) * 100),
        maxMembers: Number(field('maxMembers').value),
        maxGroups: Number(field('maxGroups').value),
        isActive: field('isActive').checked,
      });
      toastSuccess('Plan saved');
      dialog.close();
      reload();
    } catch (err) {
      dialog.root.querySelector('#plan-error').textContent = err.message;
      restore();
    }
  });
}


/* ------------------------------ payment analysis ----------------------------- */

/**
 * The admin's home view: what money moved, how it moved, what is stuck.
 * All aggregation happens server-side; this only formats the answer.
 */
async function paymentsTab(root) {
  root.innerHTML = `
    <div class="page-head" style="margin-bottom:16px">
      <div><h3>Payment analysis</h3><p class="small muted">How money is flowing through the platform.</p></div>
      <select class="select" id="range" style="width:auto">
        <option value="7">Last 7 days</option>
        <option value="30" selected>Last 30 days</option>
        <option value="90">Last 90 days</option>
        <option value="365">Last 12 months</option>
      </select>
    </div>
    <div id="analysis">${skeletonCards(4)}</div>`;

  const load = async () => {
    const host = root.querySelector('#analysis');
    host.innerHTML = skeletonCards(4);
    const days = Number(root.querySelector('#range').value);
    try {
      const data = await api.get('/admin/payments/analysis', {
        from: new Date(Date.now() - days * 86400000).toISOString(),
      });

      const total = (rows) => rows.reduce((sum, r) => sum + r.totalMinor, 0);
      const successful = data.byStatus.find((r) => r._id === 'successful') || { totalMinor: 0, count: 0 };
      const failed = data.byStatus.find((r) => r._id === 'failed') || { totalMinor: 0, count: 0 };
      const pending = data.byStatus.find((r) => r._id === 'pending') || { totalMinor: 0, count: 0 };
      const feesCollected = data.byType.reduce((sum, r) => sum + (r.feesMinor || 0), 0);

      host.innerHTML = `
        <div class="stat-grid">
          ${stat('green', 'check-circle', 'Settled', money(successful.totalMinor), `${successful.count} transactions`)}
          ${stat('purple', 'trending-up', 'Fees collected', money(feesCollected), 'Platform earnings in range')}
          ${stat('orange', 'calendar-clock', 'Pending', money(pending.totalMinor), `${pending.count} awaiting settlement`)}
          ${stat('blue', 'arrow-up-right', 'Awaiting approval', String(data.alerts.pendingWithdrawals), 'Withdrawal requests')}
        </div>

        ${data.alerts.pendingWithdrawals || failed.count ? `
          <div class="card card-body" style="background:var(--orange-50);border-color:var(--orange-100);margin-bottom:24px">
            <div class="row">${icon('alert-circle')}
              <div>
                <div class="strong small">Needs attention</div>
                <div class="small muted">
                  ${data.alerts.pendingWithdrawals} withdrawal${data.alerts.pendingWithdrawals === 1 ? '' : 's'} awaiting approval ·
                  ${data.alerts.failedPayments} failed payment${data.alerts.failedPayments === 1 ? '' : 's'} in this period
                </div>
              </div>
              <button class="btn btn-sm" style="margin-left:auto" data-goto="withdrawals">Review approvals</button>
            </div>
          </div>` : ''}

        <div class="dash-grid">
          <div class="card">
            <div class="card-head"><h3>Volume over time</h3><span class="badge">${days} days</span></div>
            <div class="card-body">${sparkline(data.daily)}</div>
          </div>
          <div class="card">
            <div class="card-head"><h3>By payment method</h3></div>
            <div class="card-body col">
              ${data.byMethod.length ? data.byMethod.map((m) => `
                <div>
                  <div class="row-between small" style="margin-bottom:6px">
                    <span class="strong">${titleCase(m._id || 'unknown')}</span>
                    <span class="muted">${money(m.totalMinor)} · ${m.count}</span>
                  </div>
                  <div class="progress">
                    <div class="progress-bar" style="width:${total(data.byMethod) ? (m.totalMinor / total(data.byMethod)) * 100 : 0}%"></div>
                  </div>
                </div>`).join('')
    : '<p class="muted small">No settled payments in this period.</p>'}
            </div>
          </div>
        </div>

        <div class="dash-grid">
          <div class="card">
            <div class="card-head"><h3>By transaction type</h3></div>
            ${data.byType.length ? `
            <div class="table-wrap"><table class="table">
              <thead><tr><th>Type</th><th>Volume</th><th>Fees</th><th>Count</th></tr></thead>
              <tbody>${data.byType.map((t) => `
                <tr>
                  <td data-label="Type">${titleCase(t._id)}</td>
                  <td data-label="Volume">${money(t.totalMinor)}</td>
                  <td data-label="Fees">${money(t.feesMinor)}</td>
                  <td data-label="Count">${t.count}</td>
                </tr>`).join('')}</tbody>
            </table></div>` : '<div class="card-body"><p class="muted small">Nothing yet.</p></div>'}
          </div>

          <div class="card">
            <div class="card-head"><h3>Most active users</h3></div>
            ${data.topUsers.length ? `
            <div class="table-wrap"><table class="table">
              <thead><tr><th>User</th><th>Volume</th><th>Fees paid</th><th>Payments</th></tr></thead>
              <tbody>${data.topUsers.map((u) => `
                <tr>
                  <td data-label="User"><div class="strong">${escape(u.name)}</div>
                    <div class="tiny muted">${escape(u.email || '')}</div></td>
                  <td data-label="Volume">${money(u.totalMinor)}</td>
                  <td data-label="Fees paid">${money(u.feesMinor)}</td>
                  <td data-label="Payments">${u.count}</td>
                </tr>`).join('')}</tbody>
            </table></div>` : '<div class="card-body"><p class="muted small">No activity yet.</p></div>'}
          </div>
        </div>`;

      host.querySelector('[data-goto="withdrawals"]')?.addEventListener('click', () => {
        document.querySelector('[data-tab="withdrawals"]').click();
      });
    } catch (err) {
      host.innerHTML = errorState(err.message);
    }
  };

  root.querySelector('#range').addEventListener('change', load);
  load();
}

/* ---------------------------------- records --------------------------------- */

/**
 * Who approved what. Read from the append-only audit log, so an admin cannot
 * quietly edit their own history.
 */
async function recordsTab(root) {
  root.innerHTML = `
    <div class="card">
      <div class="card-head">
        <div><h3>Payment records</h3>
          <div class="tiny muted">Immutable log of approvals, rejections and settlements</div></div>
        <label class="checkbox"><input type="checkbox" id="mine"><span class="small">Only my decisions</span></label>
      </div>
      <div id="list">${skeletonLines(8)}</div>
    </div>`;

  const load = async () => {
    const list = root.querySelector('#list');
    list.innerHTML = skeletonLines(8);
    try {
      const { records } = await api.get('/admin/payments/records', {
        mine: root.querySelector('#mine').checked ? 'true' : '',
        limit: 100,
      });
      list.innerHTML = records.length ? `
        <div class="table-wrap"><table class="table">
          <thead><tr><th>When</th><th>Action</th><th>By</th><th>Reference</th><th>Details</th></tr></thead>
          <tbody>${records.map((r) => `
            <tr>
              <td data-label="When">${dateTime(r.createdAt)}</td>
              <td data-label="Action"><span class="badge ${r.action.includes('rejected') ? 'badge-danger' : 'badge-success'}">${escape(r.action.replace(/[._]/g, ' '))}</span></td>
              <td data-label="By">${escape(r.actorLabel)}<div class="tiny muted">${escape(r.actorRole || '')}</div></td>
              <td data-label="Reference"><span class="small">${escape(String(r.entityId || '—'))}</span></td>
              <td data-label="Details"><span class="small muted">${escape(summariseRecord(r.metadata))}</span></td>
            </tr>`).join('')}</tbody>
        </table></div>`
        : emptyState({ icon: 'receipt', title: 'No records yet', message: 'Payment decisions are recorded here as they happen.' });
    } catch (err) {
      list.innerHTML = errorState(err.message);
    }
  };

  root.querySelector('#mine').addEventListener('change', load);
  load();
}

function summariseRecord(metadata = {}) {
  const parts = [];
  if (metadata.netAmountMinor !== undefined) parts.push(money(metadata.netAmountMinor));
  if (metadata.amountMinor !== undefined) parts.push(money(metadata.amountMinor));
  if (metadata.purpose) parts.push(titleCase(metadata.purpose));
  if (metadata.cycle) parts.push(`cycle ${metadata.cycle}`);
  if (metadata.note) parts.push(metadata.note);
  return parts.join(' · ') || '—';
}

/* --------------------------------- my account -------------------------------- */

/** Staff change their own username and password here — no database edit needed. */
async function accountTab(root) {
  const me = currentUser || {};
  root.innerHTML = `
    <div class="dash-grid">
      <div class="card">
        <div class="card-head"><h3>Sign-in details</h3></div>
        <div class="card-body">
          <div class="review-list" style="margin-bottom:20px">
            <div class="review-row"><span class="k">Name</span><span class="v">${escape(me.firstName || '')} ${escape(me.lastName || '')}</span></div>
            <div class="review-row"><span class="k">Role</span><span class="v">${titleCase(me.role || '')}</span></div>
            <div class="review-row"><span class="k">Username</span><span class="v" id="current-username">${escape(me.username || 'not set')}</span></div>
            <div class="review-row"><span class="k">Email</span><span class="v">${escape(me.email || '')}</span></div>
          </div>

          <form id="username-form">
            <h4 style="margin-bottom:12px">Change username</h4>
            <div class="field"><label for="new-username">New username</label>
              <input class="input" id="new-username" placeholder="susu.owner.k4p2" minlength="4" maxlength="32">
              <span class="hint">4–32 characters: letters, numbers, dot, underscore or hyphen.</span></div>
            <div class="field"><label for="u-password">Current password</label>
              <input class="input" id="u-password" type="password" autocomplete="current-password"></div>
            <button class="btn btn-secondary" type="submit">Update username</button>
          </form>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>Change password</h3></div>
        <div class="card-body">
          <form id="password-form">
            <div class="field"><label for="p-current">Current password</label>
              <input class="input" id="p-current" type="password" autocomplete="current-password"></div>
            <div class="field"><label for="p-new">New password</label>
              <input class="input" id="p-new" type="password" autocomplete="new-password">
              <span class="hint">At least 8 characters, with letters and numbers.</span></div>
            <div class="field"><label for="p-confirm">Confirm new password</label>
              <input class="input" id="p-confirm" type="password" autocomplete="new-password"></div>
            <button class="btn" type="submit">Update password</button>
          </form>
          <p class="tiny muted" style="margin-top:14px">
            Changing either of these takes effect immediately. Other sessions keep working
            until their token expires.
          </p>
        </div>
      </div>
    </div>`;

  root.querySelector('#username-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const restore = buttonLoading(e.target.querySelector('button'));
    try {
      const { user } = await api.post('/users/me/username', {
        username: root.querySelector('#new-username').value.trim(),
        currentPassword: root.querySelector('#u-password').value,
      });
      currentUser = user;
      root.querySelector('#current-username').textContent = user.username;
      e.target.reset();
      toastSuccess(`Username is now ${user.username}`);
    } catch (err) {
      toastError(err.message);
    } finally {
      restore();
    }
  });

  root.querySelector('#password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (root.querySelector('#p-new').value !== root.querySelector('#p-confirm').value) {
      toastError('The two passwords do not match');
      return;
    }
    const restore = buttonLoading(e.target.querySelector('button'));
    try {
      await api.post('/users/me/password', {
        currentPassword: root.querySelector('#p-current').value,
        newPassword: root.querySelector('#p-new').value,
      });
      e.target.reset();
      toastSuccess('Password updated');
    } catch (err) {
      toastError(err.message);
    } finally {
      restore();
    }
  });
}

/* ----------------------------------- boot ---------------------------------- */

const TAB_VIEWS = {
  overview: overviewTab,
  payments: paymentsTab,
  records: recordsTab,
  account: accountTab,
  users: usersTab,
  organizations: organizationsTab,
  groups: groupsTab,
  transactions: transactionsTab,
  withdrawals: withdrawalsTab,
  payouts: payoutsTab,
  reports: reportsTab,
  plans: plansTab,
  audit: auditTab,
  settings: settingsTab,
};

async function boot() {
  const user = await bootstrapSession();
  if (!user) { window.location.href = '/login?next=/admin'; return; }
  if (!['super_admin', 'admin'].includes(user.role)) {
    document.getElementById('app').innerHTML = `
      <div class="empty" style="min-height:100vh;justify-content:center">
        <div class="empty-icon">${icon('shield', 'icon icon-lg')}</div>
        <h4>Staff access required</h4>
        <p>This console is for platform administrators only.</p>
        <a class="btn" href="/dashboard">Back to my dashboard</a>
      </div>`;
    return;
  }
  currentUser = user;

  document.getElementById('app').innerHTML = `
    <div class="shell">
      <aside class="sidebar" id="sidebar">
        <div class="brand">
          <div class="brand-mark">SS</div>
          <div><div class="brand-name">SUSU SAVE</div><div class="brand-tag">Admin Console</div></div>
        </div>
        <nav class="nav" id="nav">
          ${visibleTabs().map(([key, label, ico], i) => `
            <button class="nav-item ${i === 0 ? 'active' : ''}" data-tab="${key}">${icon(ico)} <span>${label}</span></button>`).join('')}
          <div class="nav-label">Shortcuts</div>
          <button class="nav-item" data-href="/dashboard">${icon('home')} <span>User dashboard</span></button>
        </nav>
        <div class="sidebar-promo">
          <h5>${isOwner() ? 'Platform owner' : 'Platform admin'}</h5>
          <p>${isOwner()
    ? 'Full platform access, including settings and maintenance mode.'
    : 'Payments, approvals and records. Every action is written to the audit log.'}</p>
        </div>
      </aside>
      <div class="sidebar-backdrop" id="backdrop"></div>

      <div class="main">
        <header class="topbar">
          <button class="icon-btn" id="menu-toggle">${icon('menu')}</button>
          <div class="greeting">
            <h2 id="tab-title">Overview</h2>
            <p>Platform administration</p>
          </div>
          <div class="topbar-actions">
            <div class="user-chip">
              ${avatar(user.firstName, user.lastName, user.avatarUrl, 'avatar-sm')}
              <span><span class="name">${escape(user.username || `${user.firstName} ${user.lastName}`)}</span>
              <span class="role">${user.role === 'super_admin' ? 'Super Admin' : 'Admin'}</span></span>
            </div>
            <button class="icon-btn" id="logout" title="Sign out">${icon('log-out')}</button>
          </div>
        </header>
        <main class="content" id="view"></main>
        <footer id="app-credit"></footer>
      </div>
    </div>`;

  mountBackToTop();
  mountCredit('#app-credit');
  mountMaintenanceBanner();

  const view = document.getElementById('view');
  const showTab = (key) => {
    // Guard against a bookmarked #settings on an account that may not see it.
    const allowed = visibleTabs().some(([k]) => k === key) ? key : 'overview';
    document.querySelectorAll('[data-tab]').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === allowed));
    document.getElementById('tab-title').textContent = visibleTabs().find(([k]) => k === allowed)[1];
    window.location.hash = allowed;
    TAB_VIEWS[allowed](view);
  };

  document.querySelectorAll('[data-tab]').forEach((btn) => btn.addEventListener('click', () => {
    showTab(btn.dataset.tab);
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('backdrop').classList.remove('open');
  }));

  document.addEventListener('click', (e) => {
    const target = e.target.closest('[data-href]');
    if (!target) return;
    e.preventDefault();
    window.location.href = target.dataset.href;
  });

  document.getElementById('menu-toggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('backdrop').classList.toggle('open');
  });
  document.getElementById('backdrop').addEventListener('click', () => {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('backdrop').classList.remove('open');
  });
  document.getElementById('logout').addEventListener('click', async () => {
    await api.post('/auth/logout').catch(() => {});
    window.location.href = '/login';
  });

  const initial = window.location.hash.slice(1);
  showTab(TAB_VIEWS[initial] ? initial : 'overview');
}

boot();
