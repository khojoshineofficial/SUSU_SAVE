/**
 * SUSU SAVE app shell: session bootstrap, sidebar, header, and the client-side
 * router that mounts a view into #view.
 */

import { api, bootstrapSession } from './core/api.js';
import { state, setState, subscribe, loadSettings, loadProfile, isOrgAdmin, isSuperAdmin } from './core/store.js';
import { icon, avatar, toastError } from './core/ui.js';
import { greeting, escape } from './core/format.js';
import { mountBackToTop, mountCredit } from './core/chrome.js';

import { renderDashboard } from './views/dashboard.js';
import { renderGroups, renderGroupDetail, renderCreateGroup, renderJoinGroup } from './views/groups.js';
import { renderSavings, renderSavingsDetail, renderRentSavings } from './views/savings.js';
import { renderWallet, renderTransactions, renderTransactionDetail, renderPayouts } from './views/wallet.js';
import {
  renderNotifications, renderProfile, renderSettings, renderSupport, renderMembers, renderReports,
} from './views/account.js';

/* ---------------------------------- routes --------------------------------- */

const ROUTES = [
  { path: '/dashboard', view: renderDashboard, title: 'Dashboard' },
  { path: '/groups', view: renderGroups, title: 'My SUSU Groups' },
  { path: '/groups/create', view: renderCreateGroup, title: 'Create Group' },
  { path: '/groups/:id', view: renderGroupDetail, title: 'Group' },
  { path: '/join-group', view: renderJoinGroup, title: 'Join a Group' },
  { path: '/savings', view: renderSavings, title: 'My Savings' },
  { path: '/savings/:id', view: renderSavingsDetail, title: 'Savings Plan' },
  { path: '/rent-savings', view: renderRentSavings, title: 'Rent Savings' },
  { path: '/wallet', view: renderWallet, title: 'Wallet' },
  { path: '/transactions', view: renderTransactions, title: 'Transactions' },
  { path: '/transactions/:id', view: renderTransactionDetail, title: 'Transaction' },
  { path: '/payouts', view: renderPayouts, title: 'Payouts' },
  { path: '/contributions', view: renderTransactions, title: 'Contributions' },
  { path: '/notifications', view: renderNotifications, title: 'Notifications' },
  { path: '/members', view: renderMembers, title: 'Members' },
  { path: '/reports', view: renderReports, title: 'Reports' },
  { path: '/settings', view: renderSettings, title: 'Settings' },
  { path: '/profile', view: renderProfile, title: 'My Profile' },
  { path: '/support', view: renderSupport, title: 'Help & Support' },
];

function matchRoute(pathname) {
  for (const route of ROUTES) {
    const routeParts = route.path.split('/').filter(Boolean);
    const pathParts = pathname.split('/').filter(Boolean);
    if (routeParts.length !== pathParts.length) continue;

    const params = {};
    const matched = routeParts.every((part, i) => {
      if (part.startsWith(':')) { params[part.slice(1)] = decodeURIComponent(pathParts[i]); return true; }
      return part === pathParts[i];
    });
    if (matched) return { route, params };
  }
  return null;
}

/* ----------------------------------- nav ----------------------------------- */

const NAV = [
  { section: 'Main' },
  { path: '/dashboard', label: 'Dashboard', icon: 'dashboard' },
  { path: '/groups', label: 'My SUSU Groups', icon: 'users' },
  { path: '/join-group', label: 'Join SUSU Group', icon: 'user-plus' },
  { section: 'Money' },
  { path: '/savings', label: 'My Savings', icon: 'piggy-bank' },
  { path: '/rent-savings', label: 'Rent Savings', icon: 'home' },
  { path: '/wallet', label: 'Wallet', icon: 'wallet' },
  { path: '/transactions', label: 'Transactions', icon: 'receipt' },
  { path: '/payouts', label: 'Payouts', icon: 'gift' },
  { section: 'Account' },
  { path: '/notifications', label: 'Notifications', icon: 'bell', badge: 'unread' },
  { path: '/members', label: 'Members', icon: 'building', requires: 'org' },
  { path: '/reports', label: 'Reports', icon: 'pie-chart' },
  { path: '/settings', label: 'Settings', icon: 'settings' },
  { path: '/support', label: 'Help & Support', icon: 'help-circle' },
];

const MOBILE_NAV = [
  { path: '/dashboard', label: 'Home', icon: 'home' },
  { path: '/groups', label: 'Groups', icon: 'users' },
  { path: '/savings', label: 'Save', icon: 'piggy-bank' },
  { path: '/wallet', label: 'Wallet', icon: 'wallet' },
  { path: '/profile', label: 'Profile', icon: 'user' },
];

/* ---------------------------------- shell ---------------------------------- */

