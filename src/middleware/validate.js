'use strict';

const ApiError = require('../utils/apiError');

/**
 * A tiny dependency-free schema validator. Frontend validation is a courtesy;
 * this is the boundary that actually decides what enters the database.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Ghanaian mobile numbers, local (0XXXXXXXXX) or international (+233XXXXXXXXX).
const PHONE_RE = /^(?:\+?233|0)\d{9}$/;

const rules = {
  required: (value) => (value === undefined || value === null || value === '' ? 'is required' : null),
  string: (value) => (typeof value === 'string' ? null : 'must be text'),
  email: (value) => (EMAIL_RE.test(String(value)) ? null : 'must be a valid email address'),
  phone: (value) => (PHONE_RE.test(String(value).replace(/[\s-]/g, '')) ? null : 'must be a valid Ghana phone number'),
  number: (value) => (Number.isFinite(Number(value)) ? null : 'must be a number'),
  integer: (value) => (Number.isInteger(Number(value)) ? null : 'must be a whole number'),
  positive: (value) => (Number(value) > 0 ? null : 'must be greater than zero'),
  boolean: (value) => (typeof value === 'boolean' ? null : 'must be true or false'),
  date: (value) => (Number.isNaN(new Date(value).getTime()) ? 'must be a valid date' : null),
  password: (value) => {
    const text = String(value);
    if (text.length < 8) return 'must be at least 8 characters';
    if (!/[a-zA-Z]/.test(text) || !/\d/.test(text)) return 'must contain letters and numbers';
    return null;
  },
};

function applyField(name, value, spec, errors) {
  const isMissing = value === undefined || value === null || value === '';
  if (spec.required && rules.required(value)) {
    errors[name] = `${name} is required`;
    return;
  }
  if (isMissing) return; // optional and absent — nothing else to check

  (spec.checks || []).forEach((check) => {
    if (errors[name]) return;
    const fail = rules[check]?.(value);
    if (fail) errors[name] = `${name} ${fail}`;
  });

  if (!errors[name] && spec.enum && !spec.enum.includes(value)) {
    errors[name] = `${name} must be one of: ${spec.enum.join(', ')}`;
  }
  if (!errors[name] && spec.min !== undefined && Number(value) < spec.min) {
    errors[name] = `${name} must be at least ${spec.min}`;
  }
  if (!errors[name] && spec.max !== undefined && Number(value) > spec.max) {
    errors[name] = `${name} must be at most ${spec.max}`;
  }
  if (!errors[name] && spec.maxLength && String(value).length > spec.maxLength) {
    errors[name] = `${name} must be ${spec.maxLength} characters or fewer`;
  }
  if (!errors[name] && spec.minLength && String(value).length < spec.minLength) {
    errors[name] = `${name} must be at least ${spec.minLength} characters`;
  }
}

/** validate({ email: { required: true, checks: ['email'] } }) */
const validate = (schema, source = 'body') => (req, _res, next) => {
  const data = req[source] || {};
  const errors = {};
  Object.entries(schema).forEach(([name, spec]) => applyField(name, data[name], spec, errors));

  if (Object.keys(errors).length) {
    return next(ApiError.unprocessable('Please check the highlighted fields', 'VALIDATION_ERROR', errors));
  }
  return next();
};

/**
 * Strips keys starting with `$` or containing `.` from request payloads so a
 * crafted body cannot smuggle a query operator into a Mongo filter.
 */
function sanitize(req, _res, next) {
  const clean = (value) => {
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => !key.startsWith('$') && !key.includes('.'))
          .map(([key, val]) => [key, clean(val)]),
      );
    }
    return value;
  };

  if (req.body && typeof req.body === 'object') req.body = clean(req.body);
  // req.query is a getter on Express 5+; mutate in place where possible.
  if (req.query && typeof req.query === 'object') {
    Object.keys(req.query).forEach((key) => {
      if (key.startsWith('$') || key.includes('.')) delete req.query[key];
    });
  }
  return next();
}

module.exports = { validate, sanitize, rules, EMAIL_RE, PHONE_RE };
