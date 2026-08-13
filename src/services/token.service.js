'use strict';

const jwt = require('jsonwebtoken');
const env = require('../config/env');
const ApiError = require('../utils/apiError');

const signAccessToken = (user) =>
  jwt.sign(
    {
      sub: String(user._id),
      role: user.role,
      org: user.organizationId ? String(user.organizationId) : null,
      type: 'access',
    },
    env.jwt.secret,
    { expiresIn: env.jwt.accessTtl, issuer: 'susu-save' },
  );

const signRefreshToken = (user) =>
  jwt.sign({ sub: String(user._id), type: 'refresh' }, env.jwt.refreshSecret, {
    expiresIn: env.jwt.refreshTtl,
    issuer: 'susu-save',
  });

function verifyAccessToken(token) {
  try {
    const payload = jwt.verify(token, env.jwt.secret, { issuer: 'susu-save' });
    if (payload.type !== 'access') throw new Error('wrong token type');
    return payload;
  } catch (err) {
    throw ApiError.unauthorized('Your session has expired. Please sign in again.', 'INVALID_TOKEN');
  }
}

function verifyRefreshToken(token) {
  try {
    const payload = jwt.verify(token, env.jwt.refreshSecret, { issuer: 'susu-save' });
    if (payload.type !== 'refresh') throw new Error('wrong token type');
    return payload;
  } catch (err) {
    throw ApiError.unauthorized('Invalid refresh token', 'INVALID_REFRESH_TOKEN');
  }
}

const issueTokens = (user) => ({
  accessToken: signAccessToken(user),
  refreshToken: signRefreshToken(user),
});

/** Refresh tokens live in an httpOnly cookie so page scripts cannot read them. */
const refreshCookieOptions = () => ({
  httpOnly: true,
  secure: env.isProduction,
  sameSite: 'lax',
  path: '/api/auth',
  maxAge: 30 * 24 * 60 * 60 * 1000,
});

module.exports = {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  issueTokens,
  refreshCookieOptions,
};
