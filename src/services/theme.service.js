'use strict';

const ApiError = require('../utils/apiError');

/**
 * Website appearance.
 *
 * The super admin edits a small set of values; this module turns them into CSS
 * custom properties that are served by GET /theme.css and loaded *after* the
 * design system on every page. Nothing here replaces the existing stylesheet —
 * it only overrides tokens, so an empty theme leaves the original design
 * untouched and clearing a field restores it.
 *
 * Every value is validated before it reaches the stylesheet. A theme is written
 * by an authenticated super admin, but it is served to every visitor, so a
 * value that could carry `}` or `;` would let a stored string escape its
 * declaration and rewrite the page. Colours must match a colour pattern, fonts
 * must come from the allowlist, and numbers are clamped.
 */

/** Fonts the pages can actually load: the bundled family, or a Google font. */
const FONTS = {
  '': null,
  'Plus Jakarta Sans': "'Plus Jakarta Sans'",
  Inter: "'Inter'",
  'DM Sans': "'DM Sans'",
  Poppins: "'Poppins'",
  Rubik: "'Rubik'",
  Manrope: "'Manrope'",
  Lato: "'Lato'",
  'Open Sans': "'Open Sans'",
  Montserrat: "'Montserrat'",
  'Source Serif 4': "'Source Serif 4'",
  'Playfair Display': "'Playfair Display'",
  'IBM Plex Sans': "'IBM Plex Sans'",
  'System default': 'system-ui',
};

const FALLBACK_STACK = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
const TRANSFORMS = ['', 'none', 'uppercase', 'capitalize'];

const COLOR_FIELDS = [
  'primaryColor', 'secondaryColor', 'backgroundColor', 'surfaceColor', 'textColor',
  'mutedTextColor', 'buttonColor', 'buttonTextColor', 'borderColor',
  'headerBackground', 'headerTextColor', 'footerBackground', 'footerTextColor',
  'bannerBackground', 'bannerTextColor',
];

/** #rgb, #rrggbb or #rrggbbaa. Deliberately narrow — no rgb()/var()/url(). */
const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

const NUMBER_FIELDS = {
  baseFontSize: { min: 12, max: 22 },
  headingWeight: { min: 300, max: 900 },
  headingLetterSpacing: { min: -0.1, max: 0.3 },
  bodyLineHeight: { min: 1.1, max: 2.2 },
  cornerRadius: { min: 0, max: 28 },
};

/* --------------------------------- colours -------------------------------- */

function toRgb(hex) {
  let value = hex.slice(1);
  if (value.length === 3) value = value.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16));
}

const toHex = (rgb) => `#${rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('')}`;

/** Mixes towards white (amount > 0) or black (amount < 0). */
function shade(hex, amount) {
  const target = amount > 0 ? 255 : 0;
  const weight = Math.abs(amount);
  return toHex(toRgb(hex).map((c) => c + (target - c) * weight));
}

/**
 * Rebuilds the brand ramp from one colour. The design system references
 * --purple-50 through --purple-900 in dozens of places, so setting only
 * --purple-600 would leave hover states and tinted backgrounds on the old hue.
 */
function brandRamp(primary) {
  return {
    '--purple-50': shade(primary, 0.94),
    '--purple-100': shade(primary, 0.87),
    '--purple-200': shade(primary, 0.72),
    '--purple-300': shade(primary, 0.52),
    '--purple-400': shade(primary, 0.28),
    '--purple-500': shade(primary, 0.08),
    '--purple-600': primary,
    '--purple-700': shade(primary, -0.16),
    '--purple-800': shade(primary, -0.34),
    '--purple-900': shade(primary, -0.52),
  };
}

/* -------------------------------- validation ------------------------------- */

/**
 * Returns a clean theme patch, or throws on the first bad value. Only the keys
 * present in `input` are returned, so a partial save leaves the rest alone.
 */
function sanitiseTheme(input = {}) {
  const clean = {};

  COLOR_FIELDS.forEach((field) => {
    if (!(field in input)) return;
    const value = String(input[field] || '').trim();
    if (value && !HEX.test(value)) {
      throw ApiError.badRequest(`${field} must be a hex colour such as #5b21e6`, 'INVALID_COLOR');
    }
    clean[field] = value;
  });

  ['fontFamily', 'headingFontFamily'].forEach((field) => {
    if (!(field in input)) return;
    const value = String(input[field] || '').trim();
    if (!(value in FONTS)) throw ApiError.badRequest(`${field} is not an available font`, 'INVALID_FONT');
    clean[field] = value;
  });

  Object.entries(NUMBER_FIELDS).forEach(([field, range]) => {
    if (!(field in input)) return;
    const value = Number(input[field]) || 0;
    // Zero means "leave as designed", which is why it bypasses the range.
    if (value !== 0 && (value < range.min || value > range.max)) {
      throw ApiError.badRequest(`${field} must be between ${range.min} and ${range.max}`, 'INVALID_THEME_VALUE');
    }
    clean[field] = value;
  });

  if ('headingTransform' in input) {
    const value = String(input.headingTransform || '').trim();
    if (!TRANSFORMS.includes(value)) throw ApiError.badRequest('Invalid heading style', 'INVALID_THEME_VALUE');
    clean.headingTransform = value;
  }

  ['bannerText', 'bannerUrl'].forEach((field) => {
    if (field in input) clean[field] = String(input[field] || '').trim().slice(0, 300);
  });
  if ('bannerEnabled' in input) clean.bannerEnabled = Boolean(input.bannerEnabled);

  ['logoUrl', 'faviconUrl'].forEach((field) => {
    if (field in input) clean[field] = String(input[field] || '').trim();
  });

  return clean;
}

