/** Dashboard view — every figure comes from GET /api/dashboard. */

import { api } from '../core/api.js';
import { money, moneyShort, date, relative, dateTime, escape, frequencyLabel, percent } from '../core/format.js';
import { icon, skeletonCards, emptyState, errorState } from '../core/ui.js';

const TXN_TONE = {
  contribution: 'out', withdrawal: 'out', registration_fee: 'neutral', platform_fee: 'neutral',
  savings_fee: 'neutral', withdrawal_fee: 'neutral', group_creation_fee: 'neutral', subscription: 'neutral',
  payout: 'payout', deposit: 'in', refund: 'in', adjustment: 'neutral',
};

const TXN_ICON = {
  contribution: 'arrow-up-right', withdrawal: 'arrow-up-right', payout: 'gift',
  deposit: 'arrow-down-left', refund: 'arrow-down-left',
};

export async function renderDashboard(root, { navigate }) {
  root.innerHTML = `
    <div class="page-head">
      <div><h1>Dashboard</h1><p>Your savings at a glance.</p></div>
      <button class="btn" data-action="create-group">${icon('plus')} Create SUSU Group</button>
    </div>
    ${skeletonCards(4)}
    <div class="skeleton" style="height:280px;border-radius:20px"></div>`;

  let data;
  try {
    data = await api.get('/dashboard');
  } catch (err) {
    root.innerHTML = errorState(err.message);
    return;
  }

  const { summary, groups, upcomingPayouts, savingsPlans, rentPlan, recentTransactions } = data;

  root.innerHTML = `
    <div class="page-head">
      <div><h1>Dashboard</h1><p>Discipline today, financial freedom tomorrow.</p></div>
      <div class="row">
        <button class="btn btn-secondary" data-action="join-group">${icon('user-plus')} Join a group</button>
        <button class="btn" data-action="create-group">${icon('plus')} Create SUSU Group</button>
      </div>
    </div>

    <div class="stat-grid">
      ${statCard('purple', 'piggy-bank', 'Total Saved', money(summary.totalSavedMinor), 'All time')}
      ${statCard('green', 'banknote', 'Total Received', money(summary.totalReceivedMinor), 'All time')}
      ${statCard('orange', 'users', 'Active Groups', String(summary.activeGroups), summary.activeGroups === 1 ? 'You are a member' : 'You are a member')}
      ${statCard('blue', 'calendar-clock', 'Next Payout',
    summary.nextPayoutDate ? date(summary.nextPayoutDate) : 'None scheduled',
    summary.nextPayoutDate ? relative(summary.nextPayoutDate) : 'Join or create a group')}
    </div>

    <div class="dash-grid">
      <div class="dash-col">
        <section>
          <div class="section-head">
            <h3>My SUSU Groups</h3>
            <button class="btn btn-ghost btn-sm" data-nav="/groups">View all ${icon('chevron-right', 'icon icon-sm')}</button>
          </div>
          ${groups.length ? groups.map(groupCard).join('') : `<div class="card">${emptyState({
    icon: 'users',
    title: 'No SUSU groups yet',
    message: 'Start saving together by creating your first SUSU group, or join one with an invite code.',
    action: '<button class="btn" data-action="create-group">Create SUSU Group</button>',
  })}</div>`}
        </section>

        <section class="card">
          <div class="card-head">
            <h3>Recent Transactions</h3>
            <button class="btn btn-ghost btn-sm" data-nav="/transactions">View all</button>
          </div>
          ${recentTransactions.length
    ? recentTransactions.map(txnRow).join('')
    : emptyState({ icon: 'receipt', title: 'No transactions yet', message: 'Your contributions, payouts and withdrawals will appear here.' })}
        </section>
      </div>

      <div class="dash-col">
        <section class="card">
          <div class="card-head"><h3>Upcoming Payouts</h3></div>
          ${upcomingPayouts.length
    ? upcomingPayouts.map(payoutRow).join('')
    : emptyState({ icon: 'gift', title: 'No payouts scheduled', message: 'Once your group starts, your payout date will show here.' })}
          ${upcomingPayouts.length ? '<div style="padding:16px"><button class="btn btn-secondary btn-block" data-nav="/payouts">View full payout schedule</button></div>' : ''}
        </section>

        ${rentPlan ? rentCard(rentPlan) : ''}

        <section class="card">
          <div class="card-head">
            <h3>Savings Goals</h3>
            <button class="btn btn-ghost btn-sm" data-nav="/savings">Manage</button>
          </div>
          <div class="card-body col">
            ${savingsPlans.length
    ? savingsPlans.map(savingsRow).join('')
    : emptyState({ icon: 'target', title: 'Start your first savings goal', message: 'Save for rent, school fees, an emergency fund or anything else.', action: '<button class="btn btn-sm" data-nav="/savings">Create a goal</button>' })}
          </div>
        </section>

        <section class="card" id="calendar-card">
          <div class="card-head"><h3>Contribution Calendar</h3></div>
          <div class="card-body"><div class="skeleton" style="height:200px"></div></div>
        </section>
      </div>
    </div>

    ${trustBar()}`;

  root.querySelector('[data-action="create-group"]')?.addEventListener('click', () => navigate('/groups/create'));
  root.querySelector('[data-action="join-group"]')?.addEventListener('click', () => navigate('/join-group'));

  await renderCalendar(root.querySelector('#calendar-card'), groups[0]);
}

