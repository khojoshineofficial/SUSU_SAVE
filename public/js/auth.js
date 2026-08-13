/** Shared helpers for the login / register / password pages. */

import { api, setToken } from './core/api.js';

export function showError(message) {
  const box = document.querySelector('.auth-error');
  if (!box) return;
  box.textContent = message;
  box.classList.add('show');
  document.querySelector('.auth-success')?.classList.remove('show');
}

export function showSuccess(message) {
  const box = document.querySelector('.auth-success');
  if (!box) return;
  box.textContent = message;
  box.classList.add('show');
  document.querySelector('.auth-error')?.classList.remove('show');
}

export const clearMessages = () => {
  document.querySelector('.auth-error')?.classList.remove('show');
  document.querySelector('.auth-success')?.classList.remove('show');
};

export function submitting(button, label = 'Please wait…') {
  const original = button.innerHTML;
  button.disabled = true;
  button.innerHTML = `<span class="spinner"></span> ${label}`;
  return () => { button.disabled = false; button.innerHTML = original; };
}

/** Where to land after signing in, honouring ?next= but never leaving the site. */
export function nextDestination(fallback = '/dashboard') {
  const next = new URLSearchParams(window.location.search).get('next');
  if (next && next.startsWith('/') && !next.startsWith('//')) return next;
  return fallback;
}

/** If a valid refresh cookie already exists, skip the auth page entirely. */
export async function redirectIfSignedIn() {
  try {
    const data = await api.refreshSession();
    if (data?.accessToken) window.location.href = nextDestination();
  } catch { /* not signed in — stay on the page */ }
}

export { api, setToken };
