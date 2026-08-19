/** Group list, group detail, the creation wizard and the join flow. */

import { api } from '../core/api.js';
import { money, toMinor, date, relative, escape, frequencyLabel, statusBadge, titleCase } from '../core/format.js';
import {
  icon, emptyState, errorState, skeletonLines, toastSuccess, toastError,
  modal, confirmDialog, buttonLoading, avatar, copyToClipboard,
} from '../core/ui.js';
import { state } from '../core/store.js';

/* ------------------------------- group list ------------------------------- */

export async function renderGroups(root, { navigate }) {
  root.innerHTML = `
    <div class="page-head">
      <div><h1>My SUSU Groups</h1><p>Every group you organize or belong to.</p></div>
      <div class="row">
        <button class="btn btn-secondary" data-nav="/join-group">${icon('user-plus')} Join with code</button>
        <button class="btn" data-nav="/groups/create">${icon('plus')} Create group</button>
      </div>
    </div>
    <div class="card card-body">${skeletonLines(5)}</div>`;

  let groups;
  try {
    ({ groups } = await api.get('/groups'));
  } catch (err) {
    root.querySelector('.card').outerHTML = errorState(err.message);
    return;
  }

  const list = root.querySelector('.card');
  if (!groups.length) {
    list.outerHTML = `<div class="card">${emptyState({
      icon: 'users',
      title: 'No SUSU groups yet',
      message: 'Start saving together by creating your first SUSU group.',
      action: '<button class="btn" data-nav="/groups/create">Create SUSU Group</button>',
    })}</div>`;
    return;
  }

  list.outerHTML = groups.map((group) => {
    const initials = group.name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
    const progress = group.totalCycles ? Math.round(((group.currentCycle - 1) / group.totalCycles) * 100) : 0;
    return `
      <div class="group-card card-hover" data-nav="/groups/${group._id}">
        <div class="group-card-head">
          <div class="group-icon">${escape(initials)}</div>
          <div class="grow">
            <div class="row wrap" style="gap:8px">
              <span class="group-title">${escape(group.name)}</span>
              <span class="badge ${group.membership.role === 'organizer' ? 'badge-purple' : ''}">${titleCase(group.membership.role)}</span>
              ${statusBadge(group.membership.status === 'pending' ? 'pending' : group.status)}
            </div>
            <div class="group-sub">${group.stats?.activeMembers || 0} of ${group.memberLimit} members ·
              ${frequencyLabel(group.contributionFrequency)} ${money(group.contributionAmountMinor)}</div>
          </div>
        </div>
        <div class="row-between small" style="margin-bottom:6px">
          <span class="muted">Cycle ${group.currentCycle} of ${group.totalCycles}</span>
          <span class="strong">${progress}%</span>
        </div>
        <div class="progress"><div class="progress-bar" style="width:${progress}%"></div></div>
        <div class="group-metrics">
          <div class="metric"><div class="label">My contributions</div><div class="value">${money(group.membership.totalContributedMinor)}</div></div>
          <div class="metric"><div class="label">Received</div><div class="value">${money(group.membership.totalReceivedMinor)}</div></div>
          <div class="metric"><div class="label">Payout position</div><div class="value">${group.membership.payoutPosition ?? '—'}</div></div>
        </div>
      </div>`;
  }).join('');
}

/* ------------------------------ group detail ------------------------------ */

