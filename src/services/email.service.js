'use strict';

const env = require('../config/env');
const logger = require('../utils/logger');

/**
 * Transport-agnostic email interface. The default `console` driver lets the
 * whole product run locally with no SMTP credentials; swapping in a real
 * provider means adding one driver here and changing EMAIL_DRIVER.
 */

const drivers = {
  console: async (message) => {
    logger.info(`[email:console] to=${message.to} subject="${message.subject}"`);
    logger.debug(message.text || message.html);
    return { delivered: true, driver: 'console' };
  },

  smtp: async (message) => {
    // Deliberately not wired to a transport yet — surfacing the gap beats
    // pretending the mail was sent.
    logger.warn(`[email:smtp] driver not configured; dropping mail to ${message.to}`);
    return { delivered: false, driver: 'smtp', reason: 'SMTP transport not configured' };
  },
};

async function send({ to, subject, text = '', html = '' }) {
  const driver = drivers[env.email.driver] || drivers.console;
  return driver({ to, subject, text, html, from: env.email.from });
}

const sendVerificationEmail = (user, token) =>
  send({
    to: user.email,
    subject: 'Verify your SUSU SAVE account',
    text: `Hi ${user.firstName},\n\nVerify your email: ${env.appUrl}/verify-email?token=${token}`,
  });

const sendPasswordResetEmail = (user, token) =>
  send({
    to: user.email,
    subject: 'Reset your SUSU SAVE password',
    text: `Hi ${user.firstName},\n\nReset your password: ${env.appUrl}/reset-password?token=${token}\nThis link expires in 1 hour.`,
  });

const sendInvitationEmail = (invitation, token, context = {}) =>
  send({
    to: invitation.email,
    subject: `You have been invited to join ${context.label || 'SUSU SAVE'}`,
    text: `Join here: ${env.appUrl}/register?invite=${token}`,
  });

module.exports = { send, sendVerificationEmail, sendPasswordResetEmail, sendInvitationEmail };
