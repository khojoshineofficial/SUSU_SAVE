/** Tiny shared state container for the app shell. */

import { api } from './api.js';
import { setCurrencySymbol } from './format.js';

const listeners = new Set();

export const state = {
  user: null,
  organization: null,
  wallet: null,
  settings: null,
  unreadNotifications: 0,
};

export function setState(patch) {
  Object.assign(state, patch);
  listeners.forEach((fn) => fn(state));
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function loadSettings() {
  const settings = await api.get('/settings/public');
  setCurrencySymbol(settings.currencySymbol);
  setState({ settings });
  return settings;
}

export async function loadProfile() {
  const data = await api.get('/users/me');
  setState({ user: data.user, organization: data.organization, wallet: data.wallet });
  return data;
}

export const isSuperAdmin = () => state.user?.role === 'super_admin';
export const isOrgAdmin = () => state.user?.role === 'org_admin';
