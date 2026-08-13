/** Notifications, profile, settings, support, organization members and reports. */

import { api } from '../core/api.js';
import { money, date, dateTime, escape, statusBadge, titleCase, relative } from '../core/format.js';
import {
  icon, emptyState, errorState, skeletonLines, toastSuccess, toastError, modal, buttonLoading, avatar,
} from '../core/ui.js';
import { state, loadProfile, isOrgAdmin, isSuperAdmin } from '../core/store.js';

/* ------------------------------ notifications ------------------------------ */

export async function renderNotifications(root) {
  root.innerHTML = `
    <div class="page-head">
      <div><h1>Notifications</h1><p>Reminders, payouts and account activity.</p></div>
      <button class="btn btn-secondary" data-action="read-all">Mark all as read</button>
    </div>
    <div class="card">${skeletonLines(6)}</div>`;

  const load = async () => {
    try {
      const { notifications } = await api.get('/notifications', { limit: 50 });
      const groups = { Today: [], Yesterday: [], Earlier: [] };
      notifications.forEach((n) => {
        const label = relative(n.createdAt);
        groups[label === 'Today' ? 'Today' : label === 'Yesterday' ? 'Yesterday' : 'Earlier'].push(n);
      });

      root.querySelector('.card').innerHTML = notifications.length
        ? Object.entries(groups).filter(([, items]) => items.length).map(([label, items]) => `
            <div class="card-head" style="background:var(--surface-alt)"><h3 style="font-size:0.8125rem">${label}</h3></div>
            ${items.map((n) => `
              <div class="txn" data-read="${n._id}" ${n.link ? `data-nav="${escape(n.link)}"` : ''}>
                <div class="txn-icon ${n.readAt ? 'neutral' : 'in'}">${icon(n.icon || 'bell', 'icon icon-sm')}</div>
                <div class="info">
                  <div class="desc">${escape(n.title)} ${n.readAt ? '' : '<span class="badge badge-purple">New</span>'}</div>
                  <div class="time">${escape(n.body)}</div>
                </div>
                <div class="tiny muted nowrap">${dateTime(n.createdAt)}</div>
              </div>`).join('')}`).join('')
        : emptyState({ icon: 'bell', title: 'No notifications', message: 'Reminders about contributions and payouts will appear here.' });

      root.querySelectorAll('[data-read]').forEach((el) => el.addEventListener('click', () => {
        api.post(`/notifications/${el.dataset.read}/read`).catch(() => {});
      }));
    } catch (err) {
      root.querySelector('.card').innerHTML = errorState(err.message);
    }
  };

  root.querySelector('[data-action="read-all"]').addEventListener('click', async (e) => {
    const restore = buttonLoading(e.target);
    try {
      await api.post('/notifications/read-all');
      toastSuccess('All notifications marked as read');
      await load();
    } finally {
      restore();
    }
  });

  load();
}

/* --------------------------------- profile --------------------------------- */

