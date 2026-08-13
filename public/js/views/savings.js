/** Individual savings plans, including the dedicated rent savings view. */

import { api } from '../core/api.js';
import { money, date, escape, statusBadge, titleCase, frequencyLabel, percent } from '../core/format.js';
import {
  icon, emptyState, errorState, skeletonLines, toastSuccess, toastError, modal, buttonLoading,
} from '../core/ui.js';

const TYPES = [
  ['personal', 'Personal savings', 'target'],
  ['emergency', 'Emergency fund', 'shield'],
  ['rent', 'Rent savings', 'home'],
  ['school', 'School fees', 'file'],
  ['business', 'Business', 'building'],
  ['travel', 'Travel', 'zap'],
  ['goal', 'Goal savings', 'target'],
  ['custom', 'Custom', 'piggy-bank'],
];

export async function renderSavings(root, { navigate }) {
  root.innerHTML = `
    <div class="page-head">
      <div><h1>My Savings</h1><p>Personal goals you fund at your own pace.</p></div>
      <button class="btn" data-action="create">${icon('plus')} New savings goal</button>
    </div>
    <div class="card card-body">${skeletonLines(4)}</div>`;

  root.querySelector('[data-action="create"]').addEventListener('click', () =>
    openCreateModal((plan) => navigate(`/savings/${plan._id}`)));

  try {
    const { plans } = await api.get('/savings');
    const container = root.querySelector('.card');
    if (!plans.length) {
      container.outerHTML = `<div class="card">${emptyState({
        icon: 'target',
        title: 'Start your first savings goal',
        message: 'Save towards rent, school fees, an emergency fund or anything else that matters to you.',
        action: '<button class="btn" data-action="create-empty">Create a savings goal</button>',
      })}</div>`;
      root.querySelector('[data-action="create-empty"]').addEventListener('click', () =>
        openCreateModal((plan) => navigate(`/savings/${plan._id}`)));
      return;
    }

    container.outerHTML = `<div class="stat-grid" style="grid-template-columns:repeat(auto-fill,minmax(300px,1fr))">
      ${plans.map(planCard).join('')}</div>`;
  } catch (err) {
    root.querySelector('.card').outerHTML = errorState(err.message);
  }
}

const planCard = (plan) => `
  <div class="card card-hover card-body" data-nav="/savings/${plan._id}" style="cursor:pointer">
    <div class="row-between" style="margin-bottom:14px">
      <div class="row">
        <div class="group-icon">${icon('piggy-bank', 'icon icon-sm')}</div>
        <div>
          <div class="strong">${escape(plan.name)}</div>
          <div class="tiny muted">${titleCase(plan.type)} · ${frequencyLabel(plan.frequency)}</div>
        </div>
      </div>
      ${statusBadge(plan.status)}
    </div>
    <div class="stat-value" style="font-size:1.5rem">${money(plan.currentAmountMinor)}</div>
    ${plan.targetAmountMinor ? `
      <div class="small muted" style="margin-bottom:8px">of ${money(plan.targetAmountMinor)} target</div>
      <div class="progress"><div class="progress-bar green" style="width:${plan.progressPercent}%"></div></div>
      <div class="row-between tiny muted" style="margin-top:6px">
        <span>${percent(plan.progressPercent)} complete</span>
        <span>${money(plan.remainingMinor)} to go</span>
      </div>` : '<div class="small muted">No target set</div>'}
  </div>`;

