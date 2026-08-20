/** Wallet, transactions, transaction detail/receipt, withdrawals and payouts. */

import { api } from '../core/api.js';
import { money, date, dateTime, relative, escape, statusBadge, titleCase } from '../core/format.js';
import {
  icon, emptyState, errorState, skeletonLines, skeletonCards, toastSuccess, toastError,
  modal, buttonLoading, avatar,
} from '../core/ui.js';
import { loadProfile } from '../core/store.js';

/* ---------------------------------- wallet --------------------------------- */

/**
 * Handles the return leg of a hosted checkout.
 *
 * The provider redirects back with our own reference on the query string. That
 * redirect proves nothing on its own — it is a URL the customer could type — so
 * this asks the server to verify with the provider, which is the same
 * idempotent path the webhook uses. The webhook usually gets there first; this
 * simply means the customer does not have to wait for it.
 */
async function settleReturnFromCheckout() {
  const params = new URLSearchParams(window.location.search);
  const reference = params.get('reference') || params.get('trxref');
  if (!reference) return;

  // Clear it immediately so a refresh does not re-run this.
  params.delete('reference');
  params.delete('trxref');
  const query = params.toString();
  window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}`);

  try {
    const result = await api.post(`/wallet/payments/${encodeURIComponent(reference)}/confirm`);
    if (result.applied) {
      toastSuccess('Payment confirmed — your wallet has been credited');
      await loadProfile().catch(() => {});
    } else {
      toastError('That payment has not been confirmed yet. It will appear as soon as your provider settles it.');
    }
  } catch (err) {
    toastError(err.message);
  }
}

export async function renderWallet(root) {
  root.innerHTML = `<div class="page-head"><div><h1>Wallet</h1><p>Your money on SUSU SAVE.</p></div></div>${skeletonCards(4)}`;

  // Coming back from a hosted checkout (Paystack sends the customer to
  // /wallet?reference=…). Verify before painting, so the balance below is the
  // one the payment produced rather than the one from before it.
  await settleReturnFromCheckout();

  let wallet;
  let pendingMinor = 0;
  try {
    ({ wallet, pendingMinor } = await api.get('/wallet'));
  } catch (err) {
    root.innerHTML = errorState(err.message);
    return;
  }

  root.innerHTML = `
    <div class="page-head">
      <div><h1>Wallet</h1><p>Top up, contribute and withdraw — every movement is recorded on your ledger.</p></div>
      <div class="row">
        <button class="btn btn-secondary" data-action="withdraw">${icon('arrow-up-right')} Withdraw</button>
        <button class="btn" data-action="topup">${icon('plus')} Add money</button>
      </div>
    </div>

    <div class="stat-grid">
      <div class="stat purple"><div class="stat-icon">${icon('wallet')}</div><div class="stat-label">Available balance</div>
        <div class="stat-value">${money(wallet.availableBalanceMinor)}</div><div class="stat-meta">Ready to use</div></div>
      <div class="stat orange"><div class="stat-icon">${icon('calendar-clock')}</div><div class="stat-label">Pending</div>
        <div class="stat-value">${money(pendingMinor)}</div><div class="stat-meta">Awaiting confirmation</div></div>
      <div class="stat green"><div class="stat-icon">${icon('piggy-bank')}</div><div class="stat-label">Total saved</div>
        <div class="stat-value">${money(wallet.totalContributedMinor)}</div><div class="stat-meta">All time</div></div>
      <div class="stat blue"><div class="stat-icon">${icon('banknote')}</div><div class="stat-label">Total received</div>
        <div class="stat-value">${money(wallet.totalReceivedMinor)}</div><div class="stat-meta">Payouts credited</div></div>
    </div>

    <div class="dash-grid">
      <div class="card">
        <div class="card-head"><h3>Recent activity</h3>
          <button class="btn btn-ghost btn-sm" data-nav="/transactions">View all</button></div>
        <div id="activity">${skeletonLines(4)}</div>
      </div>

      <div class="dash-col">
        <div class="card">
          <div class="card-head"><h3>Lifetime totals</h3></div>
          <div class="card-body">
            <div class="review-list">
              <div class="review-row"><span class="k">Deposited</span><span class="v">${money(wallet.totalDepositedMinor)}</span></div>
              <div class="review-row"><span class="k">Contributed</span><span class="v">${money(wallet.totalContributedMinor)}</span></div>
              <div class="review-row"><span class="k">Received</span><span class="v">${money(wallet.totalReceivedMinor)}</span></div>
              <div class="review-row"><span class="k">Withdrawn</span><span class="v">${money(wallet.totalWithdrawnMinor)}</span></div>
              <div class="review-row"><span class="k">Fees paid</span><span class="v">${money(wallet.totalFeesPaidMinor)}</span></div>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>Withdrawals</h3></div>
          <div id="withdrawals">${skeletonLines(3)}</div>
        </div>
      </div>
    </div>`;

  root.querySelector('[data-action="topup"]').addEventListener('click', () => openTopUpModal(() => renderWallet(root)));
  root.querySelector('[data-action="withdraw"]').addEventListener('click', () => openWithdrawModal(wallet, () => renderWallet(root)));

  api.get('/transactions', { limit: 6 })
    .then(({ transactions }) => {
      root.querySelector('#activity').innerHTML = transactions.length
        ? transactions.map(transactionRow).join('')
        : emptyState({ icon: 'receipt', title: 'No transactions yet', message: 'Add money to your wallet to get started.' });
    })
    .catch(() => { root.querySelector('#activity').innerHTML = errorState('Could not load activity'); });

  api.get('/withdrawals', { limit: 5 })
    .then(({ withdrawals }) => {
      root.querySelector('#withdrawals').innerHTML = withdrawals.length
        ? withdrawals.map((w) => `
          <div class="payout-item">
            <div class="txn-icon out">${icon('arrow-up-right', 'icon icon-sm')}</div>
            <div class="info">
              <div class="name">${money(w.netAmountMinor)}</div>
              <div class="sub">${escape(titleCase(w.destination.provider))} · ${dateTime(w.createdAt)}</div>
            </div>
            ${statusBadge(w.status)}
          </div>`).join('')
        : emptyState({ icon: 'arrow-up-right', title: 'No withdrawals', message: 'Withdraw to your mobile money account when you are ready.' });
    })
    .catch(() => { root.querySelector('#withdrawals').innerHTML = ''; });
}

function openTopUpModal(onDone) {
  const dialog = modal({
    title: 'Add money to your wallet',
    body: `
      <div class="field">
        <label for="amount">Amount</label>
        <div class="input-group"><span class="prefix">GH₵</span>
          <input class="input" id="amount" type="number" step="0.01" min="1" placeholder="100.00"></div>
      </div>
      <div class="field">
        <label for="provider">Mobile money provider</label>
        <select class="select" id="provider">
          <option value="mtn">MTN Mobile Money</option>
          <option value="telecel">Telecel Cash</option>
          <option value="airteltigo">AirtelTigo Money</option>
        </select>
      </div>
      <div class="field">
        <label for="account">Mobile money number</label>
        <input class="input" id="account" placeholder="0244123456">
      </div>
      <p class="tiny muted">You will approve the payment on your phone. Your wallet is credited only after the
      payment provider confirms it.</p>
      <div id="topup-error" class="error"></div>`,
    footer: '<button class="btn btn-secondary" data-close>Cancel</button><button class="btn" data-submit>Continue</button>',
  });

  dialog.root.querySelector('[data-submit]').addEventListener('click', async (e) => {
    const restore = buttonLoading(e.target);
    try {
      const { payment } = await api.post('/wallet/topup', {
        amount: Number(dialog.root.querySelector('#amount').value),
        provider: dialog.root.querySelector('#provider').value,
        accountNumber: dialog.root.querySelector('#account').value,
      });
      dialog.close();
      // A hosted gateway (Paystack, a card processor) returns a checkout URL —
      // the payment cannot complete unless the customer actually goes there.
      if (payment.checkoutUrl) {
        window.location.href = payment.checkoutUrl;
        return;
      }
      openPaymentPendingModal(payment, onDone);
    } catch (err) {
      dialog.root.querySelector('#topup-error').textContent = err.message;
      restore();
    }
  });
}

/**
 * The pending-payment screen. "I have paid" re-verifies with the provider
 * server-side; it never marks the payment successful on its own.
 */
function openPaymentPendingModal(payment, onDone) {
  const dialog = modal({
    title: 'Approve the payment',
    body: `
      <div class="empty">
        <div class="empty-icon">${icon('calendar-clock', 'icon icon-lg')}</div>
        <h4>${money(payment.amountMinor)}</h4>
        <p>Approve the prompt on your phone. Once your provider confirms the payment, your wallet is credited.</p>
        <div class="badge">Reference: ${escape(payment.reference)}</div>
      </div>
      <div id="confirm-error" class="error center"></div>`,
    footer: '<button class="btn btn-secondary" data-close>Close</button><button class="btn" data-check>I have paid — check now</button>',
  });

  dialog.root.querySelector('[data-check]').addEventListener('click', async (e) => {
    const restore = buttonLoading(e.target, 'Checking…');
    try {
      const result = await api.post(`/wallet/payments/${payment.reference}/confirm`);
      if (result.applied) {
        toastSuccess('Wallet topped up');
        dialog.close();
        await loadProfile().catch(() => {});
        onDone();
      } else {
        dialog.root.querySelector('#confirm-error').textContent = 'Not confirmed yet — try again in a moment.';
        restore();
      }
    } catch (err) {
      dialog.root.querySelector('#confirm-error').textContent = err.message;
      restore();
    }
  });
}

function openWithdrawModal(wallet, onDone) {
  const dialog = modal({
    title: 'Withdraw to mobile money',
    body: `
      <p class="small muted" style="margin-bottom:16px">Available: <span class="strong">${money(wallet.availableBalanceMinor)}</span></p>
      <div class="field">
        <label for="amount">Amount</label>
        <div class="input-group"><span class="prefix">GH₵</span>
          <input class="input" id="amount" type="number" step="0.01" min="1"></div>
        <span class="hint" id="quote">Fees are calculated when you enter an amount.</span>
      </div>
      <div class="field">
        <label for="provider">Provider</label>
        <select class="select" id="provider">
          <option value="mtn">MTN Mobile Money</option>
          <option value="telecel">Telecel Cash</option>
          <option value="airteltigo">AirtelTigo Money</option>
        </select>
      </div>
      <div class="field">
        <label for="account">Mobile money number</label>
        <input class="input" id="account" placeholder="0244123456">
      </div>
      <div class="field">
        <label for="reason">Reason (optional)</label>
        <input class="input" id="reason" placeholder="School fees">
      </div>
      <div id="wd-error" class="error"></div>`,
    footer: '<button class="btn btn-secondary" data-close>Cancel</button><button class="btn" data-submit>Request withdrawal</button>',
  });

  const amountInput = dialog.root.querySelector('#amount');
  const quote = dialog.root.querySelector('#quote');
  let quoteTimer;

  amountInput.addEventListener('input', () => {
    clearTimeout(quoteTimer);
    const value = Number(amountInput.value);
    if (!(value > 0)) { quote.textContent = 'Fees are calculated when you enter an amount.'; return; }
    quoteTimer = setTimeout(async () => {
      try {
        const { quote: q } = await api.get('/withdrawals/quote', { amount: value });
        quote.textContent = `Fee ${money(q.feeMinor)} · You receive ${money(q.netAmountMinor)}`;
      } catch { /* leave the previous hint in place */ }
    }, 350);
  });

  dialog.root.querySelector('[data-submit]').addEventListener('click', async (e) => {
    const restore = buttonLoading(e.target);
    try {
      await api.post('/withdrawals', {
        amount: Number(amountInput.value),
        provider: dialog.root.querySelector('#provider').value,
        accountNumber: dialog.root.querySelector('#account').value,
        reason: dialog.root.querySelector('#reason').value,
      });
      toastSuccess('Withdrawal requested — we will notify you once it is sent');
      dialog.close();
      await loadProfile().catch(() => {});
      onDone();
    } catch (err) {
      dialog.root.querySelector('#wd-error').textContent = err.message;
      restore();
    }
  });
}

/* ------------------------------- transactions ------------------------------ */

const transactionRow = (txn) => {
  const tone = txn.type === 'payout' ? 'payout' : txn.direction === 'credit' ? 'in' : 'out';
  const cls = txn.type === 'payout' ? 'money-payout' : txn.direction === 'credit' ? 'money-in' : 'money-out';
  return `
    <div class="txn" data-nav="/transactions/${txn.transactionId}">
      <div class="txn-icon ${tone}">${icon(txn.direction === 'credit' ? 'arrow-down-left' : 'arrow-up-right', 'icon icon-sm')}</div>
      <div class="info">
        <div class="desc truncate">${escape(txn.description || titleCase(txn.type))}</div>
        <div class="time">${dateTime(txn.createdAt)}</div>
      </div>
      <div class="amount">
        <div class="${cls}">${txn.direction === 'credit' ? '+' : '-'}${money(txn.grossAmountMinor)}</div>
        <div class="tiny muted">${escape(txn.status)}</div>
      </div>
    </div>`;
};

export async function renderTransactions(root) {
  root.innerHTML = `
    <div class="page-head"><div><h1>Transactions</h1><p>Your complete SUSU SAVE ledger.</p></div></div>
    <div class="card">
      <div class="card-head">
        <div class="row wrap">
          <select class="select" id="type" style="width:auto">
            <option value="">All types</option>
            ${['contribution', 'payout', 'deposit', 'withdrawal', 'refund', 'registration_fee', 'platform_fee']
    .map((t) => `<option value="${t}">${titleCase(t)}</option>`).join('')}
          </select>
          <select class="select" id="status" style="width:auto">
            <option value="">All statuses</option>
            ${['successful', 'pending', 'failed', 'refunded'].map((s) => `<option value="${s}">${titleCase(s)}</option>`).join('')}
          </select>
        </div>
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
    const list = root.querySelector('#list');
    list.innerHTML = skeletonLines(8);
    try {
      const { transactions, meta } = await api.get('/transactions', {
        page,
        limit: 20,
        type: root.querySelector('#type').value,
        status: root.querySelector('#status').value,
      });
      list.innerHTML = transactions.length
        ? transactions.map(transactionRow).join('')
        : emptyState({ icon: 'receipt', title: 'No transactions found', message: 'Try a different filter, or make your first contribution.' });

      const pager = root.querySelector('#pager');
      pager.classList.toggle('hidden', meta.totalPages <= 1);
      root.querySelector('#pager-info').textContent = `Page ${meta.page} of ${meta.totalPages} · ${meta.total} transactions`;
      root.querySelector('#prev').disabled = meta.page <= 1;
      root.querySelector('#next').disabled = meta.page >= meta.totalPages;
    } catch (err) {
      list.innerHTML = errorState(err.message);
    }
  };

  root.querySelector('#type').addEventListener('change', () => { page = 1; load(); });
  root.querySelector('#status').addEventListener('change', () => { page = 1; load(); });
  root.querySelector('#prev').addEventListener('click', () => { page -= 1; load(); });
  root.querySelector('#next').addEventListener('click', () => { page += 1; load(); });
  load();
}

