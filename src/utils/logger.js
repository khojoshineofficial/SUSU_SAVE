'use strict';

const level = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'error' : 'info');
const order = { error: 0, warn: 1, info: 2, debug: 3 };

function log(kind, ...args) {
  if (order[kind] > (order[level] ?? 2)) return;
  const stamp = new Date().toISOString();
  const fn = kind === 'error' ? console.error : kind === 'warn' ? console.warn : console.log;
  fn(`[${stamp}] ${kind.toUpperCase()}`, ...args);
}

module.exports = {
  error: (...a) => log('error', ...a),
  warn: (...a) => log('warn', ...a),
  info: (...a) => log('info', ...a),
  debug: (...a) => log('debug', ...a),
};
