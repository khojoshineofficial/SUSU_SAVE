/** Page script for forgot-password. Kept in its own file because the app's
 *  Content-Security-Policy allows scripts from 'self' only —
 *  an inline <script> is blocked by the browser and never runs. */

import { initTheme, mountThemeToggle } from '../core/theme.js';
import { api, showError, showSuccess, submitting, clearMessages } from '/js/auth.js';
initTheme();
mountThemeToggle('#theme-slot');

document.getElementById('year').textContent = new Date().getFullYear();

document.getElementById('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  clearMessages();
  const button = event.target.querySelector('button');
  const restore = submitting(button, 'Sending…');
  try {
    await api.post('/auth/forgot-password', { email: document.getElementById('email').value.trim() });
    showSuccess('If that account exists, a reset link is on its way. Check your inbox.');
  } catch (err) {
    showError(err.message);
  } finally {
    restore();
  }
});