function renderShell() {
  document.getElementById('app').innerHTML = `
    <div class="shell">
      <aside class="sidebar" id="sidebar">
        <div class="brand">
          <div class="brand-mark">SS</div>
          <div>
            <div class="brand-name">SUSU SAVE</div>
            <div class="brand-tag">Save Together, Grow Together.</div>
          </div>
        </div>
        <nav class="nav" id="nav"></nav>
        <div class="sidebar-promo">
          <h5>Secure Your Future</h5>
          <p>Start a group and build the savings habit with people you trust.</p>
          <button class="btn btn-sm" data-nav="/groups/create">${icon('plus', 'icon icon-sm')} Create New SUSU Group</button>
        </div>
      </aside>
      <div class="sidebar-backdrop" id="backdrop"></div>

      <div class="main">
        <header class="topbar">
          <button class="icon-btn" id="menu-toggle" aria-label="Menu">${icon('menu')}</button>
          <div class="greeting">
            <h2 id="greeting">Welcome</h2>
            <p id="subgreeting">Discipline today, financial freedom tomorrow.</p>
          </div>
          <div class="topbar-actions">
            <div class="dropdown" id="notif-dropdown">
              <button class="icon-btn" id="notif-btn" aria-label="Notifications">
                ${icon('bell')}<span class="dot hidden" id="notif-dot"></span>
              </button>
            </div>
            <div class="dropdown" id="user-dropdown">
              <button class="user-chip" id="user-btn">
                <span id="user-avatar"></span>
                <span>
                  <span class="name" id="user-name"></span>
                  <span class="role" id="user-role"></span>
                </span>
                ${icon('chevron-down', 'icon icon-sm')}
              </button>
            </div>
          </div>
        </header>
        <main class="content" id="view"></main>
        <footer id="app-credit"></footer>
      </div>
    </div>

    <nav class="mobile-nav" id="mobile-nav"></nav>
    <button class="fab" data-nav="/wallet" aria-label="Save money">${icon('plus')}</button>`;
}

function paintNav(currentPath) {
  const nav = document.getElementById('nav');
  nav.innerHTML = NAV.filter((item) => {
    if (item.requires === 'org') return isOrgAdmin() || isSuperAdmin();
    return true;
  }).map((item) => {
    if (item.section) return `<div class="nav-label">${item.section}</div>`;
    const active = currentPath === item.path || (item.path !== '/dashboard' && currentPath.startsWith(`${item.path}/`));
    const badge = item.badge === 'unread' && state.unreadNotifications
      ? `<span class="count">${state.unreadNotifications}</span>` : '';
    return `<button class="nav-item ${active ? 'active' : ''}" data-nav="${item.path}">
      ${icon(item.icon)} <span>${item.label}</span> ${badge}</button>`;
  }).join('');

  document.getElementById('mobile-nav').innerHTML = MOBILE_NAV.map((item) => `
    <button data-nav="${item.path}" class="${currentPath === item.path ? 'active' : ''}">
      ${icon(item.icon, 'icon icon-sm')}<span>${item.label}</span>
    </button>`).join('');

  if (isSuperAdmin()) {
    nav.insertAdjacentHTML('beforeend', `
      <div class="nav-label">Platform</div>
      <button class="nav-item" data-href="/admin">${icon('shield')} <span>Admin Console</span></button>`);
  }
}

function paintUser() {
  const user = state.user;
  if (!user) return;
  document.getElementById('greeting').textContent = greeting(user.firstName);
  document.getElementById('user-avatar').innerHTML = avatar(user.firstName, user.lastName, user.avatarUrl, 'avatar-sm');
  document.getElementById('user-name').textContent = `${user.firstName} ${user.lastName}`;
  document.getElementById('user-role').textContent = state.organization?.name
    || (user.role === 'super_admin' ? 'Platform Admin' : 'Personal account');
  document.getElementById('notif-dot').classList.toggle('hidden', !state.unreadNotifications);
}

/* ---------------------------------- router --------------------------------- */

let currentPath = '';

export function navigate(path, { replace = false } = {}) {
  if (replace) window.history.replaceState({}, '', path);
  else window.history.pushState({}, '', path);
  render();
}

async function render() {
  const pathname = window.location.pathname === '/' ? '/dashboard' : window.location.pathname;
  currentPath = pathname;

  const match = matchRoute(pathname);
  const view = document.getElementById('view');
  paintNav(pathname);

  if (!match) {
    view.innerHTML = `
      <div class="empty">
        <div class="empty-icon">${icon('search', 'icon icon-lg')}</div>
        <h4>Page not found</h4>
        <p>The page <code>${escape(pathname)}</code> does not exist.</p>
        <button class="btn" data-nav="/dashboard">Back to dashboard</button>
      </div>`;
    return;
  }

  document.title = `${match.route.title} · SUSU SAVE`;
  const query = Object.fromEntries(new URLSearchParams(window.location.search));
  view.scrollTop = 0;
  window.scrollTo(0, 0);

  try {
    await match.route.view(view, { params: match.params, navigate, query });
  } catch (err) {
    view.innerHTML = `<div class="empty"><h4>Something went wrong</h4><p>${escape(err.message)}</p></div>`;
  }
}

