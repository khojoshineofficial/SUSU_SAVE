/**
 * Organization admin console.
 *
 * Lives inside the member app shell rather than in a separate surface, because
 * an org admin is also an ordinary saver — they should not have to sign in
 * somewhere else to check their own groups. Every endpoint it calls is scoped
 * to their tenant server-side.
 */

import { api } from '../core/api.js';
import { money, date, dateTime, escape, statusBadge, titleCase, frequencyLabel } from '../core/format.js';
import {
  icon, emptyState, errorState, skeletonLines, skeletonCards, toastSuccess, toastError,
  modal, confirmDialog, buttonLoading, avatar,
} from '../core/ui.js';
import { isOrgAdmin, isSuperAdmin } from '../core/store.js';

const TABS = [
  ['overview', 'Overview'],
  ['members', 'Members'],
  ['groups', 'Groups'],
  ['money', 'Transactions'],
  ['reports', 'Reports'],
  ['settings', 'Settings'],
];

export async function renderOrganization(root, { navigate, query }) {
  if (!isOrgAdmin() && !isSuperAdmin()) {
    root.innerHTML = emptyState({
      icon: 'building',
      title: 'Organization access only',
      message: 'This console is for organization administrators.',
      action: '<button class="btn" data-nav="/dashboard">Back to my dashboard</button>',
    });
    return;
  }

  root.innerHTML = `
    <div class="page-head">
      <div>
        <h1 id="org-name">Organization</h1>
        <p>Members, groups and money across your organization.</p>
      </div>
      <button class="btn" data-action="invite">${icon('user-plus')} Invite member</button>
    </div>
    <div class="tabs" style="margin-bottom:20px">
      ${TABS.map(([key, label], i) => `<button class="tab ${i === 0 ? 'active' : ''}" data-tab="${key}">${label}</button>`).join('')}
    </div>
    <div id="org-panel">${skeletonCards(4)}</div>`;

  const panel = root.querySelector('#org-panel');
  const views = { overview, members, groups, money: transactionsTab, reports, settings };

  const show = (key) => {
    root.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === key));
    views[key](panel, { navigate, reload: () => show(key) });
  };

  root.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => show(tab.dataset.tab)));
  root.querySelector('[data-action="invite"]').addEventListener('click', () => openInvite(() => show('members')));

  // Name the organization in the heading as soon as we know it.
  api.get('/organizations/current')
    .then(({ organization }) => { root.querySelector('#org-name').textContent = organization.name; })
    .catch(() => {});

  show(TABS.some(([k]) => k === query?.tab) ? query.tab : 'overview');
}

/* --------------------------------- overview -------------------------------- */

