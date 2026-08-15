/** Page script for login. Kept in its own file because the app's
 *  Content-Security-Policy allows scripts from 'self' only —
 *  an inline <script> is blocked by the browser and never runs. */

import { initTheme, mountThemeToggle } from '../core/theme.js';
import { api, setToken, showError, submitting, nextDestination, redirectIfSignedIn, clearMessages } from '/js/auth.js';

initTheme();
mountThemeToggle('#theme-slot');

document.getElementById('year').textContent = new Date().getFullYear();
redirectIfSignedIn();

document.getElementById('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  clearMessages();
  const button = event.target.querySelector('button[type="submit"]');
  const restore = submitting(button, 'Signing in…');

  try {
    const data = await api.post('/auth/login', {
      email: document.getElementById('email').value.trim(),
      password: document.getElementById('password').value,
    });
    setToken(data.accessToken);
    window.location.href = data.user.role === 'super_admin' ? '/admin' : nextDestination();
  } catch (err) {
    showError(err.message);
    restore();
  }
});
