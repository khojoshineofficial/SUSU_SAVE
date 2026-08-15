import { mountMaintenanceBanner } from '../core/chrome.js';

mountMaintenanceBanner();

/** Page script for register. Kept in its own file because the app's
 *  Content-Security-Policy allows scripts from 'self' only —
 *  an inline <script> is blocked by the browser and never runs. */

import { api, setToken, showError, showSuccess, submitting, clearMessages, redirectIfSignedIn } from '/js/auth.js';

document.getElementById('year').textContent = new Date().getFullYear();
redirectIfSignedIn();

const money = (minor) => `GH₵${(Number(minor || 0) / 100).toLocaleString('en-GH', { minimumFractionDigits: 2 })}`;

// Fees are read from the platform configuration, never hard-coded here.
api.get('/settings/public').then((settings) => {
  const fee = settings.registrationFeeMinor;
  document.getElementById('fee-note').innerHTML = fee
    ? `<div class="small"><span class="strong">Registration fee: ${money(fee)}.</span>
       After signing up you will be asked to pay this once with mobile money. Your account activates
       as soon as the payment is confirmed.</div>`
    : '<div class="small"><span class="strong">Registration is free.</span> You can start saving right away.</div>';
}).catch(() => { document.getElementById('fee-note').remove(); });

document.querySelectorAll('.radio-card').forEach((card) => card.addEventListener('click', () => {
  document.querySelectorAll('.radio-card').forEach((c) => c.classList.remove('selected'));
  card.classList.add('selected');
  document.getElementById('org-fields').classList.toggle('hidden', card.dataset.type !== 'organization');
}));

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

  const accountType = document.querySelector('input[name="accountType"]:checked').value;
  const button = event.target.querySelector('button[type="submit"]');
  const restore = submitting(button, 'Creating account…');

  try {
    const data = await api.post('/auth/register', {
      accountType,
      firstName: document.getElementById('firstName').value.trim(),
      lastName: document.getElementById('lastName').value.trim(),
      email: document.getElementById('email').value.trim(),
      phone: document.getElementById('phone').value.trim(),
      password,
      region: document.getElementById('region').value.trim(),
      organizationName: document.getElementById('organizationName')?.value.trim(),
      organizationType: document.getElementById('organizationType')?.value,
    });

    setToken(data.accessToken);

    if (data.payment) {
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