async function overview(panel, { navigate }) {
  panel.innerHTML = skeletonCards(4);
  let data;
  try {
    data = await api.get('/organizations/current/dashboard');
  } catch (err) {
    panel.innerHTML = errorState(err.message);
    return;
  }

  const { summary, counts, recentTransactions, upcomingPayouts, organization } = data;
  const memberUsage = counts.maxMembers ? Math.round((counts.members / counts.maxMembers) * 100) : null;
  const groupUsage = counts.maxGroups ? Math.round((summary.totalGroups / counts.maxGroups) * 100) : null;

  panel.innerHTML = `
    <div class="card" id="join-link-card" style="margin-bottom:20px">${skeletonLines(2)}</div>

    <div class="stat-grid">
      <div class="stat purple"><div class="stat-icon">${icon('users')}</div><div class="stat-label">Members</div>
        <div class="stat-value">${counts.members}</div>
        <div class="stat-meta">${counts.pendingMembers ? `${counts.pendingMembers} awaiting activation` : 'All activated'}</div></div>
      <div class="stat blue"><div class="stat-icon">${icon('piggy-bank')}</div><div class="stat-label">Groups</div>
        <div class="stat-value">${summary.totalGroups}</div>
        <div class="stat-meta">${summary.activeGroups} active</div></div>
      <div class="stat green"><div class="stat-icon">${icon('trending-up')}</div><div class="stat-label">Total saved</div>
        <div class="stat-value">${money(summary.totalSavedMinor)}</div>
        <div class="stat-meta">${summary.contributionCount} contributions</div></div>
      <div class="stat orange"><div class="stat-icon">${icon('gift')}</div><div class="stat-label">Paid out</div>
        <div class="stat-value">${money(summary.totalPaidOutMinor)}</div>
        <div class="stat-meta">To your members</div></div>
    </div>

    <div class="dash-grid">
      <div class="card">
        <div class="card-head"><h3>Recent activity</h3>
          <button class="btn btn-ghost btn-sm" data-go="money">View all</button></div>
        ${recentTransactions.length ? recentTransactions.map((t) => `
          <div class="txn">
            <div class="txn-icon ${t.direction === 'credit' ? 'in' : 'out'}">
              ${icon(t.direction === 'credit' ? 'arrow-down-left' : 'arrow-up-right', 'icon icon-sm')}</div>
            <div class="info">
              <div class="desc">${escape(t.description || titleCase(t.type))}</div>
              <div class="time">${escape(t.userId ? `${t.userId.firstName} ${t.userId.lastName}` : '')} · ${dateTime(t.createdAt)}</div>
            </div>
            <div class="amount ${t.direction === 'credit' ? 'money-in' : 'money-out'}">${money(t.grossAmountMinor)}</div>
          </div>`).join('')
    : emptyState({ icon: 'receipt', title: 'No activity yet', message: 'Contributions and payouts will appear here.' })}
      </div>

      <div class="dash-col">
        <div class="card">
          <div class="card-head"><h3>Upcoming payouts</h3></div>
          ${upcomingPayouts.length ? upcomingPayouts.map((p) => `
            <div class="payout-item">
              ${avatar(p.recipientId?.firstName, p.recipientId?.lastName, null, 'avatar-sm')}
              <div class="info">
                <div class="name">${escape(p.recipientId ? `${p.recipientId.firstName} ${p.recipientId.lastName}` : '—')}</div>
                <div class="sub">${escape(p.groupId?.name || '')} · ${date(p.scheduledDate)}</div>
              </div>
              <div class="amount"><div class="value">${money(p.expectedAmountMinor)}</div></div>
            </div>`).join('')
    : emptyState({ icon: 'gift', title: 'Nothing scheduled', message: 'Payouts appear once a group starts.' })}
        </div>

        <div class="card">
          <div class="card-head"><h3>Plan usage</h3>
            <span class="badge badge-purple">${titleCase(organization.planCode || 'free')}</span></div>
          <div class="card-body col">
            ${usageBar('Members', counts.members, counts.maxMembers, memberUsage)}
            ${usageBar('Groups', summary.totalGroups, counts.maxGroups, groupUsage)}
            <p class="tiny muted">Limits are set by your subscription plan. Contact the platform to change them.</p>
          </div>
        </div>
      </div>
    </div>`;

  panel.querySelector('[data-go="money"]')?.addEventListener('click', () => {
    document.querySelector('[data-tab="money"]').click();
  });

  mountJoinLink(panel.querySelector('#join-link-card'));
}

/* -------------------------------- join link -------------------------------- */

/**
 * The collector's sign-up link. This is how a susu collector onboards the
 * customers they visit: send the link over WhatsApp, or read the eight-letter
 * code down the phone. Everyone who signs up through it lands in this
 * organization, so the collector sees them and nobody else does.
 */
