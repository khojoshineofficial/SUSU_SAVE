'use strict';

const ApiError = require('../utils/apiError');

/**
 * Validation for images the super admin uploads — flyers, the logo, the favicon.
 *
 * Images arrive as data URLs in the JSON body and are stored in MongoDB rather
 * than on disk, because the host's filesystem is ephemeral: a redeploy would
 * take every uploaded flyer with it. That makes size the thing to police, and
 * type the thing to restrict.
 *
 * SVG is refused. An SVG is a document, not a bitmap: it can carry script and
 * external references, and these images are rendered on pages every visitor
 * sees. PNG, JPEG, WebP and GIF cannot execute anything.
 */

const ALLOWED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const DATA_URL = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/;

/**
 * Accepts a data URL or an https:// link and returns it unchanged, or throws.
 * An empty value means "no image" and is returned as an empty string.
 */
function validateImage(value, { maxBytes = 2 * 1024 * 1024, field = 'image' } = {}) {
  const input = String(value || '').trim();
  if (!input) return '';

  if (/^https:\/\//i.test(input)) {
    if (input.length > 2000) throw ApiError.badRequest(`${field} URL is too long`, 'IMAGE_URL_TOO_LONG');
    return input;
  }

  const match = DATA_URL.exec(input);
  if (!match) {
    throw ApiError.badRequest(
      `${field} must be an uploaded image or an https:// link`,
      'INVALID_IMAGE',
    );
  }

  const [, mime, base64] = match;
  if (!ALLOWED.includes(mime.toLowerCase())) {
    throw ApiError.badRequest(
      `${field} must be a PNG, JPEG, WebP or GIF — ${mime} is not accepted`,
      'UNSUPPORTED_IMAGE_TYPE',
    );
  }

  // Base64 carries 3 bytes per 4 characters, less any padding.
  const padding = (base64.match(/=+$/) || [''])[0].length;
  const bytes = Math.floor((base64.length * 3) / 4) - padding;
  if (bytes > maxBytes) {
    throw ApiError.badRequest(
      `${field} is ${(bytes / 1024 / 1024).toFixed(1)}MB — the limit is ${(maxBytes / 1024 / 1024).toFixed(1)}MB`,
      'IMAGE_TOO_LARGE',
    );
  }

  return input;
}

module.exports = { validateImage, ALLOWED };