/* ---------------------------------- output --------------------------------- */

const fontStack = (name) => (FONTS[name] ? `${FONTS[name]}, ${FALLBACK_STACK}` : null);

/**
 * The stylesheet. Only tokens the admin actually set are emitted, so the file
 * is empty on a default install and the browser falls through to the design
 * system exactly as before.
 */
function buildCss(theme = {}) {
  const vars = {};
  const put = (name, value) => { if (value) vars[name] = value; };

  if (theme.primaryColor) Object.assign(vars, brandRamp(theme.primaryColor));

  put('--secondary', theme.secondaryColor);
  put('--bg', theme.backgroundColor);
  put('--surface', theme.surfaceColor);
  put('--surface-alt', theme.surfaceColor);
  put('--ink-900', theme.textColor);
  put('--ink-800', theme.textColor);
  put('--ink-500', theme.mutedTextColor);
  put('--border', theme.borderColor);
  put('--font', fontStack(theme.fontFamily));
  put('--heading-font', fontStack(theme.headingFontFamily) || fontStack(theme.fontFamily));

  if (theme.baseFontSize) put('--theme-base-size', `${theme.baseFontSize}px`);
  if (theme.bodyLineHeight) put('--theme-line-height', String(theme.bodyLineHeight));
  if (theme.headingWeight) put('--theme-heading-weight', String(theme.headingWeight));
  if (theme.headingLetterSpacing) put('--theme-heading-spacing', `${theme.headingLetterSpacing}em`);
  if (theme.headingTransform && theme.headingTransform !== 'none') {
    put('--theme-heading-transform', theme.headingTransform);
  }
  if (theme.cornerRadius) {
    put('--radius-sm', `${Math.max(0, theme.cornerRadius - 4)}px`);
    put('--radius', `${theme.cornerRadius}px`);
    put('--radius-lg', `${theme.cornerRadius + 4}px`);
  }

  put('--header-bg', theme.headerBackground);
  put('--header-ink', theme.headerTextColor);
  put('--footer-bg', theme.footerBackground);
  put('--footer-ink', theme.footerTextColor);
  put('--banner-bg', theme.bannerBackground);
  put('--banner-ink', theme.bannerTextColor);

  const declarations = Object.entries(vars).map(([name, value]) => `  ${name}: ${value};`);
  if (!declarations.length) return '/* No theme overrides — the default design is in use. */\n';

  const rules = [`:root {\n${declarations.join('\n')}\n}`];

  // A handful of tokens are not referenced by the design system, so they need a
  // rule of their own to take effect.
  if (theme.baseFontSize) rules.push('body { font-size: var(--theme-base-size); }');
  if (theme.bodyLineHeight) rules.push('body { line-height: var(--theme-line-height); }');
  if (theme.buttonColor) {
    rules.push(`.btn, .btn-primary { background: ${theme.buttonColor}; border-color: ${theme.buttonColor}; }`);
  }
  if (theme.buttonTextColor) rules.push(`.btn, .btn-primary { color: ${theme.buttonTextColor}; }`);
  if (vars['--heading-font']) rules.push('h1, h2, h3, h4, h5 { font-family: var(--heading-font); }');
  if (theme.headingWeight) rules.push('h1, h2, h3, h4, h5 { font-weight: var(--theme-heading-weight); }');
  if (theme.headingLetterSpacing) rules.push('h1, h2, h3, h4, h5 { letter-spacing: var(--theme-heading-spacing); }');
  if (vars['--theme-heading-transform']) {
    rules.push('h1, h2, h3 { text-transform: var(--theme-heading-transform); }');
  }
  if (theme.headerBackground) rules.push('.app-header, .site-header { background: var(--header-bg); }');
  if (theme.headerTextColor) rules.push('.app-header, .site-header { color: var(--header-ink); }');
  if (theme.footerBackground) rules.push('.site-footer { background: var(--footer-bg); }');
  if (theme.footerTextColor) rules.push('.site-footer { color: var(--footer-ink); }');

  return `${rules.join('\n')}\n`;
}

/** The Google Fonts stylesheet the chosen families need, if any. */
function fontHref(theme = {}) {
  const families = [theme.fontFamily, theme.headingFontFamily]
    .filter((name) => name && name !== 'System default' && name !== 'Plus Jakarta Sans' && FONTS[name]);
  if (!families.length) return null;

  const query = [...new Set(families)]
    .map((name) => `family=${encodeURIComponent(name).replace(/%20/g, '+')}:wght@400;500;600;700;800`)
    .join('&');
  return `https://fonts.googleapis.com/css2?${query}&display=swap`;
}

module.exports = {
  sanitiseTheme,
  buildCss,
  fontHref,
  FONTS: Object.keys(FONTS).filter(Boolean),
  TRANSFORMS: TRANSFORMS.filter(Boolean),
};