export async function renderProfile(root) {
  const user = state.user;
  root.innerHTML = `
    <div class="page-head"><div><h1>My Profile</h1><p>Your account details and security.</p></div></div>

    <div class="dash-grid">
      <div class="card">
        <div class="card-head"><h3>Profile details</h3></div>
        <div class="card-body">
          <div class="row" style="margin-bottom:24px">
            ${avatar(user.firstName, user.lastName, user.avatarUrl, 'avatar-xl')}
            <div>
              <h3>${escape(user.firstName)} ${escape(user.lastName)}</h3>
              <div class="small muted">${escape(user.email)}</div>
              <div class="row" style="margin-top:8px">
                ${statusBadge(user.status)}
                <span class="badge">${titleCase(user.role)}</span>
                ${user.emailVerified ? '<span class="badge badge-success">Email verified</span>' : '<span class="badge badge-warning">Email unverified</span>'}
              </div>
            </div>
          </div>

          <form id="profile-form">
            <div class="row wrap" style="gap:16px">
              <div class="field grow"><label for="firstName">First name</label>
                <input class="input" id="firstName" value="${escape(user.firstName)}"></div>
              <div class="field grow"><label for="lastName">Last name</label>
                <input class="input" id="lastName" value="${escape(user.lastName)}"></div>
            </div>
            <div class="row wrap" style="gap:16px">
              <div class="field grow"><label for="phone">Phone</label>
                <input class="input" id="phone" value="${escape(user.phone || '')}"></div>
              <div class="field grow"><label for="region">Region / city</label>
                <input class="input" id="region" value="${escape(user.region || '')}"></div>
            </div>
            <button class="btn" type="submit">Save changes</button>
          </form>
        </div>
      </div>

      <div class="dash-col">
        <div class="card">
          <div class="card-head"><h3>Security</h3></div>
          <div class="card-body">
            <form id="password-form">
              <div class="field"><label for="currentPassword">Current password</label>
                <input class="input" id="currentPassword" type="password" autocomplete="current-password"></div>
              <div class="field"><label for="newPassword">New password</label>
                <input class="input" id="newPassword" type="password" autocomplete="new-password">
                <span class="hint">At least 8 characters, with letters and numbers.</span></div>
              <button class="btn btn-secondary" type="submit">Change password</button>
            </form>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>Notification preferences</h3></div>
          <div class="card-body col">
            ${['email', 'sms', 'push'].map((channel) => `
              <label class="checkbox">
                <input type="checkbox" data-pref="${channel}" ${user.notificationPreferences?.[channel] ? 'checked' : ''}>
                <span>${titleCase(channel)} notifications</span>
              </label>`).join('')}
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>Account</h3></div>
          <div class="card-body">
            <div class="review-list">
              <div class="review-row"><span class="k">Member since</span><span class="v">${date(user.createdAt)}</span></div>
              <div class="review-row"><span class="k">Last sign-in</span><span class="v">${user.lastLoginAt ? dateTime(user.lastLoginAt) : '—'}</span></div>
              <div class="review-row"><span class="k">Country</span><span class="v">${escape(user.country || '—')}</span></div>
              ${state.organization ? `<div class="review-row"><span class="k">Organization</span><span class="v">${escape(state.organization.name)}</span></div>` : ''}
            </div>
          </div>
        </div>
      </div>
    </div>`;

  root.querySelector('#profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const restore = buttonLoading(e.target.querySelector('button'));
    try {
      await api.patch('/users/me', {
        firstName: root.querySelector('#firstName').value,
        lastName: root.querySelector('#lastName').value,
        phone: root.querySelector('#phone').value,
        region: root.querySelector('#region').value,
      });
      await loadProfile();
      toastSuccess('Profile updated');
    } catch (err) {
      toastError(err.message);
    } finally {
      restore();
    }
  });

  root.querySelector('#password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const restore = buttonLoading(e.target.querySelector('button'));
    try {
      await api.post('/users/me/password', {
        currentPassword: root.querySelector('#currentPassword').value,
        newPassword: root.querySelector('#newPassword').value,
      });
      toastSuccess('Password changed');
      e.target.reset();
    } catch (err) {
      toastError(err.message);
    } finally {
      restore();
    }
  });

  root.querySelectorAll('[data-pref]').forEach((box) => box.addEventListener('change', async () => {
    const prefs = {};
    root.querySelectorAll('[data-pref]').forEach((b) => { prefs[b.dataset.pref] = b.checked; });
    try {
      await api.patch('/users/me', { notificationPreferences: prefs });
      await loadProfile();
      toastSuccess('Preferences saved');
    } catch (err) {
      toastError(err.message);
    }
  }));
}

/* --------------------------------- settings -------------------------------- */

