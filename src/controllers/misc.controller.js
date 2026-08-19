'use strict';

const {
  Notification, SupportTicket, SusuGroup, Transaction, SavingsPlan, User, Organization, constants,
} = require('../models');
const { ROLES, SUPPORT_STATUS, GROUP_MEMBER_STATUS } = constants;
const { GroupMember } = require('../models');
const dashboardService = require('../services/dashboard.service');
const notificationService = require('../services/notification.service');
const collectorService = require('../services/collector.service');
const themeService = require('../services/theme.service');
const { getSettings } = require('../services/settings.service');
const ids = require('../utils/ids');
const ApiError = require('../utils/apiError');
const { asyncHandler, ok, created, paginate, meta } = require('../utils/http');

/* ---------------------------------- dashboard --------------------------------- */

const getDashboard = asyncHandler(async (req, res) => {
  const data = await dashboardService.getUserDashboard(req.user);
  return ok(res, data);
});

/* -------------------------------- notifications ------------------------------- */

const listNotifications = asyncHandler(async (req, res) => {
  const { page, limit, skip } = paginate(req.query, { defaultLimit: 30 });
  const filter = { userId: req.user._id };
  if (req.query.unread === 'true') filter.readAt = null;

  const [rows, total, unread] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Notification.countDocuments(filter),
    notificationService.unreadCount(req.user._id),
  ]);

  return ok(res, { notifications: rows, unread, meta: meta(page, limit, total) });
});

const readNotification = asyncHandler(async (req, res) => {
  const notification = await notificationService.markRead(req.user._id, req.params.id);
  if (!notification) throw ApiError.notFound('Notification not found', 'NOTIFICATION_NOT_FOUND');
  return ok(res, { notification }, 'Marked as read');
});

const readAllNotifications = asyncHandler(async (req, res) => {
  await notificationService.markAllRead(req.user._id);
  return ok(res, {}, 'All notifications marked as read');
});

/* ----------------------------------- search ----------------------------------- */

/**
 * Global search. Every branch is scoped to what the caller may legitimately
 * see — own transactions, own savings, groups they belong to (or, for admins,
 * their tenant).
 */
const search = asyncHandler(async (req, res) => {
  const term = String(req.query.q || '').trim();
  if (term.length < 2) return ok(res, { groups: [], transactions: [], savingsPlans: [], users: [] });

  const rx = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const isSuperAdmin = req.user.role === ROLES.SUPER_ADMIN;

  const myGroupIds = await GroupMember.find({
    userId: req.user._id,
    status: GROUP_MEMBER_STATUS.ACTIVE,
  }).distinct('groupId');

  const groupFilter = isSuperAdmin
    ? { name: rx }
    : { name: rx, $or: [{ _id: { $in: myGroupIds } }, { organizationId: req.user.organizationId || null, isPrivate: false }] };

  const [groups, transactions, savingsPlans, users] = await Promise.all([
    SusuGroup.find(groupFilter).select('name inviteCode contributionAmountMinor status').limit(10).lean(),
    Transaction.find({ userId: req.user._id, $or: [{ transactionId: rx }, { description: rx }] })
      .select('transactionId description grossAmountMinor type status createdAt')
      .limit(10)
      .lean(),
    SavingsPlan.find({ userId: req.user._id, name: rx }).select('name type currentAmountMinor').limit(10).lean(),
    isSuperAdmin || req.user.role === ROLES.ORG_ADMIN
      ? User.find({
        $or: [{ firstName: rx }, { lastName: rx }, { email: rx }],
        ...(isSuperAdmin ? {} : { organizationId: req.user.organizationId }),
      }).select('firstName lastName email role status').limit(10).lean()
      : [],
  ]);

  return ok(res, { groups, transactions, savingsPlans, users });
});

/* ---------------------------------- support ----------------------------------- */

const listTickets = asyncHandler(async (req, res) => {
  const filter = req.user.role === ROLES.SUPER_ADMIN ? {} : { userId: req.user._id };
  if (req.query.status) filter.status = req.query.status;
  const tickets = await SupportTicket.find(filter).sort({ createdAt: -1 }).limit(100).lean();
  return ok(res, { tickets });
});