export async function renderTransactionDetail(root, { params }) {
  root.innerHTML = `<div class="card card-body">${skeletonLines(6)}</div>`;
  let data;
  try {
    data = await api.get(`/transactions/${params.id}`);
  } catch (err) {
    root.innerHTML = errorState(err.message);
    return;
  }

  const { transaction: t, receipt } = data;
  root.innerHTML = `
    <div class="page-head">
      <div>
        <button class="btn btn-ghost btn-sm" data-nav="/transactions">${icon('chevron-left', 'icon icon-sm')} All transactions</button>
        <h1 style="margin-top:8px">${escape(titleCase(t.type))}</h1>
        <p>${escape(t.transactionId)}</p>
      </div>
      <button class="btn btn-secondary" data-print>${icon('download')} Print receipt</button>
    </div>

    <div class="card" style="max-width:640px">
      <div class="card-body center" style="border-bottom:1px solid var(--border)">
        <div class="tiny muted strong">SUSU SAVE RECEIPT</div>
        <div class="stat-value" style="margin:8px 0">${money(t.grossAmountMinor)}</div>
        ${statusBadge(t.status)}
      </div>
      <div class="card-body">
        <div class="review-list">
          <div class="review-row"><span class="k">Transaction ID</span><span class="v">${escape(t.transactionId)}</span></div>
          <div class="review-row"><span class="k">Customer</span><span class="v">${escape(receipt.customer)}</span></div>
          <div class="review-row"><span class="k">Date</span><span class="v">${dateTime(t.createdAt)}</span></div>
          <div class="review-row"><span class="k">Type</span><span class="v">${escape(titleCase(t.type))}</span></div>
          <div class="review-row"><span class="k">Amount</span><span class="v">${money(t.grossAmountMinor)}</span></div>
          <div class="review-row"><span class="k">Fee</span><span class="v">${money(t.feeMinor)}</span></div>
          <div class="review-row"><span class="k">Net amount</span><span class="v">${money(t.netAmountMinor)}</span></div>
          <div class="review-row"><span class="k">Payment method</span><span class="v">${escape(titleCase(t.paymentMethod))}</span></div>
          ${t.groupId ? `<div class="review-row"><span class="k">Group</span><span class="v">${escape(t.groupId.name)}</span></div>` : ''}
          ${t.savingsPlanId ? `<div class="review-row"><span class="k">Savings plan</span><span class="v">${escape(t.savingsPlanId.name)}</span></div>` : ''}
          ${t.providerReference ? `<div class="review-row"><span class="k">Provider reference</span><span class="v">${escape(t.providerReference)}</span></div>` : ''}
          <div class="review-row"><span class="k">Description</span><span class="v">${escape(t.description || '—')}</span></div>
        </div>
      </div>
    </div>`;

  root.querySelector('[data-print]')?.addEventListener('click', () => window.print());
}