export async function renderSettings(root, { navigate }) {
  const settings = state.settings || {};
  root.innerHTML = `
    <div class="page-head"><div><h1>Settings</h1><p>Platform information and your account controls.</p></div></div>

    <div class="dash-grid">
      <div class="card">
        <div class="card-head"><h3>Fees on this platform</h3></div>
        <div class="card-body">
          <p class="small muted" style="margin-bottom:16px">
            These are the charges applied to your savings. They are set by the platform and shown before every transaction.
          </p>
          <div class="review-list">
            <div class="review-row"><span class="k">Registration fee</span><span class="v">${money(settings.registrationFeeMinor)}</span></div>
            <div class="review-row"><span class="k">Monthly platform fee</span><span class="v">${money(settings.monthlyPlatformFeeMinor)}</span></div>
            <div class="review-row"><span class="k">Savings service fee</span><span class="v">${settings.savingsFeePercent}%</span></div>
            <div class="review-row"><span class="k">Withdrawal fee</span>
              <span class="v">${settings.withdrawalFeePercent}% + ${money(settings.withdrawalFlatFeeMinor)}</span></div>
            <div class="review-row"><span class="k">Minimum withdrawal</span><span class="v">${money(settings.limits?.minWithdrawalMinor)}</span></div>
            <div class="review-row"><span class="k">Maximum withdrawal</span><span class="v">${money(settings.limits?.maxWithdrawalMinor)}</span></div>
          </div>
          <div class="card card-body" style="margin-top:16px;background:var(--purple-50);border-color:var(--purple-100)">
            <div class="small"><span class="strong">Example.</span> Save ${money(100000)} and a
            ${settings.savingsFeePercent}% service fee of ${money(Math.round(100000 * (settings.savingsFeePercent || 0) / 100))}
            applies, leaving ${money(100000 - Math.round(100000 * (settings.savingsFeePercent || 0) / 100))} in your group pool.</div>
          </div>
        </div>
      </div>

      <div class="dash-col">
        <div class="card">
          <div class="card-head"><h3>Quick links</h3></div>
          <div class="card-body col">
            <button class="btn btn-secondary btn-block" data-nav="/profile">Profile and security</button>
            <button class="btn btn-secondary btn-block" data-nav="/support">Help and support</button>
            ${isOrgAdmin() ? '<button class="btn btn-secondary btn-block" data-nav="/members">Organization members</button>' : ''}
            ${isSuperAdmin() ? '<button class="btn btn-block" onclick="window.location.href=\'/admin\'">Open admin console</button>' : ''}
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>Support</h3></div>
          <div class="card-body">
            <div class="review-list">
              <div class="review-row"><span class="k">Email</span><span class="v">${escape(settings.support?.email || '')}</span></div>
              <div class="review-row"><span class="k">Phone</span><span class="v">${escape(settings.support?.phone || '')}</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>`;
}

/* --------------------------------- support --------------------------------- */