const createTicket = asyncHandler(async (req, res) => {
  const ticket = await SupportTicket.create({
    reference: `TKT-${ids.randomCode(8)}`,
    userId: req.user._id,
    organizationId: req.user.organizationId || null,
    subject: req.body.subject,
    category: req.body.category || 'other',
    priority: req.body.priority || 'normal',
    messages: [{ authorId: req.user._id, body: req.body.message, isStaff: false }],
  });
  return created(res, { ticket }, 'Support ticket created');
});

const replyToTicket = asyncHandler(async (req, res) => {
  const isStaff = req.user.role === ROLES.SUPER_ADMIN;
  const filter = isStaff ? { _id: req.params.id } : { _id: req.params.id, userId: req.user._id };

  const ticket = await SupportTicket.findOne(filter);
  if (!ticket) throw ApiError.notFound('Ticket not found', 'TICKET_NOT_FOUND');
  if (ticket.status === SUPPORT_STATUS.CLOSED) {
    throw ApiError.badRequest('This ticket is closed', 'TICKET_CLOSED');
  }

  ticket.messages.push({ authorId: req.user._id, body: req.body.message, isStaff });
  if (isStaff && ticket.status === SUPPORT_STATUS.OPEN) ticket.status = SUPPORT_STATUS.IN_PROGRESS;
  await ticket.save();

  return ok(res, { ticket }, 'Reply added');
});

/* --------------------------------- public info -------------------------------- */

/** Non-sensitive settings the landing page and signup flow need. */
const publicSettings = asyncHandler(async (req, res) => {
  const settings = await getSettings();
  return ok(res, {
    platformName: settings.platformName,
    tagline: settings.tagline,
    currency: settings.currency,
    currencySymbol: settings.currencySymbol,
    registrationFeeMinor: settings.fees.registrationFeeMinor,
    monthlyPlatformFeeMinor: settings.fees.monthlyPlatformFeeMinor,
    savingsFeePercent: settings.fees.savingsFeePercent,
    withdrawalFeePercent: settings.fees.withdrawalFeePercent,
    withdrawalFlatFeeMinor: settings.fees.withdrawalFlatFeeMinor,
    limits: settings.limits,
    support: settings.support,
    maintenanceMode: settings.maintenanceMode,
    maintenanceMessage: settings.maintenanceMode ? settings.maintenanceMessage : '',
    // The pieces of the theme that JavaScript has to apply — the colours and
    // fonts arrive as CSS through /theme.css instead.
    branding: {
      logoUrl: settings.theme?.logoUrl || settings.logoUrl || '',
      faviconUrl: settings.theme?.faviconUrl || '',
      fontHref: themeService.fontHref(settings.theme || {}),
      themeVersion: settings.theme?.version || 0,
      banner: settings.theme?.bannerEnabled
        ? { text: settings.theme.bannerText || '', url: settings.theme.bannerUrl || '' }
        : null,
    },
  });
});

/** Public: who is behind a /join/<code> link. Unauthenticated by design. */
const collectorByCode = asyncHandler(async (req, res) => {
  const collector = await collectorService.publicProfile(req.params.code);
  return ok(res, { collector });
});

/** Organization directory entry used by the org admin dashboard. */
const organizationOverview = asyncHandler(async (req, res) => {
  if (!req.user.organizationId) throw ApiError.badRequest('You do not belong to an organization', 'NO_ORGANIZATION');
  const [organization, data] = await Promise.all([
    Organization.findById(req.user.organizationId).lean(),
    dashboardService.getOrganizationDashboard(req.user.organizationId),
  ]);
  return ok(res, { organization, ...data });
});

module.exports = {
  getDashboard,
  listNotifications,
  readNotification,
  readAllNotifications,
  search,
  listTickets,
  createTicket,
  replyToTicket,
  publicSettings,
  collectorByCode,
  organizationOverview,
};