/* --------------------------------- payouts --------------------------------- */

export async function renderPayouts(root) {
  root.innerHTML = `
    <div class="page-head"><div><h1>Payouts</h1><p>When your money comes back to you.</p></div></div>
    <div class="card card-body">${skeletonLines(5)}</div>`;

  try {
    const { groups } = await api.get('/groups');
    const active = groups.filter((g) => g.membership.status === 'active');
    if (!active.length) {
      root.querySelector('.card').outerHTML = `<div class="card">${emptyState({
        icon: 'gift',
        title: 'No payouts yet',
        message: 'Join or create a SUSU group to start a payout rotation.',
        action: '<button class="btn" data-nav="/groups/create">Create SUSU Group</button>',
      })}</div>`;
      return;
    }

    const results = await Promise.all(active.map(async (group) => {
      const { payouts } = await api.get(`/groups/${group._id}/payouts`);
      return { group, payouts };
    }));

    root.querySelector('.card').outerHTML = results.map(({ group, payouts }) => `
      <div class="card" style="margin-bottom:20px">
        <div class="card-head"><h3>${escape(group.name)}</h3>
          <span class="badge">${payouts.filter((p) => p.status === 'completed').length}/${payouts.length} paid</span></div>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Cycle</th><th>Recipient</th><th>Date</th><th>Amount</th><th>Status</th></tr></thead>
            <tbody>${payouts.map((p) => `
              <tr>
                <td data-label="Cycle">${p.cycle}</td>
                <td data-label="Recipient"><div class="row">
                  ${avatar(p.recipientId?.firstName, p.recipientId?.lastName, p.recipientId?.avatarUrl, 'avatar-sm')}
                  <span>${escape(`${p.recipientId?.firstName || ''} ${p.recipientId?.lastName || ''}`)}</span></div></td>
                <td data-label="Date">${date(p.scheduledDate)}<div class="tiny muted">${relative(p.scheduledDate)}</div></td>
                <td data-label="Amount">${money(p.status === 'completed' ? p.netAmountMinor : p.expectedAmountMinor)}</td>
                <td data-label="Status">${statusBadge(p.status)}</td>
              </tr>`).join('')}</tbody>
          </table>
        </div>
      </div>`).join('');
  } catch (err) {
    root.querySelector('.card').outerHTML = errorState(err.message);
  }
}

export { transactionRow };