export async function renderSupport(root) {
  root.innerHTML = `
    <div class="page-head">
      <div><h1>Help & Support</h1><p>We usually reply within one working day.</p></div>
      <button class="btn" data-action="new-ticket">${icon('plus')} New ticket</button>
    </div>

    <div class="dash-grid">
      <div class="card">
        <div class="card-head"><h3>Your tickets</h3></div>
        <div id="tickets">${skeletonLines(4)}</div>
      </div>

      <div class="card">
        <div class="card-head"><h3>Frequently asked</h3></div>
        <div class="card-body col">
          ${[
    ['How does a SUSU group work?', 'Every member contributes the same amount each cycle. The full pool is paid to one member per cycle, following the payout order, until everyone has received a payout.'],
    ['When can I withdraw?', 'Money in your wallet can be withdrawn any time. Money inside a savings plan is released after its lock period, which is shown on the plan.'],
    ['What fees do I pay?', 'A service fee on savings and a withdrawal fee. Both are shown before you confirm any transaction, and are listed in full under Settings.'],
    ['What if I miss a contribution?', 'The cycle is marked as missed and you will be reminded. Your organizer can see outstanding amounts; group payouts may be held until the pool is complete.'],
  ].map(([q, a]) => `
            <details style="border:1px solid var(--border);border-radius:12px;padding:12px 14px">
              <summary style="cursor:pointer;font-weight:600">${q}</summary>
              <p class="small muted" style="margin-top:8px">${a}</p>
            </details>`).join('')}
        </div>
      </div>
    </div>`;

  const load = async () => {
    try {
      const { tickets } = await api.get('/support/tickets');
      root.querySelector('#tickets').innerHTML = tickets.length
        ? tickets.map((t) => `
          <div class="txn">
            <div class="txn-icon neutral">${icon('help-circle', 'icon icon-sm')}</div>
            <div class="info">
              <div class="desc">${escape(t.subject)}</div>
              <div class="time">${escape(t.reference)} · ${dateTime(t.createdAt)}</div>
            </div>
            ${statusBadge(t.status)}
          </div>`).join('')
        : emptyState({ icon: 'inbox', title: 'No tickets yet', message: 'Open a ticket and our team will get back to you.' });
    } catch (err) {
      root.querySelector('#tickets').innerHTML = errorState(err.message);
    }
  };

  root.querySelector('[data-action="new-ticket"]').addEventListener('click', () => {
    const dialog = modal({
      title: 'Contact support',
      body: `
        <div class="field"><label for="subject">Subject</label>
          <input class="input" id="subject" maxlength="140" placeholder="I need help with a withdrawal"></div>
        <div class="field"><label for="category">Category</label>
          <select class="select" id="category">
            ${['account', 'payment', 'group', 'withdrawal', 'technical', 'other']
    .map((c) => `<option value="${c}">${titleCase(c)}</option>`).join('')}
          </select></div>
        <div class="field"><label for="message">How can we help?</label>
          <textarea class="textarea" id="message" maxlength="4000"></textarea></div>
        <div id="ticket-error" class="error"></div>`,
      footer: '<button class="btn btn-secondary" data-close>Cancel</button><button class="btn" data-submit>Send</button>',
    });
    dialog.root.querySelector('[data-submit]').addEventListener('click', async (e) => {
      const restore = buttonLoading(e.target);
      try {
        await api.post('/support/tickets', {
          subject: dialog.root.querySelector('#subject').value,
          category: dialog.root.querySelector('#category').value,
          message: dialog.root.querySelector('#message').value,
        });
        toastSuccess('Ticket created');
        dialog.close();
        load();
      } catch (err) {
        dialog.root.querySelector('#ticket-error').textContent = err.message;
        restore();
      }
    });
  });

  load();
}

/* ------------------------- organization members/reports ------------------------- */