const statCard = (tone, iconName, label, value, meta) => `
  <div class="stat ${tone}">
    <div class="stat-icon">${icon(iconName)}</div>
    <div class="stat-label">${escape(label)}</div>
    <div class="stat-value">${escape(value)}</div>
    <div class="stat-meta">${escape(meta)}</div>
  </div>`;

function groupCard(group) {
  const initials = group.name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return `
  <div class="group-card card-hover" data-nav="/groups/${group.groupId}">
    <div class="group-card-head">
      <div class="group-icon">${escape(initials)}</div>
      <div class="grow">
        <div class="row" style="gap:8px">
          <span class="group-title">${escape(group.name)}</span>
          <span class="badge ${group.isOrganizer ? 'badge-purple' : ''}">${group.isOrganizer ? 'Organizer' : 'Member'}</span>
        </div>
        <div class="group-sub">${group.members} members · ${frequencyLabel(group.contributionFrequency)} contribution · ${money(group.contributionAmountMinor)}</div>
      </div>
    </div>

    <div class="row-between small" style="margin-bottom:6px">
      <span class="muted">${group.contributionFrequency === 'daily' ? 'Day' : 'Week'} ${group.currentCycle} of ${group.totalCycles}</span>
      <span class="strong">${group.progressPercent}%</span>
    </div>
    <div class="progress"><div class="progress-bar" style="width:${group.progressPercent}%"></div></div>

    <div class="group-metrics">
      <div class="metric"><div class="label">Total Pot</div><div class="value">${money(group.currentPoolMinor)}</div></div>
      <div class="metric"><div class="label">My Balance</div><div class="value">${money(group.myBalanceMinor)}</div></div>
      ${group.outstandingMinor > 0
    ? `<div class="metric"><div class="label">Outstanding</div><div class="value" style="color:var(--red-600)">${money(group.outstandingMinor)}</div></div>`
    : ''}
    </div>

    <div class="group-foot">
      <div class="small">
        ${group.nextPayout
    ? `<span class="muted">Next payout to</span> <span class="strong">${escape(group.nextPayout.recipient || '—')}</span>
           <span class="muted">· ${date(group.nextPayout.date)}</span>`
    : '<span class="muted">No payout scheduled</span>'}
      </div>
      <button class="btn btn-secondary btn-sm" data-nav="/groups/${group.groupId}">Open</button>
    </div>
  </div>`;
}

const payoutRow = (payout) => `
  <div class="payout-item">
    <div class="avatar">${icon('gift', 'icon icon-sm')}</div>
    <div class="info">
      <div class="name">${escape(payout.groupName)}</div>
      <div class="sub">${date(payout.date)} · ${relative(payout.date)}</div>
    </div>
    <div class="amount">
      <div class="value">${moneyShort(payout.expectedAmountMinor)}</div>
      <div class="tiny muted">Expected</div>
    </div>
  </div>`;

function txnRow(txn) {
  const tone = TXN_TONE[txn.type] || 'neutral';
  const sign = txn.direction === 'credit' ? '+' : '-';
  const cls = txn.type === 'payout' ? 'money-payout' : txn.direction === 'credit' ? 'money-in' : 'money-out';
  return `
    <div class="txn" data-nav="/transactions/${txn.transactionId}">
      <div class="txn-icon ${tone}">${icon(TXN_ICON[txn.type] || 'receipt', 'icon icon-sm')}</div>
      <div class="info">
        <div class="desc truncate">${escape(txn.description)}</div>
        <div class="time">${dateTime(txn.createdAt)}</div>
      </div>
      <div class="amount">
        <div class="${cls}">${sign}${money(txn.amountMinor)}</div>
        <div class="tiny muted">${escape(txn.status)}</div>
      </div>
    </div>`;
}