async function mountJoinLink(card) {
  if (!card) return;
  let link;
  try {
    link = await api.get('/organizations/current/join-link');
  } catch (err) {
    card.innerHTML = errorState(err.message);
    return;
  }

  const render = (data) => {
    card.innerHTML = `
      <div class="card-head">
        <h3>${icon('link')} Your sign-up link</h3>
        <span class="badge ${data.enabled ? 'badge-success' : 'badge-warning'}">${data.enabled ? 'Open' : 'Closed'}</span>
      </div>
      <div class="card-body col">
        <p class="small muted" style="margin:0">
          Send this to a customer and they create their own account under you — then they can
          deposit and check their balance themselves. Nothing to type on their behalf.</p>

        <div class="row wrap" style="gap:10px;align-items:center">
          <input class="input grow" id="join-url" readonly value="${escape(data.url)}" style="font-family:var(--font-mono,monospace);min-width:240px">
          <button class="btn btn-sm" data-action="copy">${icon('copy')} Copy</button>
          <button class="btn btn-ghost btn-sm" data-action="share">${icon('share')} WhatsApp</button>
        </div>

        <div class="row-between small">
          <span class="muted">Or read out the code: <span class="strong" style="letter-spacing:.14em">${escape(data.joinCode)}</span></span>
          <span class="muted">${data.customers} signed up${data.capacity ? ` of ${data.capacity}` : ''}</span>
        </div>

        <div class="row wrap" style="gap:10px">
          <button class="btn btn-ghost btn-sm" data-action="toggle">${data.enabled ? 'Close the link' : 'Open the link'}</button>
          <button class="btn btn-ghost btn-sm" data-action="rotate">Issue a new link</button>
        </div>
        <p class="tiny muted" style="margin:0">
          Closing the link stops new sign-ups without affecting existing customers.
          Issuing a new one stops every link you have already shared from working.</p>
      </div>`;

    card.querySelector('[data-action="copy"]').addEventListener('click', async () => {
      const input = card.querySelector('#join-url');
      try {
        await navigator.clipboard.writeText(input.value);
      } catch {
        // Clipboard access needs a secure context and permission; selecting the
        // text still lets the collector copy it by hand.
        input.select();
      }
      toastSuccess('Link copied');
    });

    card.querySelector('[data-action="share"]').addEventListener('click', () => {
      const text = `Join my susu on SUSU SAVE and save with me. Create your account here: ${data.url}`;
      window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
    });

    card.querySelector('[data-action="toggle"]').addEventListener('click', async (event) => {
      const restore = buttonLoading(event.currentTarget);
      try {
        await api.patch('/organizations/current', { settings: { allowPublicJoin: !data.enabled } });
        toastSuccess(data.enabled ? 'Link closed to new sign-ups' : 'Link is open again');
        render({ ...data, enabled: !data.enabled });
      } catch (err) {
        toastError(err.message);
        restore();
      }
    });

    card.querySelector('[data-action="rotate"]').addEventListener('click', async () => {
      const confirmed = await confirmDialog({
        title: 'Issue a new link?',
        message: 'Every link you have already shared stops working. Customers who already signed up are not affected.',
        confirmLabel: 'Issue new link',
        danger: true,
      });
      if (!confirmed) return;
      try {
        const fresh = await api.post('/organizations/current/join-link/rotate', {});
        toastSuccess('New link issued');
        render({ ...data, ...fresh });
      } catch (err) {
        toastError(err.message);
      }
    });
  };

  render(link);
}

const usageBar = (label, used, max, percent) => `
  <div>
    <div class="row-between small" style="margin-bottom:6px">
      <span class="strong">${label}</span>
      <span class="muted">${used}${max ? ` / ${max}` : ''}</span>
    </div>
    <div class="progress">
      <div class="progress-bar ${percent >= 90 ? 'orange' : ''}" style="width:${Math.min(100, percent ?? 0)}%"></div>
    </div>
  </div>`;

/* ---------------------------------- members --------------------------------- */