export async function renderMembers(root) {
  if (!isOrgAdmin() && !isSuperAdmin()) {
    root.innerHTML = emptyState({
      icon: 'building',
      title: 'Organization access only',
      message: 'This page is for organization administrators.',
    });
    return;
  }

  root.innerHTML = `
    <div class="page-head">
      <div><h1>Organization Members</h1><p>${escape(state.organization?.name || 'Your organization')}</p></div>
      <button class="btn" data-action="invite">${icon('user-plus')} Invite member</button>
    </div>
    <div class="card">${skeletonLines(5)}</div>`;

  const load = async () => {
    try {
      const { members } = await api.get('/organizations/current/members');
      root.querySelector('.card').innerHTML = `
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Member</th><th>Phone</th><th>Role</th><th>Status</th><th>Joined</th><th></th></tr></thead>
            <tbody>${members.map((m) => `
              <tr>
                <td data-label="Member"><div class="row">${avatar(m.firstName, m.lastName, m.avatarUrl, 'avatar-sm')}
                  <div><div class="strong">${escape(m.firstName)} ${escape(m.lastName)}</div>
                  <div class="tiny muted">${escape(m.email)}</div></div></div></td>
                <td data-label="Phone">${escape(m.phone || '—')}</td>
                <td data-label="Role">${titleCase(m.role)}</td>
                <td data-label="Status">${statusBadge(m.status)}</td>
                <td data-label="Joined">${date(m.createdAt)}</td>
                <td data-label="">
                  <button class="btn btn-ghost btn-sm" data-suspend="${m._id}" data-active="${m.status === 'active'}">
                    ${m.status === 'active' ? 'Suspend' : 'Activate'}</button>
                </td>
              </tr>`).join('')}</tbody>
          </table>
        </div>`;

      root.querySelectorAll('[data-suspend]').forEach((btn) => btn.addEventListener('click', async () => {
        try {
          await api.post(`/organizations/current/members/${btn.dataset.suspend}/suspend`, {
            suspend: btn.dataset.active === 'true',
          });
          toastSuccess('Member status updated');
          load();
        } catch (err) {
          toastError(err.message);
        }
      }));
    } catch (err) {
      root.querySelector('.card').innerHTML = errorState(err.message);
    }
  };

  root.querySelector('[data-action="invite"]').addEventListener('click', () => {
    const dialog = modal({
      title: 'Invite a member',
      body: `
        <div class="field"><label for="email">Email address</label>
          <input class="input" id="email" type="email" placeholder="ama@company.com"></div>
        <div class="field"><label for="name">Name (optional)</label>
          <input class="input" id="name" placeholder="Ama Mensah"></div>
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
      } catch (err) {
        dialog.root.querySelector('#inv-error').textContent = err.message;
        restore();
      }
    });
  });

  load();
}

export async function renderReports(root) {
  root.innerHTML = `
    <div class="page-head"><div><h1>Reports</h1><p>How your savings are performing.</p></div></div>
    <div class="card card-body">${skeletonLines(5)}</div>`;

  try {
    const [dashboard, orgData] = await Promise.all([
      api.get('/dashboard'),
      (isOrgAdmin() || isSuperAdmin()) ? api.get('/my-organization').catch(() => null) : null,
    ]);

    const { summary, groups, savingsPlans } = dashboard;
    root.querySelector('.card').outerHTML = `
      <div class="stat-grid">
        <div class="stat purple"><div class="stat-icon">${icon('piggy-bank')}</div><div class="stat-label">Total saved</div>
          <div class="stat-value">${money(summary.totalSavedMinor)}</div><div class="stat-meta">All time</div></div>
        <div class="stat green"><div class="stat-icon">${icon('banknote')}</div><div class="stat-label">Total received</div>
          <div class="stat-value">${money(summary.totalReceivedMinor)}</div><div class="stat-meta">Payouts</div></div>
        <div class="stat orange"><div class="stat-icon">${icon('users')}</div><div class="stat-label">Active groups</div>
          <div class="stat-value">${summary.activeGroups}</div><div class="stat-meta">Memberships</div></div>
        <div class="stat blue"><div class="stat-icon">${icon('target')}</div><div class="stat-label">Savings goals</div>
          <div class="stat-value">${savingsPlans.length}</div><div class="stat-meta">Active plans</div></div>
      </div>

      <div class="card" style="margin-bottom:24px">
        <div class="card-head"><h3>Group performance</h3></div>
        ${groups.length ? `
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Group</th><th>Cycle</th><th>My contributions</th><th>Outstanding</th><th>Current pool</th></tr></thead>
          <tbody>${groups.map((g) => `
            <tr>
              <td data-label="Group">${escape(g.name)}</td>
              <td data-label="Cycle">${g.currentCycle} / ${g.totalCycles}</td>
              <td data-label="My contributions">${money(g.myBalanceMinor)}</td>
              <td data-label="Outstanding">${money(g.outstandingMinor)}</td>
              <td data-label="Current pool">${money(g.currentPoolMinor)}</td>
            </tr>`).join('')}</tbody>
        </table></div>` : emptyState({ icon: 'users', title: 'No groups yet', message: 'Join a group to see performance data.' })}
      </div>

      ${orgData ? `
      <div class="card">
        <div class="card-head"><h3>${escape(orgData.organization?.name || 'Organization')} overview</h3></div>
        <div class="card-body">
          <div class="review-list">
            <div class="review-row"><span class="k">Members</span><span class="v">${orgData.summary.totalMembers}</span></div>
            <div class="review-row"><span class="k">Groups</span><span class="v">${orgData.summary.totalGroups} (${orgData.summary.activeGroups} active)</span></div>
            <div class="review-row"><span class="k">Total saved</span><span class="v">${money(orgData.summary.totalSavedMinor)}</span></div>
            <div class="review-row"><span class="k">Total paid out</span><span class="v">${money(orgData.summary.totalPaidOutMinor)}</span></div>
            <div class="review-row"><span class="k">Contributions recorded</span><span class="v">${orgData.summary.contributionCount}</span></div>
          </div>
        </div>
      </div>` : ''}`;
  } catch (err) {
    root.querySelector('.card').outerHTML = errorState(err.message);
  }
}