export async function renderGroupDetail(root, { params, navigate }) {
  root.innerHTML = `<div class="card card-body">${skeletonLines(6)}</div>`;

  let data;
  try {
    data = await api.get(`/groups/${params.id}`);
  } catch (err) {
    root.innerHTML = errorState(err.message);
    return;
  }

  const { group, members, payouts, totals } = data;
  const isOrganizer = String(group.organizerId) === String(state.user?.id || state.user?._id);
  const myMembership = members.find((m) => String(m.userId?._id || m.userId) === String(state.user?.id || state.user?._id));

  root.innerHTML = `
    <div class="page-head">
      <div>
        <button class="btn btn-ghost btn-sm" data-nav="/groups">${icon('chevron-left', 'icon icon-sm')} All groups</button>
        <h1 style="margin-top:8px">${escape(group.name)}</h1>
        <p>${escape(group.description || 'No description')}</p>
        <div class="row wrap" style="margin-top:8px">
          ${statusBadge(group.status)}
          <span class="badge">${group.stats?.activeMembers || 0}/${group.memberLimit} members</span>
          <span class="badge">${frequencyLabel(group.contributionFrequency)} ${money(group.contributionAmountMinor)}</span>
        </div>
      </div>
      <div class="row wrap">
        ${group.status === 'recruiting' && isOrganizer ? '<button class="btn btn-success" data-action="activate">Start group</button>' : ''}
        ${group.status === 'active' ? '<button class="btn" data-action="contribute">Make contribution</button>' : ''}
      </div>
    </div>

    <div class="stat-grid">
      <div class="stat purple"><div class="stat-icon">${icon('wallet')}</div><div class="stat-label">Current pool</div>
        <div class="stat-value">${money(totals.currentPoolMinor)}</div><div class="stat-meta">Cycle ${group.currentCycle} of ${group.totalCycles}</div></div>
      <div class="stat green"><div class="stat-icon">${icon('trending-up')}</div><div class="stat-label">Total collected</div>
        <div class="stat-value">${money(totals.collectedMinor)}</div><div class="stat-meta">All cycles</div></div>
      <div class="stat orange"><div class="stat-icon">${icon('gift')}</div><div class="stat-label">Paid out</div>
        <div class="stat-value">${money(totals.paidOutMinor)}</div><div class="stat-meta">${group.stats?.completedPayouts || 0} payouts</div></div>
      <div class="stat blue"><div class="stat-icon">${icon('user')}</div><div class="stat-label">My contributions</div>
        <div class="stat-value">${money(myMembership?.totalContributedMinor || 0)}</div>
        <div class="stat-meta">Position ${myMembership?.payoutPosition ?? '—'}</div></div>
    </div>

    <div class="card" style="margin-bottom:24px">
      <div class="card-body">
        <div class="code-box">
          <div>
            <div class="tiny muted strong">INVITE CODE</div>
            <div class="code">${escape(group.inviteCode)}</div>
          </div>
          <div class="row">
            <button class="btn btn-secondary btn-sm" data-action="copy-code">${icon('copy', 'icon icon-sm')} Copy code</button>
            <button class="btn btn-secondary btn-sm" data-action="copy-link">Copy invite link</button>
          </div>
        </div>
      </div>
    </div>

    <div class="tabs" style="margin-bottom:20px">
      <button class="tab active" data-tab="members">Members</button>
      <button class="tab" data-tab="contributions">Contributions</button>
      <button class="tab" data-tab="payouts">Payout schedule</button>
      ${isOrganizer ? '<button class="tab" data-tab="payments">Payments</button>' : ''}
      ${isOrganizer ? '<button class="tab" data-tab="qr">QR codes</button>' : ''}
    </div>
    <div id="tab-panel"></div>`;

  const panel = root.querySelector('#tab-panel');
  const tabs = {
    members: () => membersTab(panel, { group, members, isOrganizer, reload: () => renderGroupDetail(root, { params, navigate }) }),
    contributions: () => contributionsTab(panel, group),
    payouts: () => payoutsTab(panel, { group, payouts, isOrganizer, reload: () => renderGroupDetail(root, { params, navigate }) }),
    payments: () => paymentsTab(panel, group),
    qr: () => qrTab(panel, group),
  };
  tabs.members();

  root.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
    root.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    tabs[tab.dataset.tab]();
  }));

  root.querySelector('[data-action="copy-code"]')?.addEventListener('click', () => copyToClipboard(group.inviteCode));
  root.querySelector('[data-action="copy-link"]')?.addEventListener('click', () =>
    copyToClipboard(`${window.location.origin}/join-group?code=${group.inviteCode}`));

  root.querySelector('[data-action="contribute"]')?.addEventListener('click', () =>
    openContributeModal(group, () => renderGroupDetail(root, { params, navigate })));

  root.querySelector('[data-action="activate"]')?.addEventListener('click', async (e) => {
    const confirmed = await confirmDialog({
      title: 'Start this group?',
      message: 'The contribution schedule and payout order will be locked in and the first cycle begins.',
      confirmLabel: 'Start group',
    });
    if (!confirmed) return;
    const restore = buttonLoading(e.target.closest('button'));
    try {
      await api.post(`/groups/${group._id}/activate`);
      toastSuccess('Group activated — the schedule is live');
      renderGroupDetail(root, { params, navigate });
    } catch (err) {
      toastError(err.message);
      restore();
    }
  });
}