async function members(panel, { reload }) {
  panel.innerHTML = `<div class="card">${skeletonLines(6)}</div>`;
  try {
    const { members: rows } = await api.get('/organizations/current/members');
    panel.innerHTML = `
      <div class="card">
        <div class="card-head">
          <h3>Members (${rows.length}) ·
            <span class="muted" style="font-weight:500">${money(rows.reduce((sum, m) => sum + (m.balanceMinor || 0), 0))} held</span></h3>
          <input class="input" id="member-search" placeholder="Search members" style="width:240px">
        </div>
        <div class="table-wrap">
          <table class="table" id="member-table">
            <thead><tr><th>Member</th><th>Phone</th><th class="num">Balance</th><th class="num">Total saved</th><th>Status</th><th>Joined</th><th>Last seen</th><th></th></tr></thead>
            <tbody>${rows.map((m) => `
              <tr data-search="${escape(`${m.firstName} ${m.lastName} ${m.email}`.toLowerCase())}">
                <td data-label="Member"><div class="row">${avatar(m.firstName, m.lastName, m.avatarUrl, 'avatar-sm')}
                  <div><div class="strong">${escape(m.firstName)} ${escape(m.lastName)}</div>
                  <div class="tiny muted">${escape(m.email)}</div></div></div></td>
                <td data-label="Phone">${escape(m.phone || '—')}</td>
                <td data-label="Balance" class="num strong">${money(m.balanceMinor)}</td>
                <td data-label="Total saved" class="num muted">${money(m.totalDepositedMinor)}</td>
                <td data-label="Status">${statusBadge(m.status)}</td>
                <td data-label="Joined">${date(m.createdAt)}</td>
                <td data-label="Last seen">${m.lastLoginAt ? date(m.lastLoginAt) : 'Never'}</td>
                <td data-label="">
                  <div class="row">
                    <button class="btn btn-ghost btn-sm" data-suspend="${m._id}" data-active="${m.status === 'active'}">
                      ${m.status === 'active' ? 'Suspend' : 'Activate'}</button>
                    <button class="btn btn-ghost btn-sm" data-remove="${m._id}">Remove</button>
                  </div>
                </td>
              </tr>`).join('')}</tbody>
          </table>
        </div>
      </div>`;

    const search = panel.querySelector('#member-search');
    search.addEventListener('input', () => {
      const term = search.value.trim().toLowerCase();
      panel.querySelectorAll('#member-table tbody tr').forEach((tr) => {
        tr.style.display = !term || tr.dataset.search.includes(term) ? '' : 'none';
      });
    });

    panel.querySelectorAll('[data-suspend]').forEach((btn) => btn.addEventListener('click', async () => {
      const restore = buttonLoading(btn);
      try {
        await api.post(`/organizations/current/members/${btn.dataset.suspend}/suspend`, {
          suspend: btn.dataset.active === 'true',
        });
        toastSuccess('Member status updated');
        reload();
      } catch (err) {
        toastError(err.message);
        restore();
      }
    }));

    panel.querySelectorAll('[data-remove]').forEach((btn) => btn.addEventListener('click', async () => {
      const confirmed = await confirmDialog({
        title: 'Remove this member?',
        message: 'They keep their account and savings history, but leave your organization.',
        confirmLabel: 'Remove',
        danger: true,
      });
      if (!confirmed) return;
      try {
        await api.del(`/organizations/current/members/${btn.dataset.remove}`);
        toastSuccess('Member removed');
        reload();
      } catch (err) {
        toastError(err.message);
      }
    }));
  } catch (err) {
    panel.innerHTML = errorState(err.message);
  }
}

function openInvite(onDone) {
  const dialog = modal({
    title: 'Invite a member',
    body: `
      <div class="field"><label for="email">Email address</label>
        <input class="input" id="email" type="email" placeholder="ama@company.com"></div>
      <div class="field"><label for="name">Name (optional)</label>
        <input class="input" id="name" placeholder="Ama Mensah"></div>
      <p class="tiny muted">They receive a link to join your organization. It expires in 14 days.</p>
      <div id="inv-error" class="error"></div>`,
    footer: '<button class="btn btn-secondary" data-close>Cancel</button><button class="btn" data-submit>Send invitation</button>',
  });

  dialog.root.querySelector('[data-submit]').addEventListener('click', async (e) => {
    const restore = buttonLoading(e.target);
    try {
      await api.post('/organizations/current/members/invite', {
        email: dialog.root.querySelector('#email').value,
        name: dialog.root.querySelector('#name').value,
      });
      toastSuccess('Invitation sent');
      dialog.close();
      onDone();
    } catch (err) {
      dialog.root.querySelector('#inv-error').textContent = err.message;
      restore();
    }
  });
}

/* ---------------------------------- groups ---------------------------------- */