export async function renderSavingsDetail(root, { params, navigate }) {
  root.innerHTML = `<div class="card card-body">${skeletonLines(6)}</div>`;
  let data;
  try {
    data = await api.get(`/savings/${params.id}`);
  } catch (err) {
    root.innerHTML = errorState(err.message);
    return;
  }

  const { plan, transactions, withdrawalEligibility, projection } = data;
  const reload = () => renderSavingsDetail(root, { params, navigate });

  root.innerHTML = `
    <div class="page-head">
      <div>
        <button class="btn btn-ghost btn-sm" data-nav="/savings">${icon('chevron-left', 'icon icon-sm')} All savings</button>
        <h1 style="margin-top:8px">${escape(plan.name)}</h1>
        <p>${escape(plan.description || titleCase(plan.type))}</p>
      </div>
      <div class="row">
        <button class="btn btn-secondary" data-action="release" ${withdrawalEligibility.eligible ? '' : 'disabled'}>Release to wallet</button>
        <button class="btn" data-action="deposit">${icon('plus')} Add money</button>
      </div>
    </div>

    <div class="stat-grid">
      <div class="stat purple"><div class="stat-icon">${icon('piggy-bank')}</div><div class="stat-label">Saved so far</div>
        <div class="stat-value">${money(plan.currentAmountMinor)}</div><div class="stat-meta">${percent(plan.progressPercent)} of target</div></div>
      <div class="stat green"><div class="stat-icon">${icon('target')}</div><div class="stat-label">Target</div>
        <div class="stat-value">${money(plan.targetAmountMinor)}</div><div class="stat-meta">${money(plan.remainingMinor)} remaining</div></div>
      <div class="stat orange"><div class="stat-icon">${icon('calendar')}</div><div class="stat-label">Next contribution</div>
        <div class="stat-value" style="font-size:1.4rem">${date(plan.nextContributionDate)}</div>
        <div class="stat-meta">${money(plan.contributionAmountMinor)} ${frequencyLabel(plan.frequency).toLowerCase()}</div></div>
      <div class="stat blue"><div class="stat-icon">${icon('calendar-clock')}</div><div class="stat-label">Target date</div>
        <div class="stat-value" style="font-size:1.4rem">${plan.targetDate ? date(plan.targetDate) : 'Open'}</div>
        <div class="stat-meta">${statusBadge(plan.status)}</div></div>
    </div>

    ${!withdrawalEligibility.eligible ? `
      <div class="card card-body" style="background:var(--orange-50);border-color:var(--orange-100);margin-bottom:24px">
        <div class="row">${icon('alert-circle')}<div><div class="strong small">Funds are locked</div>
        <div class="small muted">${escape(withdrawalEligibility.reason)}</div></div></div>
      </div>` : ''}

    ${projection ? rentProjectionCard(projection) : ''}

    <div class="card">
      <div class="card-head"><h3>Activity</h3></div>
      ${transactions.length ? transactions.map((t) => `
        <div class="txn">
          <div class="txn-icon ${t.direction === 'credit' ? 'in' : 'out'}">
            ${icon(t.direction === 'credit' ? 'arrow-down-left' : 'arrow-up-right', 'icon icon-sm')}</div>
          <div class="info"><div class="desc">${escape(t.description)}</div>
            <div class="time">${date(t.createdAt)}</div></div>
          <div class="amount ${t.direction === 'credit' ? 'money-in' : 'money-out'}">${money(t.grossAmountMinor)}</div>
        </div>`).join('')
    : emptyState({ icon: 'receipt', title: 'No deposits yet', message: 'Add money to start growing this goal.' })}
    </div>`;

  root.querySelector('[data-action="deposit"]').addEventListener('click', () => {
    const dialog = modal({
      title: `Add money to ${plan.name}`,
      body: `
        <div class="field">
          <label for="amount">Amount</label>
          <div class="input-group"><span class="prefix">GH₵</span>
            <input class="input" id="amount" type="number" step="0.01" min="1"
                   value="${plan.contributionAmountMinor ? (plan.contributionAmountMinor / 100).toFixed(2) : ''}"></div>
          <span class="hint">Money moves from your wallet into this plan.</span>
        </div>
        <div id="dep-error" class="error"></div>`,
      footer: '<button class="btn btn-secondary" data-close>Cancel</button><button class="btn" data-submit>Deposit</button>',
    });
    dialog.root.querySelector('[data-submit]').addEventListener('click', async (e) => {
      const restore = buttonLoading(e.target);
      try {
        await api.post(`/savings/${plan._id}/deposit`, { amount: Number(dialog.root.querySelector('#amount').value) });
        toastSuccess('Deposit successful');
        dialog.close();
        reload();
      } catch (err) {
        dialog.root.querySelector('#dep-error').textContent = err.message;
        restore();
      }
    });
  });

  root.querySelector('[data-action="release"]').addEventListener('click', async (e) => {
    const restore = buttonLoading(e.target);
    try {
      await api.post(`/savings/${plan._id}/release`, {});
      toastSuccess('Funds released to your wallet');
      reload();
    } catch (err) {
      toastError(err.message);
      restore();
    }
  });
}

const rentProjectionCard = (p) => `
  <div class="card" style="margin-bottom:24px">
    <div class="card-head"><h3>Rent projection</h3>
      <span class="badge ${p.onTrack === false ? 'badge-warning' : 'badge-success'}">
        ${p.onTrack === false ? 'Behind schedule' : 'On track'}</span></div>
    <div class="card-body">
      <div class="review-list">
        <div class="review-row"><span class="k">Rent target</span><span class="v">${money(p.targetMinor)}</span></div>
        <div class="review-row"><span class="k">Saved</span><span class="v">${money(p.savedMinor)}</span></div>
        <div class="review-row"><span class="k">Remaining</span><span class="v">${money(p.remainingMinor)}</span></div>
        <div class="review-row"><span class="k">Monthly target</span><span class="v">${money(p.monthlyTargetMinor)}</span></div>
        <div class="review-row"><span class="k">Projected completion</span>
          <span class="v">${p.projectedCompletionDate ? date(p.projectedCompletionDate) : 'Set a monthly amount'}</span></div>
      </div>
      <div class="progress" style="margin-top:16px"><div class="progress-bar orange" style="width:${p.percentComplete}%"></div></div>
      <div class="center small muted" style="margin-top:8px">${percent(p.percentComplete)} complete</div>
    </div>
  </div>`;