const savingsRow = (plan) => `
  <div data-nav="/savings/${plan.planId}" style="cursor:pointer">
    <div class="row-between small" style="margin-bottom:6px">
      <span class="strong">${escape(plan.name)}</span>
      <span class="muted">${money(plan.currentAmountMinor)}${plan.targetAmountMinor ? ` / ${money(plan.targetAmountMinor)}` : ''}</span>
    </div>
    <div class="progress"><div class="progress-bar green" style="width:${plan.percentComplete}%"></div></div>
  </div>`;

function rentCard(plan) {
  const pct = plan.targetAmountMinor
    ? Math.min(100, Math.round((plan.currentAmountMinor / plan.targetAmountMinor) * 1000) / 10)
    : 0;
  return `
    <section class="card">
      <div class="card-head"><h3>Rent Goal</h3><span class="badge badge-purple">${percent(pct)} complete</span></div>
      <div class="card-body">
        <div class="stat-value" style="font-size:1.5rem">${money(plan.currentAmountMinor)} <span class="muted" style="font-size:1rem;font-weight:600">/ ${money(plan.targetAmountMinor)}</span></div>
        <div class="progress" style="margin:12px 0"><div class="progress-bar orange" style="width:${pct}%"></div></div>
        <div class="row-between small muted">
          <span>Monthly target: ${money(plan.contributionAmountMinor)}</span>
          <span>${plan.targetDate ? `By ${date(plan.targetDate)}` : ''}</span>
        </div>
      </div>
    </section>`;
}

async function renderCalendar(card, group) {
  if (!card) return;
  if (!group) {
    card.querySelector('.card-body').innerHTML = emptyState({
      icon: 'calendar',
      title: 'No calendar yet',
      message: 'Join a SUSU group to see your contribution calendar.',
    });
    return;
  }

  const now = new Date();
  let days = [];
  try {
    const res = await api.get(`/groups/${group.groupId}/calendar`, {
      year: now.getFullYear(),
      month: now.getMonth() + 1,
    });
    days = res.days;
  } catch {
    days = [];
  }

  const byDay = new Map(days.map((d) => [new Date(d.date).getDate(), d]));
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  // Monday-first grid.
  const leading = (first.getDay() + 6) % 7;
  const total = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

  const cells = [];
  for (let i = 0; i < leading; i += 1) cells.push('<div class="cal-day empty"></div>');
  for (let day = 1; day <= total; day += 1) {
    const entry = byDay.get(day);
    const isToday = day === now.getDate();
    const status = entry ? ({ paid: 'paid', late: 'paid', pending: 'pending', partial: 'pending', missed: 'missed' }[entry.status] || '') : '';
    const mark = entry ? ({ paid: '✓', late: '✓', missed: '✕', pending: '•', partial: '•' }[entry.status] || '') : '';
    cells.push(`<div class="cal-day ${status} ${entry ? 'has-entry' : ''} ${isToday ? 'today' : ''}"
      ${entry ? `title="${money(entry.expectedAmountMinor)} — ${escape(entry.status)}"` : ''}>
      <span>${day}</span>${mark ? `<span class="marker">${mark}</span>` : ''}
    </div>`);
  }

  card.querySelector('.card-head').innerHTML = `
    <div><h3>Contribution Calendar</h3><div class="tiny muted">${escape(group.name)}</div></div>
    <span class="badge">${now.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</span>`;

  card.querySelector('.card-body').innerHTML = `
    <div class="cal-grid">
      ${['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d) => `<div class="cal-dow">${d}</div>`).join('')}
      ${cells.join('')}
    </div>
    <div class="cal-legend">
      <span><i style="background:var(--green-500)"></i> Paid</span>
      <span><i style="background:var(--orange-500)"></i> Pending</span>
      <span><i style="background:var(--red-500)"></i> Missed</span>
    </div>`;
}

const trustBar = () => `
  <div class="trust-bar">
    ${[
    ['shield', '100% Secure', 'Your money is safe with us'],
    ['bell', 'Automatic Reminders', 'Never miss a payment'],
    ['zap', 'Instant Payouts', 'Receive your money on time'],
    ['users', 'Trusted Community', 'Built on the Susu tradition'],
    ['help-circle', 'Need Help?', 'Contact support any time'],
  ].map(([ico, t, s]) => `
      <div class="trust-item">
        <div class="ico">${icon(ico, 'icon icon-sm')}</div>
        <div><div class="t">${t}</div><div class="s">${s}</div></div>
      </div>`).join('')}
  </div>`;

export { statCard, txnRow };