async function groups(panel, { navigate }) {
  panel.innerHTML = `<div class="card">${skeletonLines(5)}</div>`;
  try {
    const { groups: rows } = await api.get('/organizations/current/groups');
    panel.innerHTML = `
      <div class="card">
        <div class="card-head"><h3>Groups (${rows.length})</h3></div>
        ${rows.length ? `
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Group</th><th>Organizer</th><th>Members</th><th>Contribution</th><th>Cycle</th><th>Collected</th><th>Status</th><th></th></tr></thead>
            <tbody>${rows.map((g) => `
              <tr>
                <td data-label="Group"><div class="strong">${escape(g.name)}</div>
                  <div class="tiny muted">${escape(g.inviteCode)}</div></td>
                <td data-label="Organizer">${escape(g.organizerId ? `${g.organizerId.firstName} ${g.organizerId.lastName}` : '—')}</td>
                <td data-label="Members">${g.stats?.activeMembers || 0}/${g.memberLimit}</td>
                <td data-label="Contribution">${money(g.contributionAmountMinor)}
                  <div class="tiny muted">${frequencyLabel(g.contributionFrequency)}</div></td>
                <td data-label="Cycle">${g.currentCycle} / ${g.totalCycles}</td>
                <td data-label="Collected">${money(g.stats?.totalCollectedMinor || 0)}</td>
                <td data-label="Status">${statusBadge(g.status)}</td>
                <td data-label=""><button class="btn btn-secondary btn-sm" data-nav="/groups/${g._id}">Open</button></td>
              </tr>`).join('')}</tbody>
          </table>
        </div>` : emptyState({
    icon: 'users',
    title: 'No groups yet',
    message: 'Groups created by your members will appear here.',
    action: '<button class="btn" data-nav="/groups/create">Create a group</button>',
  })}
      </div>`;
  } catch (err) {
    panel.innerHTML = errorState(err.message);
  }
}

/* ------------------------------- transactions ------------------------------- */

async function transactionsTab(panel) {
  panel.innerHTML = `
    <div class="card">
      <div class="card-head">
        <div class="row wrap">
          <select class="select" id="type" style="width:auto">
            <option value="">All types</option>
            ${['contribution', 'payout', 'deposit', 'withdrawal', 'refund']
    .map((t) => `<option value="${t}">${titleCase(t)}</option>`).join('')}
          </select>
        </div>
        <a class="btn btn-secondary btn-sm" href="/api/organizations/current/transactions?format=csv">
          ${icon('download', 'icon icon-sm')} Export CSV</a>
      </div>
      <div id="list">${skeletonLines(8)}</div>
      <div class="pagination hidden" id="pager">
        <span class="small muted" id="pager-info"></span>
        <div class="row">
          <button class="btn btn-secondary btn-sm" id="prev">Previous</button>
          <button class="btn btn-secondary btn-sm" id="next">Next</button>
        </div>
      </div>
    </div>`;

  let page = 1;
  const load = async () => {
    const list = panel.querySelector('#list');
    list.innerHTML = skeletonLines(8);
    try {
      const { transactions, meta } = await api.get('/organizations/current/transactions', {
        page, limit: 25, type: panel.querySelector('#type').value,
      });
      list.innerHTML = transactions.length ? `
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Transaction</th><th>Member</th><th>Group</th><th>Type</th><th>Amount</th><th>Fee</th><th>Status</th><th>Date</th></tr></thead>
          <tbody>${transactions.map((t) => `
            <tr>
              <td data-label="Transaction"><span class="small">${escape(t.transactionId)}</span></td>
              <td data-label="Member">${escape(t.userId ? `${t.userId.firstName} ${t.userId.lastName}` : '—')}</td>
              <td data-label="Group">${escape(t.groupId?.name || '—')}</td>
              <td data-label="Type">${titleCase(t.type)}</td>
              <td data-label="Amount" class="${t.direction === 'credit' ? 'money-in' : 'money-out'}">${money(t.grossAmountMinor)}</td>
              <td data-label="Fee">${money(t.feeMinor)}</td>
              <td data-label="Status">${statusBadge(t.status)}</td>
              <td data-label="Date">${dateTime(t.createdAt)}</td>
            </tr>`).join('')}</tbody>
        </table></div>`
        : emptyState({ icon: 'receipt', title: 'No transactions', message: 'Nothing matches this filter yet.' });

      const pager = panel.querySelector('#pager');
      pager.classList.toggle('hidden', meta.totalPages <= 1);
      panel.querySelector('#pager-info').textContent = `Page ${meta.page} of ${meta.totalPages} · ${meta.total} transactions`;
      panel.querySelector('#prev').disabled = meta.page <= 1;
      panel.querySelector('#next').disabled = meta.page >= meta.totalPages;
    } catch (err) {
      list.innerHTML = errorState(err.message);
    }
  };

  panel.querySelector('#type').addEventListener('change', () => { page = 1; load(); });
  panel.querySelector('#prev').addEventListener('click', () => { page -= 1; load(); });
  panel.querySelector('#next').addEventListener('click', () => { page += 1; load(); });
  load();
}

