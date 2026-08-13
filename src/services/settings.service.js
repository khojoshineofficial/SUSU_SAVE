'use strict';

const { SystemSetting } = require('../models');

let cache = null;
let cachedAt = 0;
const TTL_MS = 30 * 1000;

/** Settings are read on nearly every request, so keep a short-lived cache. */
async function getSettings({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cachedAt < TTL_MS) return cache;
  cache = await SystemSetting.load();
  cachedAt = Date.now();
  return cache;
}

async function updateSettings(patch, actorId = null) {
  const settings = await SystemSetting.load();
  const assign = (target, source) => {
    Object.entries(source || {}).forEach(([key, value]) => {
      if (value === undefined) return;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        assign(target[key] || (target[key] = {}), value);
      } else {
        target[key] = value;
      }
    });
  };
  assign(settings, patch);
  settings.updatedBy = actorId;
  await settings.save();
  invalidate();
  return settings;
}

function invalidate() {
  cache = null;
  cachedAt = 0;
}

module.exports = { getSettings, updateSettings, invalidate };
