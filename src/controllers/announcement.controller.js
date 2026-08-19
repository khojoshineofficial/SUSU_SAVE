'use strict';

const { Announcement } = require('../models');
const audit = require('../services/audit.service');
const tokens = require('../services/token.service');
const { validateImage } = require('../utils/imageData');
const ApiError = require('../utils/apiError');
const { asyncHandler, ok, created } = require('../utils/http');

const AUDIENCES = ['everyone', 'members', 'visitors'];

/** Only fields an admin may set, cleaned. Absent keys are left untouched. */
function readBody(body = {}) {
  const patch = {};

  if ('title' in body) {
    const title = String(body.title || '').trim();
    if (!title) throw ApiError.badRequest('An announcement needs a title', 'MISSING_TITLE');
    patch.title = title.slice(0, 140);
  }
  if ('body' in body) patch.body = String(body.body || '').trim().slice(0, 2000);
  if ('imageUrl' in body) patch.imageUrl = validateImage(body.imageUrl, { field: 'Flyer' });
  if ('ctaLabel' in body) patch.ctaLabel = String(body.ctaLabel || '').trim().slice(0, 40);

  if ('ctaUrl' in body) {
    const url = String(body.ctaUrl || '').trim();
    // Relative links stay on the platform; absolute ones must be https, so a
    // published notice can never carry a javascript: or data: action.
    if (url && !/^(https:\/\/|\/)/.test(url)) {
      throw ApiError.badRequest('The button link must start with https:// or /', 'INVALID_CTA_URL');
    }
    patch.ctaUrl = url.slice(0, 500);
  }

  if ('status' in body) {
    if (!['active', 'inactive'].includes(body.status)) {
      throw ApiError.badRequest('Status must be active or inactive', 'INVALID_STATUS');
    }
    patch.status = body.status;
  }
  if ('audience' in body) {
    if (!AUDIENCES.includes(body.audience)) throw ApiError.badRequest('Unknown audience', 'INVALID_AUDIENCE');
    patch.audience = body.audience;
  }

  ['startsAt', 'endsAt'].forEach((field) => {
    if (!(field in body)) return;
    if (!body[field]) { patch[field] = null; return; }
    const when = new Date(body[field]);
    if (Number.isNaN(when.getTime())) throw ApiError.badRequest(`${field} is not a valid date`, 'INVALID_DATE');
    patch[field] = when;
  });

  if ('priority' in body) patch.priority = Math.max(0, Math.min(100, Number(body.priority) || 0));
  if ('dismissible' in body) patch.dismissible = Boolean(body.dismissible);

  if (patch.startsAt && patch.endsAt && patch.startsAt > patch.endsAt) {
    throw ApiError.badRequest('The end date cannot be before the start date', 'INVALID_SCHEDULE');
  }
  return patch;
}

/* ---------------------------------- admin ---------------------------------- */

const list = asyncHandler(async (req, res) => {
  const rows = await Announcement.find().sort({ priority: -1, createdAt: -1 });
  const now = new Date();
  return ok(res, {
    announcements: rows.map((row) => ({ ...row.toJSON(), liveState: row.liveState(now) })),
  });
});

const create = asyncHandler(async (req, res) => {
  const patch = readBody(req.body);
  if (!patch.title) throw ApiError.badRequest('An announcement needs a title', 'MISSING_TITLE');

  const announcement = await Announcement.create({
    ...patch,
    createdBy: req.user._id,
    updatedBy: req.user._id,
  });

  await audit.log({
    req,
    action: 'announcement.created',
    entityType: 'Announcement',
    entityId: announcement._id,
    metadata: { title: announcement.title, status: announcement.status },
  });
  return created(res, { announcement }, 'Announcement created');
});

const update = asyncHandler(async (req, res) => {
  const announcement = await Announcement.findById(req.params.id);
  if (!announcement) throw ApiError.notFound('Announcement not found', 'ANNOUNCEMENT_NOT_FOUND');

  Object.assign(announcement, readBody(req.body), { updatedBy: req.user._id });
  await announcement.save();

  await audit.log({
    req,
    action: 'announcement.updated',
    entityType: 'Announcement',
    entityId: announcement._id,
    metadata: { status: announcement.status },
  });
  return ok(res, { announcement }, 'Announcement updated');
});

const remove = asyncHandler(async (req, res) => {
  const announcement = await Announcement.findByIdAndDelete(req.params.id);
  if (!announcement) throw ApiError.notFound('Announcement not found', 'ANNOUNCEMENT_NOT_FOUND');

  await audit.log({
    req,
    action: 'announcement.deleted',
    entityType: 'Announcement',
    entityId: announcement._id,
    metadata: { title: announcement.title },
  });
  return ok(res, {}, 'Announcement deleted');
});

/* ---------------------------------- public --------------------------------- */

/**
 * The notice to show right now, or null. Unauthenticated, because the landing
 * and login pages call it too.
 *
 * Whether the caller is signed in is read from their refresh cookie rather than
 * from a query parameter: the access token lives in memory, so the page itself
 * does not reliably know yet when this runs. The cookie is verified, but a
 * failure only means "treat them as a visitor" — audience is a targeting
 * choice, not a permission.
 */
const live = asyncHandler(async (req, res) => {
  let signedIn = false;
  try {
    if (req.cookies?.refreshToken) {
      tokens.verifyRefreshToken(req.cookies.refreshToken);
      signedIn = true;
    }
  } catch { /* expired or forged cookie — they are a visitor */ }

  const announcement = await Announcement.findOne(Announcement.liveFilter(new Date(), { signedIn }))
    .sort({ priority: -1, createdAt: -1 })
    .select('title body imageUrl ctaLabel ctaUrl dismissible updatedAt')
    .lean();

  if (!announcement) return ok(res, { announcement: null });

  // Best effort: a failed counter must never cost the visitor their notice.
  Announcement.updateOne({ _id: announcement._id }, { $inc: { impressions: 1 } }).catch(() => {});
  return ok(res, { announcement });
});

module.exports = { list, create, update, remove, live };