/* ---------------------------------- reports --------------------------------- */

async function reports(panel) {
  panel.innerHTML = `<div class="card card-body">${skeletonLines(6)}</div>`;
  try {
    const [{ groups: rows, inArrears }, { payouts }] = await Promise.all([
      api.get('/organizations/current/performance'),
      api.get('/organizations/current/payouts'),
    ]);

    panel.innerHTML = `
      <div class="card" style="margin-bottom:20px">
        <div class="card-head"><h3>Group compliance</h3>
          <span class="tiny muted">Contributions paid on time versus missed</span></div>
        ${rows.length ? `
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Group</th><th>Cycle</th><th>On time</th><th>Missed</th><th>Compliance</th><th>Collected</th></tr></thead>
          <tbody>${rows.map((g) => `
            <tr>
              <td data-label="Group">${escape(g.name)}</td>
              <td data-label="Cycle">${g.currentCycle} / ${g.totalCycles}</td>
              <td data-label="On time">${g.onTimeContributions}</td>
              <td data-label="Missed">${g.missedContributions}</td>
              <td data-label="Compliance">
                ${g.complianceRate === null ? '—' : `
                  <div class="row" style="gap:8px">
                    <div class="progress" style="width:80px">
                      <div class="progress-bar ${g.complianceRate < 70 ? 'orange' : 'green'}" style="width:${g.complianceRate}%"></div>
                    </div>
                    <span class="small strong">${g.complianceRate}%</span>
                  </div>`}
              </td>
              <td data-label="Collected">${money(g.stats?.totalCollectedMinor || 0)}</td>
            </tr>`).join('')}</tbody>
        </table></div>` : emptyState({ icon: 'pie-chart', title: 'No data yet', message: 'Compliance appears once groups start collecting.' })}
      </div>

      <div class="dash-grid">
        <div class="card">
          <div class="card-head"><h3>Members in arrears</h3>
            <span class="badge ${inArrears.length ? 'badge-warning' : 'badge-success'}">${inArrears.length}</span></div>
          ${inArrears.length ? `
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Member</th><th>Outstanding</th><th>Missed</th></tr></thead>
            <tbody>${inArrears.map((m) => `
              <tr>
                <td data-label="Member"><div class="strong">${escape(m.name)}</div>
                  <div class="tiny muted">${escape(m.email || '')}</div></td>
                <td data-label="Outstanding" style="color:var(--red-600)">${money(m.outstandingMinor)}</td>
                <td data-label="Missed">${m.missedContributions}</td>
              </tr>`).join('')}</tbody>
          </table></div>`
    : emptyState({ icon: 'check-circle', title: 'Everyone is up to date', message: 'No member is behind on contributions.' })}
        </div>

        <div class="card">
          <div class="card-head"><h3>Payout schedule</h3></div>
          ${payouts.length ? payouts.slice(0, 12).map((p) => `
            <div class="payout-item">
              <div class="info">
                <div class="name">${escape(p.recipientId ? `${p.recipientId.firstName} ${p.recipientId.lastName}` : '—')}</div>
                <div class="sub">${escape(p.groupId?.name || '')} · cycle ${p.cycle} · ${date(p.scheduledDate)}</div>
              </div>
              <div class="amount">
                <div class="value">${money(p.status === 'completed' ? p.netAmountMinor : p.expectedAmountMinor)}</div>
                <div class="tiny muted">${escape(titleCase(p.status))}</div>
              </div>
            </div>`).join('')
    : emptyState({ icon: 'gift', title: 'No payouts', message: 'The schedule appears once a group is activated.' })}
        </div>
      </div>`;
  } catch (err) {
    panel.innerHTML = errorState(err.message);
  }
}

