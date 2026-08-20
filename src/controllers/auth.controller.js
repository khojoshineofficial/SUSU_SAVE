'use strict';

const { User, Organization, constants } = require('../models');
const { ROLES, ACCOUNT_STATUS, ORG_STATUS } = constants;
const tokens = require('../services/token.service');
const ledger = require('../services/ledger.service');
const feeService = require('../services/fee.service');
const paymentService = require('../services/payment');
const email = require('../services/email.service');
const audit = require('../services/audit.service');
const collectors = require('../services/collector.service');
const notifications = require('../services/notification.service');
const { getSettings } = require('../services/settings.service');
const ids = require('../utils/ids');
const ApiError = require('../utils/apiError');
const { asyncHandler, ok, created } = require('../utils/http');

const publicUser = (user) => user.toJSON();

/**
 * Registration creates the account in `pending_payment` when the platform
 * charges a registration fee. The account only becomes active once a *verified*
 * payment settles — see settlement.service.
 */
const register = asyncHandler(async (req, res) => {
  const settings = await getSettings();
  const {
    accountType = 'personal', firstName, lastName, email: emailAddress, phone, password,
    country, region, organizationName, organizationType, organizationAddress, joinCode,
  } = req.body;

  const existing = await User.findOne({ email: String(emailAddress).toLowerCase() });
  if (existing) throw ApiError.conflict('An account with that email already exists', 'EMAIL_TAKEN');

  // Signing up through a collector's link: the customer joins that collector's
  // organization as an ordinary saver, whatever else the form asked for.
  let joined = null;
  if (joinCode) {
    joined = await collectors.resolveJoinCode(joinCode);
    await collectors.assertCapacity(joined);
  }

  const isOrganization = !joined && accountType === 'organization';
  if (isOrganization && !organizationName) {
    throw ApiError.badRequest('Organization name is required', 'MISSING_ORGANIZATION_NAME');
  }

  const passwordHash = await User.hashPassword(password);
  const verificationToken = ids.token(24);

  const user = await User.create({
    firstName,
    lastName,
    email: String(emailAddress).toLowerCase(),
    phone,
    passwordHash,
    country: country || 'Ghana',
    region: region || null,
    role: isOrganization ? ROLES.ORG_ADMIN : ROLES.USER,
    organizationId: joined?._id || null,
    status: settings.rules.requireRegistrationPayment
      ? ACCOUNT_STATUS.PENDING_PAYMENT
      : ACCOUNT_STATUS.ACTIVE,
    emailVerificationTokenHash: ids.hashToken(verificationToken),
  });

  // The collector's organization owns the customer's fees and tenancy from here.
  let organization = joined;
  if (isOrganization) {
    organization = await Organization.create({
      name: organizationName,
      slug: Organization.slugify(organizationName),
      type: organizationType || 'company',
      adminId: user._id,
      contactEmail: user.email,
      contactPhone: phone,
      address: organizationAddress || '',
      country: country || 'Ghana',
      region: region || null,
      status: settings.rules.requireRegistrationPayment ? ORG_STATUS.PENDING : ORG_STATUS.ACTIVE,
    });
    user.organizationId = organization._id;
    await user.save();
  }

  await ledger.getOrCreateWallet(user._id, user.organizationId);
  await email.sendVerificationEmail(user, verificationToken);

  // Kick off the registration fee payment so the client can present checkout.
  let payment = null;
  if (settings.rules.requireRegistrationPayment) {
    const amountMinor = await feeService.registrationFeeMinor(organization);
    if (amountMinor > 0) {
      payment = await paymentService.initiatePayment({
        userId: user._id,
        organizationId: organization?._id || null,
        purpose: 'registration_fee',
        amountMinor,
        method: 'mobile_money',
        payerIdentifier: phone,
        payerEmail: user.email,
      });
    }
  }

  await audit.log({
    req,
    actor: user,
    action: 'user.registered',
    entityType: 'User',
    entityId: user._id,
    organizationId: organization?._id || null,
    metadata: { accountType, ...(joined ? { via: 'join_link', joinCode: joined.joinCode } : {}) },
  });

  if (joined) {
    // The collector should learn about a new customer without checking the app.
    await notifications.notify({
      userId: joined.adminId,
      organizationId: joined._id,
      type: 'announcement',
      title: 'New customer signed up',
      body: `${user.firstName} ${user.lastName} joined ${joined.name} through your sign-up link.`,
      icon: 'user-plus',
      link: '/organization?tab=members',
    });
  }

  const issued = tokens.issueTokens(user);
  res.cookie('refreshToken', issued.refreshToken, tokens.refreshCookieOptions());

  return created(res, {
    user: publicUser(user),
    // A customer joining a link gets the collector's name, not the tenant's
    // fee overrides and plan limits.
    organization: joined ? { _id: joined._id, name: joined.name } : organization,
    accessToken: issued.accessToken,
    payment: payment
      ? { reference: payment.reference, amountMinor: payment.amountMinor, checkoutUrl: payment.checkoutUrl }
      : null,
    // Surfacing the token in dev keeps the flow testable without a mail server.
    ...(process.env.NODE_ENV === 'production' ? {} : { verificationToken }),
  }, 'Account created');
});