export async function renderRentSavings(root, { navigate }) {
  root.innerHTML = `
    <div class="page-head">
      <div><h1>Rent Savings</h1><p>Put rent aside every month so the landlord never surprises you.</p></div>
      <button class="btn" data-action="create">${icon('plus')} New rent goal</button>
    </div>
    <div class="card card-body">${skeletonLines(4)}</div>`;

  root.querySelector('[data-action="create"]').addEventListener('click', () =>
    openCreateModal((plan) => navigate(`/savings/${plan._id}`), 'rent'));

  try {
    const { plans } = await api.get('/savings/rent/overview');
    const container = root.querySelector('.card');
    if (!plans.length) {
      container.outerHTML = `<div class="card">${emptyState({
        icon: 'home',
        title: 'No rent goal yet',
        message: 'Tell us your rent and target date, and we will work out what to save each month.',
        action: '<button class="btn" data-action="create-empty">Create a rent goal</button>',
      })}</div>`;
      root.querySelector('[data-action="create-empty"]').addEventListener('click', () =>
        openCreateModal((plan) => navigate(`/savings/${plan._id}`), 'rent'));
      return;
    }

    container.outerHTML = plans.map(({ plan, projection }) => `
      <div class="card" style="margin-bottom:20px">
        <div class="card-head">
          <div><h3>${escape(plan.name)}</h3>
            <div class="tiny muted">${escape(plan.rentDetails?.propertyLabel || 'Rent goal')}</div></div>
          <button class="btn btn-secondary btn-sm" data-nav="/savings/${plan._id}">Open</button>
        </div>
        <div class="card-body">
          <div class="stat-value">${money(projection.savedMinor)}
            <span class="muted" style="font-size:1rem;font-weight:600">/ ${money(projection.targetMinor)}</span></div>
          <div class="progress" style="margin:14px 0"><div class="progress-bar orange" style="width:${projection.percentComplete}%"></div></div>
          <div class="row-between small muted wrap">
            <span>${percent(projection.percentComplete)} complete</span>
            <span>Monthly target ${money(projection.monthlyTargetMinor)}</span>
            <span>${projection.projectedCompletionDate ? `Projected ${date(projection.projectedCompletionDate)}` : ''}</span>
          </div>
        </div>
      </div>`).join('');
  } catch (err) {
    root.querySelector('.card').outerHTML = errorState(err.message);
  }
}

function openCreateModal(onCreated, fixedType = null) {
  const dialog = modal({
    title: fixedType === 'rent' ? 'New rent goal' : 'New savings goal',
    size: 'modal-lg',
    body: `
      <div class="field">
        <label for="name">Goal name</label>
        <input class="input" id="name" placeholder="${fixedType === 'rent' ? 'Rent 2026' : 'Emergency Savings'}">
      </div>
      ${fixedType ? '' : `
      <div class="field">
        <label for="type">Type</label>
        <select class="select" id="type">
          ${TYPES.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}
        </select>
      </div>`}
      <div class="row wrap" style="gap:16px">
        <div class="field grow">
          <label for="target">Target amount</label>
          <div class="input-group"><span class="prefix">GH₵</span>
            <input class="input" id="target" type="number" step="0.01" min="1" placeholder="10000.00"></div>
        </div>
        <div class="field grow">
          <label for="contribution">Regular contribution</label>
          <div class="input-group"><span class="prefix">GH₵</span>
            <input class="input" id="contribution" type="number" step="0.01" min="1" placeholder="500.00"></div>
        </div>
      </div>
      <div class="row wrap" style="gap:16px">
        <div class="field grow">
          <label for="frequency">Frequency</label>
          <select class="select" id="frequency">
            <option value="monthly">Monthly</option>
            <option value="weekly">Weekly</option>
            <option value="biweekly">Every 2 weeks</option>
            <option value="daily">Daily</option>
          </select>
        </div>
        <div class="field grow">
          <label for="targetDate">Target date</label>
          <input class="input" id="targetDate" type="date">
        </div>
      </div>
      <div id="plan-error" class="error"></div>`,
    footer: '<button class="btn btn-secondary" data-close>Cancel</button><button class="btn" data-submit>Create goal</button>',
  });

  dialog.root.querySelector('[data-submit]').addEventListener('click', async (e) => {
    const restore = buttonLoading(e.target);
    const value = (id) => dialog.root.querySelector(`#${id}`)?.value;
    try {
      const { plan } = await api.post('/savings', {
        name: value('name'),
        type: fixedType || value('type'),
        targetAmount: value('target') ? Number(value('target')) : undefined,
        contributionAmount: value('contribution') ? Number(value('contribution')) : undefined,
        frequency: value('frequency'),
        targetDate: value('targetDate') || undefined,
        monthlyRent: fixedType === 'rent' && value('contribution') ? Number(value('contribution')) : undefined,
      });
      toastSuccess('Savings goal created');
      dialog.close();
      onCreated(plan);
    } catch (err) {
      dialog.root.querySelector('#plan-error').textContent = err.message;
      restore();
    }
  });
}