/* --------------------------------- settings --------------------------------- */

async function settings(panel, { reload }) {
  panel.innerHTML = `<div class="card card-body">${skeletonLines(6)}</div>`;
  let organization;
  try {
    ({ organization } = await api.get('/organizations/current'));
  } catch (err) {
    panel.innerHTML = errorState(err.message);
    return;
  }

  panel.innerHTML = `
    <div class="dash-grid">
      <div class="card">
        <div class="card-head"><h3>Organization profile</h3></div>
        <div class="card-body">
          <form id="org-form">
            <div class="field"><label for="description">Description</label>
              <textarea class="textarea" id="description">${escape(organization.description || '')}</textarea></div>
            <div class="row wrap" style="gap:16px">
              <div class="field grow"><label for="contactEmail">Contact email</label>
                <input class="input" id="contactEmail" type="email" value="${escape(organization.contactEmail || '')}"></div>
              <div class="field grow"><label for="contactPhone">Contact phone</label>
                <input class="input" id="contactPhone" value="${escape(organization.contactPhone || '')}"></div>
            </div>
            <div class="field"><label for="address">Address</label>
              <input class="input" id="address" value="${escape(organization.address || '')}"></div>
            <div class="field"><label for="region">Region</label>
              <input class="input" id="region" value="${escape(organization.region || '')}"></div>
            <button class="btn" type="submit">Save profile</button>
          </form>
        </div>
      </div>

      <div class="dash-col">
        <div class="card">
          <div class="card-head"><h3>Rules</h3></div>
          <div class="card-body col">
            <label class="checkbox">
              <input type="checkbox" id="allowMemberGroupCreation" ${organization.settings?.allowMemberGroupCreation !== false ? 'checked' : ''}>
              <span>Members may create their own groups</span>
            </label>
            <label class="checkbox">
              <input type="checkbox" id="requireGroupApproval" ${organization.settings?.requireGroupApproval !== false ? 'checked' : ''}>
              <span>Joining a group needs organizer approval</span>
            </label>
            <button class="btn btn-secondary" id="save-rules">Save rules</button>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>Account</h3></div>
          <div class="card-body">
            <div class="review-list">
              <div class="review-row"><span class="k">Organization</span><span class="v">${escape(organization.name)}</span></div>
              <div class="review-row"><span class="k">Type</span><span class="v">${titleCase(organization.type)}</span></div>
              <div class="review-row"><span class="k">Plan</span><span class="v">${titleCase(organization.planCode || 'free')}</span></div>
              <div class="review-row"><span class="k">Status</span><span class="v">${statusBadge(organization.status)}</span></div>
              <div class="review-row"><span class="k">Created</span><span class="v">${date(organization.createdAt)}</span></div>
            </div>
            <p class="tiny muted" style="margin-top:12px">
              The organization name and plan are managed by the platform administrator.
            </p>
          </div>
        </div>
      </div>
    </div>`;

  panel.querySelector('#org-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const restore = buttonLoading(e.target.querySelector('button'));
    try {
      await api.patch('/organizations/current', {
        description: panel.querySelector('#description').value,
        contactEmail: panel.querySelector('#contactEmail').value,
        contactPhone: panel.querySelector('#contactPhone').value,
        address: panel.querySelector('#address').value,
        region: panel.querySelector('#region').value,
      });
      toastSuccess('Organization updated');
    } catch (err) {
      toastError(err.message);
    } finally {
      restore();
    }
  });

  panel.querySelector('#save-rules').addEventListener('click', async (e) => {
    const restore = buttonLoading(e.target);
    try {
      await api.patch('/organizations/current', {
        settings: {
          allowMemberGroupCreation: panel.querySelector('#allowMemberGroupCreation').checked,
          requireGroupApproval: panel.querySelector('#requireGroupApproval').checked,
        },
      });
      toastSuccess('Rules saved');
    } catch (err) {
      toastError(err.message);
    } finally {
      restore();
    }
  });
}