function membersTab(panel, { group, members, isOrganizer, reload }) {
  const pending = members.filter((m) => m.status === 'pending');
  const active = members.filter((m) => m.status === 'active');

  panel.innerHTML = `
    ${pending.length && isOrganizer ? `
      <div class="card" style="margin-bottom:20px">
        <div class="card-head"><h3>Pending requests (${pending.length})</h3></div>
        ${pending.map((m) => `
          <div class="payout-item">
            ${avatar(m.userId?.firstName, m.userId?.lastName, m.userId?.avatarUrl)}
            <div class="info">
              <div class="name">${escape(`${m.userId?.firstName || ''} ${m.userId?.lastName || ''}`)}</div>
              <div class="sub">${escape(m.userId?.email || '')} · asked ${relative(m.joinedAt)}</div>
            </div>
            <div class="row">
              <button class="btn btn-success btn-sm" data-approve="${m._id}">Approve</button>
              <button class="btn btn-secondary btn-sm" data-reject="${m._id}">Reject</button>
            </div>
          </div>`).join('')}
      </div>` : ''}

    <div class="card">
      <div class="card-head">
        <h3>Members (${active.length})</h3>
        ${isOrganizer && group.status === 'recruiting'
    ? '<span class="tiny muted">Payout order is locked once the group starts</span>' : ''}
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>#</th><th>Member</th><th>Role</th><th>Contributed</th><th>Received</th><th>Outstanding</th><th>Status</th>${isOrganizer ? '<th></th>' : ''}</tr></thead>
          <tbody>
            ${active.map((m) => `
              <tr>
                <td data-label="Position"><span class="badge badge-purple">${m.payoutPosition ?? '—'}</span></td>
                <td data-label="Member">
                  <div class="row">
                    ${avatar(m.userId?.firstName, m.userId?.lastName, m.userId?.avatarUrl, 'avatar-sm')}
                    <div><div class="strong">${escape(`${m.userId?.firstName || ''} ${m.userId?.lastName || ''}`)}</div>
                    <div class="tiny muted">${escape(m.userId?.email || '')}</div></div>
                  </div>
                </td>
                <td data-label="Role">${titleCase(m.role)}</td>
                <td data-label="Contributed">${money(m.totalContributedMinor)}</td>
                <td data-label="Received">${money(m.totalReceivedMinor)}</td>
                <td data-label="Outstanding">${m.outstandingMinor ? `<span style="color:var(--red-600)">${money(m.outstandingMinor)}</span>` : '—'}</td>
                <td data-label="Status">${m.hasReceivedPayout ? '<span class="badge badge-success">Paid out</span>' : statusBadge(m.status)}</td>
                ${isOrganizer ? `<td data-label=""><button class="btn btn-ghost btn-sm" data-remove="${m._id}">Remove</button></td>` : ''}
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;

  panel.querySelectorAll('[data-approve], [data-reject]').forEach((btn) => btn.addEventListener('click', async () => {
    const approve = btn.hasAttribute('data-approve');
    const memberId = btn.dataset.approve || btn.dataset.reject;
    const restore = buttonLoading(btn);
    try {
      await api.post(`/groups/${group._id}/members/${memberId}/review`, { action: approve ? 'approve' : 'reject' });
      toastSuccess(approve ? 'Member approved' : 'Request rejected');
      reload();
    } catch (err) {
      toastError(err.message);
      restore();
    }
  }));

  panel.querySelectorAll('[data-remove]').forEach((btn) => btn.addEventListener('click', async () => {
    const confirmed = await confirmDialog({
      title: 'Remove this member?',
      message: 'They will lose their place in the payout rotation.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api.del(`/groups/${group._id}/members/${btn.dataset.remove}`);
      toastSuccess('Member removed');
      reload();
    } catch (err) {
      toastError(err.message);
    }
  }));
}

async function contributionsTab(panel, group) {
  panel.innerHTML = `<div class="card card-body">${skeletonLines(4)}</div>`;
  try {
    const { contributions } = await api.get(`/groups/${group._id}/contributions`, { scope: 'all', limit: 100 });
    panel.innerHTML = `
      <div class="card">
        <div class="card-head"><h3>Contribution history</h3></div>
        ${contributions.length ? `
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Cycle</th><th>Member</th><th>Due</th><th>Expected</th><th>Paid</th><th>Status</th></tr></thead>
            <tbody>${contributions.map((c) => `
              <tr>
                <td data-label="Cycle">${c.cycle}</td>
                <td data-label="Member">${escape(`${c.userId?.firstName || ''} ${c.userId?.lastName || ''}`)}</td>
                <td data-label="Due">${date(c.dueDate)}</td>
                <td data-label="Expected">${money(c.expectedAmountMinor)}</td>
                <td data-label="Paid">${money(c.paidAmountMinor)}</td>
                <td data-label="Status">${statusBadge(c.status)}</td>
              </tr>`).join('')}</tbody>
          </table>
        </div>` : emptyState({ icon: 'receipt', title: 'No contributions yet', message: 'Contribution rows appear once the group starts.' })}
      </div>`;
  } catch (err) {
    panel.innerHTML = errorState(err.message);
  }
}

function payoutsTab(panel, { group, payouts, isOrganizer, reload }) {
  panel.innerHTML = `
    <div class="card">
      <div class="card-head"><h3>Payout schedule</h3></div>
      ${payouts.length ? `
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Cycle</th><th>Recipient</th><th>Scheduled</th><th>Expected</th><th>Paid</th><th>Status</th>${isOrganizer ? '<th></th>' : ''}</tr></thead>
          <tbody>${payouts.map((p) => `
            <tr>
              <td data-label="Cycle">${p.cycle}</td>
              <td data-label="Recipient">
                <div class="row">${avatar(p.recipientId?.firstName, p.recipientId?.lastName, p.recipientId?.avatarUrl, 'avatar-sm')}
                <span>${escape(`${p.recipientId?.firstName || ''} ${p.recipientId?.lastName || ''}`)}</span></div>
              </td>
              <td data-label="Scheduled">${date(p.scheduledDate)}<div class="tiny muted">${relative(p.scheduledDate)}</div></td>
              <td data-label="Expected">${money(p.expectedAmountMinor)}</td>
              <td data-label="Paid">${p.status === 'completed' ? money(p.netAmountMinor) : '—'}</td>
              <td data-label="Status">${statusBadge(p.status)}${p.holdReason ? `<div class="tiny muted">${escape(p.holdReason)}</div>` : ''}</td>
              ${isOrganizer ? `<td data-label="">${p.status !== 'completed'
    ? `<button class="btn btn-sm" data-run="${p._id}">Run payout</button>` : ''}</td>` : ''}
            </tr>`).join('')}</tbody>
        </table>
      </div>` : emptyState({ icon: 'gift', title: 'No payouts scheduled', message: 'The payout schedule is generated when the group starts.' })}
    </div>`;

  panel.querySelectorAll('[data-run]').forEach((btn) => btn.addEventListener('click', async () => {
    const restore = buttonLoading(btn);
    try {
      const result = await api.post(`/groups/${group._id}/payouts/${btn.dataset.run}/run`);
      if (result.processed) toastSuccess('Payout completed');
      else toastError(result.verdict?.reason || result.error || 'Payout is not eligible yet', 'Payout held');
      reload();
    } catch (err) {
      toastError(err.message);
      restore();
    }
  }));
}

function openContributeModal(group, onDone) {
  const dialog = modal({
    title: `Contribute to ${group.name}`,
    body: `
      <p class="muted small" style="margin-bottom:16px">
        Contributions are paid from your SUSU SAVE wallet. Top up your wallet first if your balance is low.
      </p>
      <div class="field">
        <label for="amount">Amount</label>
        <div class="input-group">
          <span class="prefix">GH₵</span>
          <input class="input" id="amount" type="number" step="0.01" min="0.01"
                 value="${(group.contributionAmountMinor / 100).toFixed(2)}">
        </div>
        <span class="hint">Standard contribution: ${money(group.contributionAmountMinor)}</span>
      </div>
      <div id="contribute-error" class="error"></div>`,
    footer: `
      <button class="btn btn-secondary" data-close>Cancel</button>
      <button class="btn" data-submit>Confirm contribution</button>`,
  });

  dialog.root.querySelector('[data-submit]').addEventListener('click', async (e) => {
    const amount = dialog.root.querySelector('#amount').value;
    const restore = buttonLoading(e.target);
    try {
      await api.post(`/groups/${group._id}/contributions`, { amount: Number(amount) }, {
        // A deterministic key so a double-click cannot pay twice.
        headers: { 'Idempotency-Key': `contrib-${group._id}-${toMinor(amount)}-${Date.now()}` },
      });
      toastSuccess('Contribution successful');
      dialog.close();
      onDone();
    } catch (err) {
      dialog.root.querySelector('#contribute-error').textContent = err.message;
      restore();
    }
  });
}

/* ------------------------------ create wizard ----------------------------- */

const STEPS = ['Name', 'Description', 'Frequency', 'Amount', 'Members', 'Start date', 'Payout order', 'Review'];

export function renderCreateGroup(root, { navigate }) {
  const draft = {
    name: '', description: '', contributionFrequency: 'weekly',
    contributionAmount: '', memberLimit: '', startDate: new Date().toISOString().slice(0, 10),
    payoutOrderMode: 'automatic',
  };
  let step = 0;

  root.innerHTML = `
    <div class="page-head">
      <div>
        <button class="btn btn-ghost btn-sm" data-nav="/groups">${icon('chevron-left', 'icon icon-sm')} Back to groups</button>
        <h1 style="margin-top:8px">Create a SUSU Group</h1>
        <p>Set the rules once — SUSU SAVE handles the schedule, reminders and payouts.</p>
      </div>
    </div>
    <div class="card card-body">
      <div class="wizard">
        <div class="wizard-steps" id="steps"></div>
        <div>
          <div class="wizard-panel" id="panel"></div>
          <div class="wizard-foot">
            <button class="btn btn-secondary" id="back">Back</button>
            <button class="btn" id="next">Continue</button>
          </div>
        </div>
      </div>
    </div>`;

  const stepsEl = root.querySelector('#steps');
  const panel = root.querySelector('#panel');
  const backBtn = root.querySelector('#back');
  const nextBtn = root.querySelector('#next');

  const paint = async () => {
    stepsEl.innerHTML = STEPS.map((label, i) => `
      <div class="wizard-step ${i === step ? 'active' : ''} ${i < step ? 'done' : ''}">
        <span class="num">${i < step ? '✓' : i + 1}</span><span>${label}</span>
      </div>`).join('');
    backBtn.disabled = step === 0;
    nextBtn.textContent = step === STEPS.length - 1 ? 'Create group' : 'Continue';
    panel.innerHTML = await stepMarkup(step, draft);
    bindStep();
  };

  const bindStep = () => {
    panel.querySelectorAll('[data-field]').forEach((input) => {
      input.addEventListener('input', () => { draft[input.dataset.field] = input.value; });
    });
    panel.querySelectorAll('.radio-card').forEach((card) => card.addEventListener('click', () => {
      panel.querySelectorAll('.radio-card').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
      const input = card.querySelector('input');
      input.checked = true;
      draft[input.name] = input.value;
    }));
  };

  const validateStep = () => {
    const problems = {
      0: !draft.name || draft.name.trim().length < 3 ? 'Give your group a name of at least 3 characters' : null,
      2: !draft.contributionFrequency ? 'Choose a contribution frequency' : null,
      3: !(Number(draft.contributionAmount) > 0) ? 'Enter a contribution amount' : null,
      4: !(Number(draft.memberLimit) >= 2) ? 'A SUSU group needs at least 2 members' : null,
      5: !draft.startDate ? 'Choose a start date' : null,
    }[step];
    return problems;
  };

  nextBtn.addEventListener('click', async () => {
    const problem = validateStep();
    if (problem) { toastError(problem, 'Check this step'); return; }

    if (step < STEPS.length - 1) { step += 1; paint(); return; }

    const restore = buttonLoading(nextBtn, 'Creating…');
    try {
      const { group } = await api.post('/groups', {
        name: draft.name,
        description: draft.description,
        contributionAmount: Number(draft.contributionAmount),
        contributionFrequency: draft.contributionFrequency,
        memberLimit: Number(draft.memberLimit),
        startDate: draft.startDate,
        payoutOrderMode: draft.payoutOrderMode,
      });
      toastSuccess('SUSU group created');
      navigate(`/groups/${group._id}`);
    } catch (err) {
      toastError(err.message);
      restore();
    }
  });

  backBtn.addEventListener('click', () => { if (step > 0) { step -= 1; paint(); } });
  paint();
}

async function stepMarkup(step, draft) {
  switch (step) {
    case 0:
      return `
        <h3>What is your group called?</h3>
        <p class="muted small" style="margin-bottom:20px">Pick a name your members will recognise.</p>
        <div class="field">
          <label for="g-name">Group name</label>
          <input class="input" id="g-name" data-field="name" value="${escape(draft.name)}" placeholder="e.g. Adom Susu Group" maxlength="80">
        </div>`;
    case 1:
      return `
        <h3>Describe the group</h3>
        <p class="muted small" style="margin-bottom:20px">Optional, but it helps members understand the purpose.</p>
        <div class="field">
          <label for="g-desc">Description</label>
          <textarea class="textarea" id="g-desc" data-field="description" maxlength="500"
            placeholder="What are you all saving towards?">${escape(draft.description)}</textarea>
        </div>`;
    case 2:
      return `
        <h3>How often will members contribute?</h3>
        <p class="muted small" style="margin-bottom:20px">Weekly is the most common rhythm for SUSU groups.</p>
        <div class="radio-cards">
          ${[['weekly', 'Weekly', 'One contribution and one payout per week.'],
    ['daily', 'Daily', 'A faster rotation — often used by market traders.']]
    .map(([value, label, help]) => `
            <label class="radio-card ${draft.contributionFrequency === value ? 'selected' : ''}">
              <input type="radio" name="contributionFrequency" value="${value}" ${draft.contributionFrequency === value ? 'checked' : ''}>
              <div><div class="strong">${label}</div><div class="small muted">${help}</div></div>
            </label>`).join('')}
        </div>`;
    case 3:
      return `
        <h3>How much per contribution?</h3>
        <p class="muted small" style="margin-bottom:20px">Each member pays this amount every cycle.</p>
        <div class="field">
          <label for="g-amount">Contribution amount</label>
          <div class="input-group">
            <span class="prefix">GH₵</span>
            <input class="input" id="g-amount" type="number" step="0.01" min="1" data-field="contributionAmount"
                   value="${escape(draft.contributionAmount)}" placeholder="20.00">
          </div>
        </div>`;
    case 4:
      return `
        <h3>How many members?</h3>
        <p class="muted small" style="margin-bottom:20px">The group runs one cycle per member — everyone gets exactly one payout.</p>
        <div class="field">
          <label for="g-members">Number of members</label>
          <input class="input" id="g-members" type="number" min="2" max="200" data-field="memberLimit"
                 value="${escape(draft.memberLimit)}" placeholder="10">
        </div>`;
    case 5:
      return `
        <h3>When does saving start?</h3>
        <p class="muted small" style="margin-bottom:20px">The first contribution is due on this date.</p>
        <div class="field">
          <label for="g-start">Start date</label>
          <input class="input" id="g-start" type="date" data-field="startDate" value="${escape(draft.startDate)}">
        </div>`;
    case 6:
      return `
        <h3>Who gets paid first?</h3>
        <p class="muted small" style="margin-bottom:20px">You can rearrange the order any time before the group starts.</p>
        <div class="radio-cards">
          ${[['automatic', 'Automatic order', 'Members are paid in the order they join.'],
    ['manual', 'I will set the order', 'Arrange the rotation yourself before starting.']]
    .map(([value, label, help]) => `
            <label class="radio-card ${draft.payoutOrderMode === value ? 'selected' : ''}">
              <input type="radio" name="payoutOrderMode" value="${value}" ${draft.payoutOrderMode === value ? 'checked' : ''}>
              <div><div class="strong">${label}</div><div class="small muted">${help}</div></div>
            </label>`).join('')}
        </div>`;
    default: {
      // The review figures are priced by the server, not computed in the browser.
      let preview = null;
      try {
        preview = await api.post('/groups/preview', {
          name: draft.name || 'Preview',
          contributionAmount: Number(draft.contributionAmount),
          contributionFrequency: draft.contributionFrequency,
          memberLimit: Number(draft.memberLimit),
          startDate: draft.startDate,
        });
      } catch { /* fall back to a plain summary */ }

      const rows = [
        ['Group name', escape(draft.name)],
        ['Members', escape(draft.memberLimit)],
        ['Contribution', `${money(toMinor(draft.contributionAmount || 0))} ${frequencyLabel(draft.contributionFrequency).toLowerCase()}`],
        ['Duration', preview?.durationLabel || `${draft.memberLimit} cycles`],
        ['Start date', date(draft.startDate)],
        ['Expected pool per cycle', money(preview?.expectedPoolPerCycleMinor ?? 0)],
        ['Total expected over the group', money(preview?.totalExpectedMinor ?? 0)],
        ['Platform fee per contribution', preview
          ? `${money(preview.perContributionFee.feeMinor)} (${preview.perContributionFee.breakdown.savingsFeePercent}%)`
          : '—'],
        ['Group creation fee', money(preview?.creationFeeMinor ?? 0)],
        ['Payout order', titleCase(draft.payoutOrderMode)],
      ];

      return `
        <h3>Review and create</h3>
        <p class="muted small" style="margin-bottom:20px">Check the numbers before you create the group.</p>
        <div class="review-list">
          ${rows.map(([k, v]) => `<div class="review-row"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('')}
        </div>
        ${preview ? `
          <div class="card" style="margin-top:20px;background:var(--purple-50);border-color:var(--purple-100)">
            <div class="card-body">
              <div class="strong small">First payout dates</div>
              <div class="small muted">${preview.schedule.slice(0, 4)
    .map((c) => `Cycle ${c.cycle}: ${date(c.payoutDate)}`).join(' · ')}</div>
            </div>
          </div>` : ''}`;
    }
  }
}

/* -------------------------------- join group ------------------------------- */

export function renderJoinGroup(root, { navigate, query }) {
  root.innerHTML = `
    <div class="page-head"><div><h1>Join a SUSU Group</h1><p>Enter the invite code your organizer shared with you.</p></div></div>
    <div class="card" style="max-width:560px">
      <div class="card-body">
        <div class="field">
          <label for="code">Invite code</label>
          <input class="input" id="code" placeholder="SUSU-ADOM-82K4" value="${escape(query?.code || '')}"
                 style="text-transform:uppercase;letter-spacing:0.05em;font-weight:700">
          <span class="hint">Codes look like SUSU-XXXX-XXXX</span>
        </div>
        <div id="preview"></div>
        <button class="btn btn-block" id="join">Find group</button>
      </div>
    </div>`;

  const input = root.querySelector('#code');
  const preview = root.querySelector('#preview');
  const button = root.querySelector('#join');
  let found = null;

  const lookup = async () => {
    const code = input.value.trim().toUpperCase();
    if (!code) return;
    const restore = buttonLoading(button, 'Searching…');
    try {
      const { group } = await api.get(`/groups/lookup/${encodeURIComponent(code)}`);
      found = group;
      preview.innerHTML = `
        <div class="card" style="margin-bottom:16px;background:var(--purple-50);border-color:var(--purple-100)">
          <div class="card-body">
            <h4>${escape(group.name)}</h4>
            <p class="small muted">${escape(group.description || 'No description')}</p>
            <div class="row wrap" style="margin-top:10px">
              <span class="badge">${frequencyLabel(group.contributionFrequency)} ${money(group.contributionAmountMinor)}</span>
              <span class="badge">${group.stats?.activeMembers || 0}/${group.memberLimit} members</span>
              ${statusBadge(group.status)}
            </div>
            ${group.requiresApproval ? '<p class="tiny muted" style="margin-top:10px">The organizer reviews join requests for this group.</p>' : ''}
          </div>
        </div>`;
      restore();
      button.textContent = 'Request to join';
    } catch (err) {
      found = null;
      preview.innerHTML = `<p class="error" style="margin-bottom:12px">${escape(err.message)}</p>`;
      restore();
    }
  };

  button.addEventListener('click', async () => {
    if (!found) { await lookup(); return; }
    const restore = buttonLoading(button, 'Joining…');
    try {
      const result = await api.post('/groups/join', { inviteCode: input.value.trim().toUpperCase() });
      toastSuccess(result.membership.status === 'active' ? 'You have joined the group' : 'Request sent to the organizer');
      navigate(`/groups/${result.group.id}`);
    } catch (err) {
      toastError(err.message);
      restore();
    }
  });

  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') button.click(); });
  if (query?.code) lookup();
}

/* ------------------------------- payments view ------------------------------ */

/**
 * Who has paid this cycle, who has not, and the references behind each payment.
 *
 * Read straight from the contribution rows the ledger already maintains — a
 * member reads PAID here only once a verified payment has settled, because that
 * is the same field the payment pipeline sets.
 */
async function paymentsTab(panel, group, cycle) {
  panel.innerHTML = `<div class="card card-body">${skeletonLines(6)}</div>`;
  let data;
  try {
    data = await api.get(`/groups/${group._id}/payments`, cycle ? { cycle } : undefined);
  } catch (err) {
    panel.innerHTML = errorState(err.message);
    return;
  }

  const { summary, rows } = data;
  const progress = summary.expectedThisCycleMinor
    ? Math.round((summary.collectedThisCycleMinor / summary.expectedThisCycleMinor) * 100)
    : 0;

  const cycleOptions = Array.from({ length: summary.totalCycles || 1 }, (_, i) => i + 1)
    .map((c) => `<option value="${c}" ${c === summary.cycle ? 'selected' : ''}>Cycle ${c}</option>`).join('');

  panel.innerHTML = `
    <div class="stat-grid">
      <div class="stat green"><div class="stat-icon">${icon('check-circle')}</div><div class="stat-label">Paid</div>
        <div class="stat-value">${summary.paid}</div><div class="stat-meta">of ${summary.members} members</div></div>
      <div class="stat orange"><div class="stat-icon">${icon('clock')}</div><div class="stat-label">Not yet paid</div>
        <div class="stat-value">${summary.unpaid + summary.partial}</div>
        <div class="stat-meta">${summary.partial} part-paid · ${summary.missed} missed</div></div>
      <div class="stat blue"><div class="stat-icon">${icon('receipt')}</div><div class="stat-label">Pending payments</div>
        <div class="stat-value">${summary.pendingPayments}</div><div class="stat-meta">Started, not yet confirmed</div></div>
      <div class="stat purple"><div class="stat-icon">${icon('wallet')}</div><div class="stat-label">Collected this cycle</div>
        <div class="stat-value">${money(summary.collectedThisCycleMinor)}</div>
        <div class="stat-meta">of ${money(summary.expectedThisCycleMinor)}</div></div>
    </div>

    <div class="card" style="margin-bottom:20px">
      <div class="card-body">
        <div class="row-between small" style="margin-bottom:6px">
          <span class="strong">Cycle ${summary.cycle} progress</span>
          <span class="muted">${progress}%</span>
        </div>
        <div class="progress"><div class="progress-bar ${progress >= 100 ? '' : 'orange'}" style="width:${Math.min(100, progress)}%"></div></div>
        <p class="tiny muted" style="margin:8px 0 0">
          ${money(summary.collectedAllTimeMinor)} collected across all cycles,
          of ${money(summary.expectedAllTimeMinor)} scheduled.</p>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h3>Member payments</h3>
        <select class="select" id="cycle-picker" style="width:auto">${cycleOptions}</select>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>#</th><th>Member</th><th class="num">Expected</th><th class="num">Paid</th>
            <th>Status</th><th>Paid at</th><th>Reference</th></tr></thead>
          <tbody>${rows.map((r) => `
            <tr>
              <td data-label="#">${r.payoutPosition ?? '—'}</td>
              <td data-label="Member"><div class="strong">${escape(r.name)}</div>
                <div class="tiny muted">${escape(r.phone || '')}</div></td>
              <td data-label="Expected" class="num">${money(r.expectedAmountMinor)}</td>
              <td data-label="Paid" class="num strong">${money(r.paidAmountMinor)}</td>
              <td data-label="Status">${statusBadge(r.status)}${r.daysLate ? `<div class="tiny muted">${r.daysLate}d late</div>` : ''}</td>
              <td data-label="Paid at">${r.paidAt ? date(r.paidAt) : '—'}</td>
              <td data-label="Reference">${r.receipts.length
    ? r.receipts.map((t) => `<div class="tiny"><span class="strong">${escape(t.transactionId || '—')}</span>
        <span class="muted">${escape(titleCase(t.method || ''))} · ${escape(t.status)}</span></div>`).join('')
    : '<span class="tiny muted">—</span>'}</td>
            </tr>`).join('')}</tbody>
        </table>
      </div>
    </div>`;

  panel.querySelector('#cycle-picker').addEventListener('change', (event) => {
    paymentsTab(panel, group, Number(event.target.value));
  });
}

/* --------------------------------- QR codes -------------------------------- */

/**
 * The organizer's QR sheet.
 *
 * Images are rendered from the code by the server rather than encoded in the
 * page, so the QR the organizer prints is exactly the one the server will
 * honour. What a code carries is only a URL — scanning it opens the payment
 * page, where the member still has to be signed in as themselves.
 */
async function qrTab(panel, group) {
  panel.innerHTML = `<div class="card card-body">${skeletonLines(5)}</div>`;
  let data;
  try {
    data = await api.get(`/groups/${group._id}/qr`);
  } catch (err) {
    panel.innerHTML = errorState(err.message);
    return;
  }

  const { groupCode, memberCodes } = data;

  panel.innerHTML = `
    <div class="card no-print" style="margin-bottom:20px">
      <div class="card-head">
        <h3>${icon('smartphone')} Group QR code</h3>
        <div class="row wrap" style="gap:8px">
          <button class="btn btn-sm" data-download="${groupCode._id}" data-name="${escape(group.name)}">
            ${icon('download')} Download</button>
          <button class="btn btn-ghost btn-sm" data-share="${escape(groupCode.url)}">${icon('share')} Share</button>
          <button class="btn btn-ghost btn-sm" data-print="group">Print</button>
          <button class="btn btn-ghost btn-sm" data-rotate="${groupCode._id}">Replace</button>
        </div>
      </div>
      <div class="card-body row wrap" style="gap:20px;align-items:center">
        <img id="group-qr" alt="Group QR code" style="width:170px;height:170px;background:var(--surface-alt);border-radius:var(--radius)">
        <div class="col grow" style="gap:6px;min-width:220px">
          <p class="small muted" style="margin:0">
            Print this once and put it where members pay. Anyone in the group who scans it lands on
            their own contribution page for ${escape(group.name)} — they never type the group name or amount.</p>
          <div class="tiny muted">Scanned ${groupCode.scanCount} times${groupCode.lastScannedAt ? ` · last ${relative(groupCode.lastScannedAt)}` : ''}</div>
          <input class="input" readonly value="${escape(groupCode.url)}" style="font-size:12px">
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head no-print">
        <h3>Member QR codes (${memberCodes.length})</h3>
        <div class="row wrap" style="gap:8px">
          <button class="btn btn-ghost btn-sm" data-print="members">${icon('file')} Print all</button>
        </div>
      </div>
      <div class="card-body">
        <p class="small muted no-print" style="margin-top:0">
          One card per member. A member scanning their own card goes straight to what they owe.
          Scanning someone else's shows nothing about them and cannot pay from their wallet.</p>
        ${memberCodes.length ? `<div class="qr-grid" id="member-qr-grid">
          ${memberCodes.map((m) => `
            <div class="qr-card" data-card="${m._id}">
              <img data-member-qr="${m._id}" alt="" style="background:var(--surface-alt);aspect-ratio:1">
              <div class="qr-name">${escape(m.member.name)}</div>
              <div class="qr-sub">${escape(group.name)} · position ${m.member.payoutPosition ?? '—'}</div>
              <div class="qr-sub">Scanned ${m.scanCount}×</div>
              <div class="row no-print" style="gap:6px;justify-content:center;margin-top:8px">
                <button class="btn btn-ghost btn-sm" data-download="${m._id}" data-name="${escape(m.member.name)}">Download</button>
                <button class="btn btn-ghost btn-sm" data-revoke="${m._id}">Revoke</button>
              </div>
            </div>`).join('')}
        </div>` : emptyState({
    icon: 'users',
    title: 'No active members yet',
    message: 'Member codes are created once people join and are approved.',
  })}
      </div>
    </div>`;

  /* Images are fetched one at a time so a large group does not open 200
     connections at once. */
  const loadImage = async (codeId, target) => {
    try {
      const { png } = await api.get(`/groups/${group._id}/qr/${codeId}/image`);
      target.src = png;
      target.dataset.png = png;
    } catch { target.replaceWith(Object.assign(document.createElement('div'), { className: 'tiny muted', textContent: 'Could not load' })); }
  };

  await loadImage(groupCode._id, panel.querySelector('#group-qr'));
  for (const m of memberCodes) {
    // eslint-disable-next-line no-await-in-loop
    await loadImage(m._id, panel.querySelector(`[data-member-qr="${m._id}"]`));
  }

  panel.querySelectorAll('[data-download]').forEach((btn) => btn.addEventListener('click', () => {
    const id = btn.dataset.download;
    const img = panel.querySelector(id === groupCode._id ? '#group-qr' : `[data-member-qr="${id}"]`);
    if (!img?.dataset.png) { toastError('The code is still loading'); return; }
    const link = document.createElement('a');
    link.href = img.dataset.png;
    link.download = `${btn.dataset.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-susu-qr.png`;
    link.click();
  }));

  panel.querySelector('[data-share]')?.addEventListener('click', async (event) => {
    const url = event.currentTarget.dataset.share;
    const text = `Pay your ${group.name} contribution here: ${url}`;
    // The Web Share API opens the phone's own share sheet where it exists —
    // WhatsApp, SMS, anything — and falls back to the clipboard where it does not.
    if (navigator.share) {
      try { await navigator.share({ title: group.name, text, url }); return; } catch { /* cancelled */ }
    }
    copyToClipboard(url);
  });

  panel.querySelectorAll('[data-print]').forEach((btn) => btn.addEventListener('click', () => {
    const target = btn.dataset.print === 'group'
      ? panel.querySelector('#group-qr').closest('.card')
      : panel.querySelector('#member-qr-grid');
    if (!target) return;
    target.classList.add('qr-print');
    window.print();
    setTimeout(() => target.classList.remove('qr-print'), 500);
  }));

  panel.querySelector('[data-rotate]')?.addEventListener('click', async (event) => {
    const confirmed = await confirmDialog({
      title: 'Replace the group QR code?',
      message: 'Anything already printed with the old code stops working immediately.',
      confirmLabel: 'Replace it',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api.post(`/groups/${group._id}/qr/${event.currentTarget.dataset.rotate}/rotate`, {});
      toastSuccess('New QR code issued');
      qrTab(panel, group);
    } catch (err) {
      toastError(err.message);
    }
  });

  panel.querySelectorAll('[data-revoke]').forEach((btn) => btn.addEventListener('click', async () => {
    const confirmed = await confirmDialog({
      title: 'Revoke this member code?',
      message: 'Their printed card stops working. Reload the tab to issue them a new one.',
      confirmLabel: 'Revoke',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api.post(`/groups/${group._id}/qr/${btn.dataset.revoke}/revoke`, {});
      toastSuccess('Code revoked');
      qrTab(panel, group);
    } catch (err) {
      toastError(err.message);
    }
  }));
}
