import { mountMaintenanceBanner } from '../core/chrome.js';

mountMaintenanceBanner();

/** Page script for reset-password. Kept in its own file because the app's
 *  Content-Security-Policy allows scripts from 'self' only —
 *  an inline <script> is blocked by the browser and never runs. */

import { api, showError, showSuccess, submitting, clearMessages } from '/js/auth.js';
document.getElementById('year').textContent = new Date().getFullYear();

const token = new URLSearchParams(window.location.search).get('token');
if (!token) showError('This reset link is missing its token. Request a new link from the sign-in page.');

document.getElementById('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  clearMessages();
  const password = document.getElementById('password').value;
  if (password !== document.getElementById('confirmPassword').value) {
    showError('The two passwords do not match.');
    return;
  }

  const button = event.target.querySelector('button');
  const restore = submitting(button, 'Updating…');
  try {
    await api.post('/auth/reset-password', { token, password });
    showSuccess('Password updated. Redirecting you to sign in…');
    setTimeout(() => { window.location.href = '/login'; }, 1600);
  } catch (err) {
    showError(err.message);
    restore();
  }
});
