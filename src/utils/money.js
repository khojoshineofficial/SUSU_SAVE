'use strict';

const env = require('../config/env');

/**
 * Money is stored everywhere in the database as an INTEGER number of minor
 * units (pesewas for GHS). Floating point is never used to hold a balance —
 * it appears only at the display boundary. All helpers here take and return
 * minor units unless the name says otherwise.
 */

const MINOR_UNITS_PER_MAJOR = 100;

/** Convert a user-supplied major amount ("20.50") to minor units (2050). */
function toMinor(major) {
  if (major === null || major === undefined || major === '') {
    throw new TypeError('Amount is required');
  }
  const value = typeof major === 'string' ? Number(major.replace(/[, ]/g, '')) : Number(major);
  if (!Number.isFinite(value)) throw new TypeError(`Invalid amount: ${major}`);
  // Round through a string to avoid 20.29 * 100 === 2028.9999999999998
  return Math.round(Number(value.toFixed(2)) * MINOR_UNITS_PER_MAJOR);
}

/** Convert minor units back to a major-unit number for display/serialisation. */
function toMajor(minor) {
  return Number(assertMinor(minor)) / MINOR_UNITS_PER_MAJOR;
}

function assertMinor(minor) {
  if (!Number.isInteger(minor)) {
    throw new TypeError(`Money must be an integer number of minor units, got: ${minor}`);
  }
  return minor;
}

const add = (...amounts) => amounts.reduce((sum, a) => sum + assertMinor(a), 0);
const subtract = (a, b) => assertMinor(a) - assertMinor(b);
const multiply = (amount, factor) => Math.round(assertMinor(amount) * factor);

/** Percentage fee, e.g. percentOf(100_00, 1.5) === 150 (GH₵1.50). */
const percentOf = (amount, percent) => Math.round((assertMinor(amount) * Number(percent)) / 100);

const clampNonNegative = (amount) => Math.max(0, assertMinor(amount));

/** Format for humans: 854000 -> "GH₵8,540.00". */
function format(minor, { symbol = env.currencySymbol, withSymbol = true } = {}) {
  const negative = minor < 0;
  const text = (Math.abs(toMajor(minor))).toLocaleString('en-GH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${negative ? '-' : ''}${withSymbol ? symbol : ''}${text}`;
}

module.exports = {
  MINOR_UNITS_PER_MAJOR,
  toMinor,
  toMajor,
  add,
  subtract,
  multiply,
  percentOf,
  clampNonNegative,
  format,
};
