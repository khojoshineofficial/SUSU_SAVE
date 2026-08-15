'use strict';

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { ROLES, ACCOUNT_STATUS, values } = require('./constants');

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

const userSchema = new mongoose.Schema(
  {
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true, unique: true, index: true },
    /**
     * Optional sign-in handle. Staff accounts are provisioned with one so they
     * never sign in with a guessable address; ordinary members may set one too.
     * Sparse-unique: absent on most accounts, unique where present.
     */
    username: { type: String, lowercase: true, trim: true, default: undefined },
    phone: { type: String, trim: true, index: true },
    passwordHash: { type: String, required: true, select: false },

    role: { type: String, enum: values(ROLES), default: ROLES.USER, index: true },
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null, index: true },

    avatarUrl: { type: String, default: null },
    country: { type: String, default: 'Ghana' },
    region: { type: String, default: null },

    status: { type: String, enum: values(ACCOUNT_STATUS), default: ACCOUNT_STATUS.PENDING_PAYMENT, index: true },
    emailVerified: { type: Boolean, default: false },
    phoneVerified: { type: Boolean, default: false },

    // Hashed single-use tokens — the raw value only ever exists in the email.
    emailVerificationTokenHash: { type: String, default: null, select: false },
    passwordResetTokenHash: { type: String, default: null, select: false },
    passwordResetExpiresAt: { type: Date, default: null, select: false },

    failedLoginAttempts: { type: Number, default: 0, select: false },
    lockedUntil: { type: Date, default: null, select: false },
    lastLoginAt: { type: Date, default: null },

    notificationPreferences: {
      email: { type: Boolean, default: true },
      sms: { type: Boolean, default: false },
      push: { type: Boolean, default: true },
    },

    onboardingCompleted: { type: Boolean, default: false },
  },
  { timestamps: true },
);

userSchema.virtual('name').get(function name() {
  return `${this.firstName} ${this.lastName}`.trim();
});

userSchema.virtual('initials').get(function initials() {
  return `${this.firstName?.[0] || ''}${this.lastName?.[0] || ''}`.toUpperCase();
});

userSchema.set('toJSON', {
  virtuals: true,
  transform(_doc, ret) {
    delete ret.passwordHash;
    delete ret.emailVerificationTokenHash;
    delete ret.passwordResetTokenHash;
    delete ret.failedLoginAttempts;
    delete ret.lockedUntil;
    delete ret.__v;
    return ret;
  },
});

userSchema.index(
  { username: 1 },
  { unique: true, partialFilterExpression: { username: { $type: 'string' } } },
);

userSchema.statics.hashPassword = (plain) => bcrypt.hash(plain, 12);

/** Usernames are compared lowercase and may only contain safe characters. */
userSchema.statics.normaliseUsername = (value) => {
  const text = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{4,32}$/.test(text)) {
    throw new Error('Username must be 4-32 characters, using letters, numbers, dot, underscore or hyphen');
  }
  return text;
};

userSchema.methods.verifyPassword = function verifyPassword(plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

userSchema.methods.isLocked = function isLocked() {
  return Boolean(this.lockedUntil && this.lockedUntil > new Date());
};

userSchema.methods.registerFailedLogin = async function registerFailedLogin() {
  this.failedLoginAttempts = (this.failedLoginAttempts || 0) + 1;
  if (this.failedLoginAttempts >= MAX_FAILED_LOGINS) {
    this.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60 * 1000);
    this.failedLoginAttempts = 0;
  }
  await this.save();
};

userSchema.methods.registerSuccessfulLogin = async function registerSuccessfulLogin() {
  this.failedLoginAttempts = 0;
  this.lockedUntil = null;
  this.lastLoginAt = new Date();
  await this.save();
};

module.exports = mongoose.model('User', userSchema);
module.exports.MAX_FAILED_LOGINS = MAX_FAILED_LOGINS;
module.exports.LOCK_MINUTES = LOCK_MINUTES;