const login = asyncHandler(async (req, res) => {
  const { email: emailAddress, password } = req.body;
  const identifier = String(emailAddress).toLowerCase().trim();

  // Staff sign in with a username; members with their email or phone.
  const user = await User.findOne({
    $or: [{ email: identifier }, { phone: identifier }, { username: identifier }],
  }).select('+passwordHash +failedLoginAttempts +lockedUntil');

  // One generic message for both branches so the endpoint cannot enumerate accounts.
  const invalid = ApiError.unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
  if (!user) throw invalid;

  if (user.isLocked()) {
    throw new ApiError(423, 'Account temporarily locked after too many attempts. Try again shortly.', 'ACCOUNT_LOCKED');
  }
  if (user.status === ACCOUNT_STATUS.SUSPENDED) {
    throw ApiError.forbidden('This account has been suspended', 'ACCOUNT_SUSPENDED');
  }

  const matches = await user.verifyPassword(password);
  if (!matches) {
    await user.registerFailedLogin();
    throw invalid;
  }

  await user.registerSuccessfulLogin();
  await ledger.getOrCreateWallet(user._id, user.organizationId);

  const issued = tokens.issueTokens(user);
  res.cookie('refreshToken', issued.refreshToken, tokens.refreshCookieOptions());

  await audit.log({ req, actor: user, action: 'user.login', entityType: 'User', entityId: user._id });

  return ok(res, { user: publicUser(user), accessToken: issued.accessToken }, 'Signed in');
});

const refresh = asyncHandler(async (req, res) => {
  const token = req.cookies?.refreshToken || req.body?.refreshToken;
  if (!token) throw ApiError.unauthorized('No refresh token supplied', 'NO_REFRESH_TOKEN');

  const payload = tokens.verifyRefreshToken(token);
  const user = await User.findById(payload.sub);
  if (!user || user.status === ACCOUNT_STATUS.SUSPENDED) {
    throw ApiError.unauthorized('Unable to refresh this session', 'REFRESH_DENIED');
  }

  const issued = tokens.issueTokens(user);
  res.cookie('refreshToken', issued.refreshToken, tokens.refreshCookieOptions());
  return ok(res, { accessToken: issued.accessToken, user: publicUser(user) }, 'Session refreshed');
});

const logout = asyncHandler(async (req, res) => {
  res.clearCookie('refreshToken', { ...tokens.refreshCookieOptions(), maxAge: undefined });
  return ok(res, {}, 'Signed out');
});

const forgotPassword = asyncHandler(async (req, res) => {
  const user = await User.findOne({ email: String(req.body.email).toLowerCase() });

  // Always the same response, whether or not the address exists.
  const response = () => ok(res, {}, 'If that account exists, a reset link is on its way');
  if (!user) return response();

  const resetToken = ids.token(24);
  user.passwordResetTokenHash = ids.hashToken(resetToken);
  user.passwordResetExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
  await user.save();

  await email.sendPasswordResetEmail(user, resetToken);
  await audit.log({ req, actor: user, action: 'user.password_reset_requested', entityType: 'User', entityId: user._id });
  return response();
});

const resetPassword = asyncHandler(async (req, res) => {
  const { token, password } = req.body;
  const user = await User.findOne({
    passwordResetTokenHash: ids.hashToken(token),
    passwordResetExpiresAt: { $gt: new Date() },
  }).select('+passwordResetTokenHash +passwordResetExpiresAt');

  if (!user) throw ApiError.badRequest('This reset link is invalid or has expired', 'INVALID_RESET_TOKEN');

  user.passwordHash = await User.hashPassword(password);
  user.passwordResetTokenHash = null;
  user.passwordResetExpiresAt = null;
  user.failedLoginAttempts = 0;
  user.lockedUntil = null;
  await user.save();

  await audit.log({ req, actor: user, action: 'user.password_reset', entityType: 'User', entityId: user._id });
  return ok(res, {}, 'Password updated. You can now sign in.');
});

const verifyEmail = asyncHandler(async (req, res) => {
  const token = req.body.token || req.query.token;
  const user = await User.findOne({ emailVerificationTokenHash: ids.hashToken(String(token)) })
    .select('+emailVerificationTokenHash');
  if (!user) throw ApiError.badRequest('This verification link is invalid', 'INVALID_VERIFICATION_TOKEN');

  user.emailVerified = true;
  user.emailVerificationTokenHash = null;
  if (user.status === ACCOUNT_STATUS.PENDING_VERIFICATION) user.status = ACCOUNT_STATUS.ACTIVE;
  await user.save();

  return ok(res, { user: publicUser(user) }, 'Email verified');
});

module.exports = { register, login, refresh, logout, forgotPassword, resetPassword, verifyEmail };
