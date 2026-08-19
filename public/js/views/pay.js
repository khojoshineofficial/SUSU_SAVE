/**
 * The page a scanned QR code opens.
 *
 * The code in the URL identifies a group — and, for a personal card, a member.
 * It carries no authority: this page runs inside the signed-in app shell, and
 * the payment it offers is always the viewer's own outstanding contribution,
 * resolved server-side under their session. Scanning somebody else's card
 * therefore shows a dead end rather than a way to pay from their wallet.
 */

import { api } from '../core/api.js';
import { money, date, escape, frequencyLabel, statusBadge } from '../core/format.js';
import {
  icon, emptyState, errorState, skeletonLines, toastSuccess, toastError, buttonLoading,
} from '../core/ui.js';
import { loadProfile, state } from '../core/store.js';

export async function renderPay(root, { params, navigate }) {
  root.innerHTML = `<div class="card card-body">${skeletonLines(5)}</div>`;

  let scan;
  try {
    scan = await api.get(`/pay/${encodeURIComponent(params.code)}`);
  } catch (err) {
    root.innerHTML = errorState(err.message);
    return;
  }

  const { group, due, isMember, belongsToViewer, forMemberName, kind } = scan;

  const shell = (inner) => {
    root.innerHTML = `
      <div class="page-head">
        <div>
          <h1>${escape(group.name)}</h1>
          <p>${frequencyLabel(group.contributionFrequency)} ${money(group.contributionAmountMinor)} ·
            cycle ${group.currentCycle} of ${group.totalCycles}</p>
        </div>
        <button class="btn btn-ghost btn-sm" data-nav="/groups/${group._id}">Open group</button>
      </div>
      ${inner}`;
  };

  // A personal card scanned by anyone else. Nothing about the owner is shown
  // beyond the fact that the card is not the scanner's.
  if (kind === 'member' && !belongsToViewer) {
    shell(`<div class="card">${emptyState({
      icon: 'lock',
      title: 'This card belongs to someone else',
      message: `${forMemberName || 'Another member'} owns this QR code. You can only pay your own contribution.`,
      action: `<button class="btn" data-nav="/groups/${group._id}">Go to the group</button>`,
    })}</div>`);
    return;
  }

  if (!isMember) {
    shell(`<div class="card">${emptyState({
      icon: 'users',
      title: 'You are not a member of this group',
      message: `Ask the organizer of ${group.name} for an invite code, then join before paying.`,
      action: '<button class="btn" data-nav="/join-group">Join a group</button>',
    })}</div>`);
    return;
  }

  if (group.status !== 'active') {
    shell(`<div class="card">${emptyState({
      icon: 'clock',
      title: 'This group is not collecting yet',
      message: 'Contributions open once the organizer starts the group.',
    })}</div>`);
    return;
  }

  if (!due) {
    shell(`<div class="card">${emptyState({
      icon: 'check-circle',
      title: 'You are fully paid up',
      message: `Nothing is outstanding for you in ${group.name} right now.`,
      action: `<button class="btn" data-nav="/groups/${group._id}">See the schedule</button>`,
    })}</div>`);
    return;
  }

  // The wallet balance decides whether this is a one-tap payment or a top-up
  // first, so the member is told which it will be before they commit.
  if (!state.wallet) await loadProfile().catch(() => {});
  const balance = state.wallet?.availableBalanceMinor ?? 0;
  const short = due.outstandingMinor - balance;

  shell(`
    <div class="card" style="max-width:520px">
      <div class="card-body col" style="gap:16px">
        <div class="row-between">
          <span class="small muted">Cycle ${due.cycle}</span>
          ${statusBadge(due.status)}
        </div>

        <div>
          <div class="tiny muted strong" style="text-transform:uppercase;letter-spacing:.06em">You owe</div>
          <div style="font-size:34px;font-weight:800;line-height:1.1">${money(due.outstandingMinor)}</div>
          <div class="small muted">
            Due ${date(due.dueDate)}${due.paidAmountMinor ? ` · ${money(due.paidAmountMinor)} already paid` : ''}
          </div>
        </div>

        <div class="row-between small" style="padding-top:12px;border-top:1px solid var(--border)">
          <span class="muted">Wallet balance</span>
          <span class="strong">${money(balance)}</span>
        </div>

        ${short > 0 ? `
          <div class="card card-body" style="background:var(--orange-50);border-color:var(--orange-100)">
            <div class="small"><span class="strong">You need ${money(short)} more.</span>
            Top up your wallet with mobile money, then come back and pay.</div>
          </div>
          <button class="btn btn-lg btn-block" data-nav="/wallet">${icon('wallet')} Top up my wallet</button>`
    : `<button class="btn btn-lg btn-block" data-action="pay">Pay ${money(due.outstandingMinor)}</button>
          <p class="tiny muted" style="margin:0;text-align:center">
            Paid from your SUSU SAVE wallet. Your record updates the moment it settles.</p>`}
      </div>
    </div>`);

  root.querySelector('[data-action="pay"]')?.addEventListener('click', async (event) => {
    const restore = buttonLoading(event.currentTarget);
    try {
      await api.post(`/groups/${group._id}/contributions`, { cycle: due.cycle }, {
        // A double tap on a phone must not pay twice. The server treats a
        // repeat of this key as the same payment and returns the original.
        headers: { 'Idempotency-Key': `qr:${scan.code}:${due.cycle}` },
      });
      toastSuccess('Contribution paid — your record is updated');
      navigate(`/groups/${group._id}`);
    } catch (err) {
      toastError(err.message);
      restore();
    }
  });
}
