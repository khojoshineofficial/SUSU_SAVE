'use strict';

const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alike characters

function randomCode(length = 4) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** SUSU-2026-0F3K9QA2 — human readable and unique enough for a ledger row. */
function transactionId(prefix = 'SUSU') {
  return `${prefix}-${new Date().getFullYear()}-${randomCode(8)}`;
}

/** SUSU-ADOM-82K4 — a group invite code derived from the group name. */
function inviteCode(groupName = '') {
  const slug = groupName
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 4) || 'GRP';
  return `SUSU-${slug}-${randomCode(4)}`;
}

const token = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');
const hashToken = (value) => crypto.createHash('sha256').update(value).digest('hex');

module.exports = { randomCode, transactionId, inviteCode, token, hashToken };
