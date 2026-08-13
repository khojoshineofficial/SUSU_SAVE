'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

const startOfDay = (date) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
};

const addDays = (date, days) => new Date(startOfDay(date).getTime() + days * DAY_MS);

function addMonths(date, months) {
  const d = new Date(date);
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  // Guard against 31 Jan + 1 month landing in March.
  if (d.getDate() < day) d.setDate(0);
  return startOfDay(d);
}

/** Advance a date by one contribution period. */
function addPeriods(date, frequency, periods = 1) {
  switch (frequency) {
    case 'daily':
      return addDays(date, periods);
    case 'weekly':
      return addDays(date, periods * 7);
    case 'biweekly':
      return addDays(date, periods * 14);
    case 'monthly':
      return addMonths(date, periods);
    default:
      throw new Error(`Unsupported frequency: ${frequency}`);
  }
}

const daysBetween = (from, to) =>
  Math.round((startOfDay(to).getTime() - startOfDay(from).getTime()) / DAY_MS);

const isSameDay = (a, b) => startOfDay(a).getTime() === startOfDay(b).getTime();

/** "In 5 days" / "Today" / "3 days ago" */
function relativeLabel(target, now = new Date()) {
  const diff = daysBetween(now, target);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return diff > 0 ? `In ${diff} days` : `${Math.abs(diff)} days ago`;
}

const formatDate = (date) =>
  new Date(date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

module.exports = {
  DAY_MS,
  startOfDay,
  addDays,
  addMonths,
  addPeriods,
  daysBetween,
  isSameDay,
  relativeLabel,
  formatDate,
};
