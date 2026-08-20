/** Page script for /join/<code> — signing up through a collector's link.
 *  A separate file because the app's Content-Security-Policy allows scripts
 *  from 'self' only, so an inline <script> is blocked and never runs. */

import { api, setToken, showError, showSuccess, submitting, clearMessages, redirectIfSignedIn } from '/js/auth.js';
import { mountMaintenanceBanner } from '../core/chrome.js';

mountMaintenanceBanner();
document.getElementById('year').textContent = new Date().getFullYear();
redirectIfSignedIn();

const money = (minor) => `GH₵${(Number(minor || 0) / 100).toLocaleString('en-GH', { minimumFractionDigits: 2 })}`;
const escape = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The code is the last path segment: /join/ABCD2345 */
const joinCode = decodeURIComponent(window.location.pathname.split('/').filter(Boolean).pop() || '');

const card = document.getElementById('collector-card');
const fields = document.getElementById('fields');

/* ------------------------- who does this link belong to? ------------------- */

api.get(`/collectors/${encodeURIComponent(joinCode)}`)
  .then(({ collector }) => {
    const where = [collector.region, collector.type && collector.type !== 'other' ? collector.type : null]
      .filter(Boolean).join(' · ');

    card.innerHTML = `
      <div class="tiny muted" style="text-transform:uppercase;letter-spacing:.06em">You are joining</div>
      <div class="strong" style="font-size:18px;margin-top:2px">${escape(collector.name)}</div>
      ${collector.collectorName ? `<div class="small muted">Collector: ${escape(collector.collectorName)}</div>` : ''}
      ${where ? `<div class="tiny muted">${escape(where)}</div>` : ''}`;

    document.getElementById('collector-pitch').textContent =
      `${collector.name} uses SUSU SAVE to keep your savings on the record. Create your account to deposit and check your balance whenever you want.`;
    document.getElementById('sub').textContent = `Your account will be linked to ${collector.name}.`;
    fields.classList.remove('hidden');
  })
  .catch((err) => {
    card.innerHTML = `<div class="strong small">This link is not valid.</div>
      <div class="small muted" style="margin-top:4px">${escape(err.message)}</div>
      <div class="small muted" style="margin-top:8px">Ask your collector for a new link, or
      <a href="/register">create an account on your own</a>.</div>`;
    document.getElementById('collector-pitch').textContent =
      'This sign-up link is no longer active. You can still create an account on your own.';
  });

// Fees come from the platform configuration, never hard-coded here.
api.get('/settings/public').then((settings) => {
  const fee = settings.registrationFeeMinor;
  document.getElementById('fee-note').innerHTML = fee
    ? `<div class="small"><span class="strong">Registration fee: ${money(fee)}.</span>
       After signing up you will be asked to pay this once with mobile money. Your account activates
       as soon as the payment is confirmed.</div>`
    : '<div class="small"><span class="strong">Registration is free.</span> You can start saving right away.</div>';
}).catch(() => { document.getElementById('fee-note')?.remove(); });

/* --------------------------------- sign up --------------------------------- */

document.getElementById('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  clearMessages();

  const password = document.getElementById('password').value;
  if (password !== document.getElementById('confirmPassword').value) {
    showError('The two passwords do not match.');
    return;
  }
  if (!document.getElementById('terms').checked) {
    showError('Please accept the Terms of Service to continue.');
    return;
  }

  const button = event.target.querySelector('button[type="submit"]');
  const restore = submitting(button, 'Creating account…');

  try {
    const data = await api.post('/auth/register', {
      accountType: 'personal',
      joinCode,
      firstName: document.getElementById('firstName').value.trim(),
      lastName: document.getElementById('lastName').value.trim(),
      email: document.getElementById('email').value.trim(),
      phone: document.getElementById('phone').value.trim(),
      password,
      region: document.getElementById('region').value.trim(),
    });

    setToken(data.accessToken);

    if (data.payment?.checkoutUrl) {
      // A hosted gateway: the fee is only paid if the customer goes to checkout.
      showSuccess(`Account created. Taking you to pay the ${money(data.payment.amountMinor)} registration fee…`);
      setTimeout(() => { window.location.href = data.payment.checkoutUrl; }, 900);
    } else if (data.payment) {
      showSuccess(`Account created. Your registration fee of ${money(data.payment.amountMinor)} is pending — approve it on your phone.`);
      setTimeout(() => { window.location.href = '/wallet'; }, 1800);
    } else {
      window.location.href = '/dashboard';
    }
  } catch (err) {
    showError(err.details ? Object.values(err.details)[0] : err.message);
    restore();
  }
});
