/**
 * Display formatting. Money arrives from the API as integer minor units
 * (pesewas) and is only ever divided at the moment it is rendered.
 */

let symbol = 'GH₵';

export const setCurrencySymbol = (value) => { symbol = value || symbol; };

/** 854000 → "GH₵8,540.00" */
export function money(minor, { withSymbol = true, signed = false } = {}) {
  const value = Number(minor || 0) / 100;
  const text = Math.abs(value).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sign = signed ? (value < 0 ? '-' : '+') : (value < 0 ? '-' : '');
  return `${sign}${withSymbol ? symbol : ''}${text}`;
}

/** Compact form for tight cards: 1234500 → "GH₵12.3k" */
export function moneyShort(minor) {
  const value = Number(minor || 0) / 100;
  if (Math.abs(value) >= 1_000_000) return `${symbol}${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 10_000) return `${symbol}${(value / 1000).toFixed(1)}k`;
  return money(minor);
}

export const toMinor = (major) => Math.round(Number(String(major).replace(/[, ]/g, '')) * 100);

export function date(value, style = 'medium') {
  if (!value) return '—';
  const d = new Date(value);
  if (style === 'short') return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  if (style === 'long') return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function dateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  const today = new Date();
  const isToday = d.toDateString() === today.toDateString();
  const yesterday = new Date(today.getTime() - 86400000);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  const time = d.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true });

  if (isToday) return `Today, ${time}`;
  if (isYesterday) return `Yesterday, ${time}`;
  return `${date(value)}, ${time}`;
}

/** "In 5 days" / "Today" / "3 days ago" */
export function relative(value) {
  if (!value) return '—';
  const days = Math.round((new Date(value).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  return days > 0 ? `In ${days} days` : `${Math.abs(days)} days ago`;
}

export const initials = (first = '', last = '') =>
  `${String(first)[0] || ''}${String(last)[0] || ''}`.toUpperCase() || '?';

export const titleCase = (text = '') =>
  String(text).replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export const percent = (value) => `${Math.round((Number(value) || 0) * 10) / 10}%`;

export function greeting(name = '') {
  const hour = new Date().getHours();
  const part = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  return `Good ${part}${name ? `, ${name}` : ''}! 👋`;
}

const STATUS_TONES = {
  successful: 'success', paid: 'success', completed: 'success', active: 'success', approved: 'success',
  pending: 'warning', partial: 'warning', scheduled: 'warning', on_hold: 'warning', recruiting: 'warning',
  pending_payment: 'warning', pending_verification: 'warning', trialing: 'warning',
  processing: 'info', ready: 'info', draft: 'info', in_progress: 'info',
  failed: 'danger', missed: 'danger', rejected: 'danger', cancelled: 'danger', suspended: 'danger', late: 'danger',
};

export const statusTone = (status) => STATUS_TONES[status] || 'default';

export const statusBadge = (status) => {
  const tone = statusTone(status);
  const cls = tone === 'default' ? 'badge' : `badge badge-${tone}`;
  return `<span class="${cls} badge-dot">${titleCase(status)}</span>`;
};

/** Escapes text before it goes anywhere near innerHTML. */
export const escape = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

export const frequencyLabel = (freq) => ({
  daily: 'Daily', weekly: 'Weekly', biweekly: 'Every 2 weeks', monthly: 'Monthly',
}[freq] || titleCase(freq || ''));
