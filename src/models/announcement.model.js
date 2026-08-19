'use strict';

const mongoose = require('mongoose');

const AUDIENCES = ['everyone', 'members', 'visitors'];
const ANNOUNCEMENT_STATUS = ['active', 'inactive'];

/**
 * A flyer the super admin publishes to the whole platform.
 *
 * Everything the popup shows is stored here, so the notice is changed by
 * editing a row rather than by editing markup. Two things decide whether a
 * visitor sees it: the status the super admin set, and the schedule window —
 * both are evaluated server-side in `liveFilter()` so a client cannot ask for
 * an announcement that is not meant to be live yet.
 */
const announcementSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 140 },
    /** The short message under the title. Plain text — never rendered as HTML. */
    body: { type: String, default: '', maxlength: 2000 },

    /** The flyer itself: an uploaded image stored as a data URL, or a link. */
    imageUrl: { type: String, default: null },

    /** Optional call to action. Both must be set for the button to render. */
    ctaLabel: { type: String, default: '', maxlength: 40 },
    ctaUrl: { type: String, default: '' },

    status: { type: String, enum: ANNOUNCEMENT_STATUS, default: 'inactive', index: true },

    /** Scheduling. Null on either side means "no bound in that direction". */
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },

    /** Who it is for: everyone, only signed-in members, or only signed-out visitors. */
    audience: { type: String, enum: AUDIENCES, default: 'everyone' },

    /** Highest priority wins when several are live at once. */
    priority: { type: Number, default: 0 },

    /** A visitor who closes a dismissible notice does not see it again. */
    dismissible: { type: Boolean, default: true },

    /** How many times the popup has actually been served. */
    impressions: { type: Number, default: 0 },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

announcementSchema.index({ status: 1, priority: -1, createdAt: -1 });

/**
 * The query for announcements that should be on screen right now. Kept as a
 * static so the public endpoint and the admin's "what is live" count cannot
 * drift apart.
 */
announcementSchema.statics.liveFilter = function liveFilter(now = new Date(), { signedIn = false } = {}) {
  return {
    status: 'active',
    $and: [
      { $or: [{ startsAt: null }, { startsAt: { $lte: now } }] },
      { $or: [{ endsAt: null }, { endsAt: { $gte: now } }] },
      { $or: [{ audience: 'everyone' }, { audience: signedIn ? 'members' : 'visitors' }] },
    ],
  };
};

/** Why an announcement is not showing — the answer the admin list needs. */
announcementSchema.methods.liveState = function liveState(now = new Date()) {
  if (this.status !== 'active') return 'inactive';
  if (this.startsAt && this.startsAt > now) return 'scheduled';
  if (this.endsAt && this.endsAt < now) return 'expired';
  return 'live';
};

announcementSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('Announcement', announcementSchema);
module.exports.AUDIENCES = AUDIENCES;
module.exports.ANNOUNCEMENT_STATUS = ANNOUNCEMENT_STATUS;