/* -------------------------------- interactions ------------------------------ */

function wireGlobalHandlers() {
  // A single delegated handler powers every [data-nav] element in the app.
  document.addEventListener('click', (e) => {
    const target = e.target.closest('[data-nav]');
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    navigate(target.dataset.nav);
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('backdrop').classList.remove('open');
  });

  // Full page navigations (crossing between the app shell and the admin shell).
  document.addEventListener('click', (e) => {
    const target = e.target.closest('[data-href]');
    if (!target) return;
    e.preventDefault();
    window.location.href = target.dataset.href;
  });

  window.addEventListener('popstate', render);

  document.getElementById('menu-toggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('backdrop').classList.toggle('open');
  });
  document.getElementById('backdrop').addEventListener('click', () => {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('backdrop').classList.remove('open');
  });

  document.getElementById('user-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleDropdown('user-dropdown', `
      <div style="padding:12px 12px 8px">
        <div class="strong small">${escape(state.user.firstName)} ${escape(state.user.lastName)}</div>
        <div class="tiny muted">${escape(state.user.email)}</div>
      </div>
      <hr class="divider" style="margin:4px 0">
      <button class="dropdown-item" data-nav="/profile">${icon('user', 'icon icon-sm')} My profile</button>
      <button class="dropdown-item" data-nav="/wallet">${icon('wallet', 'icon icon-sm')} Wallet</button>
      <button class="dropdown-item" data-nav="/settings">${icon('settings', 'icon icon-sm')} Settings</button>
      <hr class="divider" style="margin:4px 0">
      <button class="dropdown-item danger" id="logout">${icon('log-out', 'icon icon-sm')} Sign out</button>`);

    document.getElementById('logout')?.addEventListener('click', async () => {
      await api.post('/auth/logout').catch(() => {});
      window.location.href = '/login';
    });
  });

  document.getElementById('notif-btn').addEventListener('click', async (e) => {
    e.stopPropagation();
    toggleDropdown('notif-dropdown', '<div style="padding:16px" class="muted small">Loading…</div>', 'wide');
    try {
      const { notifications } = await api.get('/notifications', { limit: 6 });
      const menu = document.querySelector('#notif-dropdown .dropdown-menu');
      if (!menu) return;
      menu.innerHTML = `
        <div class="card-head"><h3 style="font-size:0.875rem">Notifications</h3>
          <button class="btn btn-ghost btn-sm" id="read-all">Mark all read</button></div>
        <div style="max-height:340px;overflow-y:auto">
          ${notifications.length ? notifications.map((n) => `
            <div class="txn" data-nav="${escape(n.link || '/notifications')}">
              <div class="txn-icon ${n.readAt ? 'neutral' : 'in'}">${icon(n.icon || 'bell', 'icon icon-sm')}</div>
              <div class="info"><div class="desc">${escape(n.title)}</div>
              <div class="time truncate">${escape(n.body)}</div></div>
            </div>`).join('')
    : '<div style="padding:24px" class="center muted small">No notifications yet</div>'}
        </div>
        <div style="padding:10px"><button class="btn btn-secondary btn-block btn-sm" data-nav="/notifications">View all</button></div>`;

      document.getElementById('read-all')?.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        await api.post('/notifications/read-all').catch(() => {});
        setState({ unreadNotifications: 0 });
        paintUser();
        paintNav(currentPath);
      });
    } catch { /* dropdown stays with its loading text */ }
  });

  document.addEventListener('click', () => {
    document.querySelectorAll('.dropdown-menu').forEach((menu) => menu.remove());
  });

  window.addEventListener('susu:session-expired', () => {
    toastError('Please sign in again', 'Session expired');
    setTimeout(() => { window.location.href = '/login'; }, 1200);
  });
}

function toggleDropdown(hostId, html, extraClass = '') {
  const existing = document.querySelector(`#${hostId} .dropdown-menu`);
  document.querySelectorAll('.dropdown-menu').forEach((menu) => menu.remove());
  if (existing) return;

  const menu = document.createElement('div');
  menu.className = `dropdown-menu ${extraClass}`;
  menu.innerHTML = html;
  menu.addEventListener('click', (e) => e.stopPropagation());
  document.getElementById(hostId).appendChild(menu);
}

/* ----------------------------------- boot ---------------------------------- */

async function boot() {
  const user = await bootstrapSession();
  if (!user) {
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
    return;
  }

  renderShell();
  wireGlobalHandlers();
  mountBackToTop();
  mountCredit('#app-credit');

  await Promise.all([
    loadSettings().catch(() => {}),
    loadProfile().catch(() => {}),
  ]);

  // Unread count drives the sidebar badge and the header dot.
  api.get('/notifications', { unread: 'true', limit: 1 })
    .then(({ unread }) => { setState({ unreadNotifications: unread }); paintUser(); paintNav(currentPath); })
    .catch(() => {});

  subscribe(paintUser);
  paintUser();
  await render();
}

boot();
