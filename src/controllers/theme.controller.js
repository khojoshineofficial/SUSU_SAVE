'use strict';

const themeService = require('../services/theme.service');
const { getSettings, updateSettings } = require('../services/settings.service');
const audit = require('../services/audit.service');
const { validateImage } = require('../utils/imageData');
const { asyncHandler, ok } = require('../utils/http');

/** The current theme plus the options the editor offers. */
const getTheme = asyncHandler(async (req, res) => {
  const settings = await getSettings({ fresh: true });
  return ok(res, {
    theme: settings.theme || {},
    options: { fonts: themeService.FONTS, headingTransforms: themeService.TRANSFORMS },
  });
});

/**
 * Publishes the theme. Values are validated here rather than in the model
 * because they end up inside a stylesheet served to every visitor.
 */
const saveTheme = asyncHandler(async (req, res) => {
  const patch = themeService.sanitiseTheme(req.body?.theme || req.body || {});

  if ('logoUrl' in patch) patch.logoUrl = validateImage(patch.logoUrl, { field: 'Logo', maxBytes: 1024 * 1024 });
  if ('faviconUrl' in patch) {
    patch.faviconUrl = validateImage(patch.faviconUrl, { field: 'Favicon', maxBytes: 256 * 1024 });
  }

  const current = await getSettings({ fresh: true });
  patch.version = (current.theme?.version || 0) + 1;

  const settings = await updateSettings({ theme: patch }, req.user._id);

  await audit.log({
    req,
    action: 'settings.theme_updated',
    entityType: 'SystemSetting',
    entityId: settings._id,
    metadata: { version: patch.version, fields: Object.keys(patch).filter((k) => k !== 'version') },
  });

  return ok(res, { theme: settings.theme }, 'Appearance published');
});

/** Restores the built-in design without touching any other setting. */
const resetTheme = asyncHandler(async (req, res) => {
  const current = await getSettings({ fresh: true });
  const cleared = {};
  Object.keys(current.theme?.toObject?.() || current.theme || {}).forEach((key) => {
    if (key === 'version' || key === '_id') return;
    cleared[key] = typeof current.theme[key] === 'number' ? 0
      : typeof current.theme[key] === 'boolean' ? false : '';
  });
  cleared.version = (current.theme?.version || 0) + 1;

  const settings = await updateSettings({ theme: cleared }, req.user._id);
  await audit.log({
    req, action: 'settings.theme_reset', entityType: 'SystemSetting', entityId: settings._id,
  });
  return ok(res, { theme: settings.theme }, 'The original design has been restored');
});

/**
 * The stylesheet itself, loaded by every page after the design system.
 *
 * Served as a route rather than a file because it is generated from the
 * database. It is deliberately not cached for long: a published change should
 * show up on the next page load, not in an hour.
 */
const stylesheet = asyncHandler(async (req, res) => {
  const settings = await getSettings();
  const css = themeService.buildCss(settings.theme || {});

  res.type('text/css');
  res.set('Cache-Control', 'no-cache');
  res.set('ETag', `W/"theme-${settings.theme?.version || 0}"`);
  return res.send(css);
});

module.exports = { getTheme, saveTheme, resetTheme, stylesheet };
