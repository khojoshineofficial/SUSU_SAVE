'use strict';

/**
 * Appearance settings and uploaded images.
 *
 * Both turn admin-supplied strings into something served to every visitor — a
 * stylesheet and an <img> — so these tests are about what must never get
 * through, as much as what must.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const theme = require('../src/services/theme.service');
const { validateImage } = require('../src/utils/imageData');

/* --------------------------------- colours -------------------------------- */

test('a colour that tries to escape its declaration is refused', () => {
  const attacks = [
    'red; } body { display: none } .x {',
    'url(https://evil.test/x.png)',
    'var(--anything)',
    '#12345',
    'expression(alert(1))',
  ];
  attacks.forEach((value) => {
    assert.throws(
      () => theme.sanitiseTheme({ primaryColor: value }),
      /hex colour/,
      `${value} must be rejected`,
    );
  });
});

test('valid hex colours in every accepted length pass through', () => {
  ['#fff', '#5b21e6', '#5b21e6cc'].forEach((value) => {
    assert.equal(theme.sanitiseTheme({ primaryColor: value }).primaryColor, value);
  });
  assert.equal(theme.sanitiseTheme({ primaryColor: '' }).primaryColor, '', 'clearing is allowed');
});

test('only allowlisted fonts are accepted', () => {
  assert.equal(theme.sanitiseTheme({ fontFamily: 'Inter' }).fontFamily, 'Inter');
  assert.throws(() => theme.sanitiseTheme({ fontFamily: 'Comic Sans MS' }), /not an available font/);
  assert.throws(() => theme.sanitiseTheme({ fontFamily: "x'; }" }), /not an available font/);
});

test('numbers outside their range are refused, and zero means "leave as designed"', () => {
  assert.throws(() => theme.sanitiseTheme({ baseFontSize: 400 }), /between 12 and 22/);
  assert.throws(() => theme.sanitiseTheme({ cornerRadius: 999 }), /between 0 and 28/);
  assert.equal(theme.sanitiseTheme({ baseFontSize: 0 }).baseFontSize, 0);
  assert.equal(theme.sanitiseTheme({ baseFontSize: 18 }).baseFontSize, 18);
});

test('only the keys supplied are returned, so a partial save leaves the rest alone', () => {
  const patch = theme.sanitiseTheme({ primaryColor: '#0f766e' });
  assert.deepEqual(Object.keys(patch), ['primaryColor']);
});

/* ------------------------------- stylesheet -------------------------------- */

test('an empty theme produces no overrides at all', () => {
  const css = theme.buildCss({});
  assert.doesNotMatch(css, /--purple-600/);
  assert.doesNotMatch(css, /:root \{/);
});

test('one primary colour regenerates the whole brand ramp', () => {
  const css = theme.buildCss({ primaryColor: '#0f766e' });
  assert.match(css, /--purple-600: #0f766e;/);

  // Every step of the ramp must be present, or hover states and tinted
  // backgrounds would stay on the old hue.
  [50, 100, 200, 300, 400, 500, 700, 800, 900].forEach((step) => {
    assert.match(css, new RegExp(`--purple-${step}: #[0-9a-f]{6};`), `--purple-${step} is set`);
  });

  // The tints must actually differ, and run light to dark.
  const value = (step) => new RegExp(`--purple-${step}: (#[0-9a-f]{6});`).exec(css)[1];
  const brightness = (hex) => parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16);
  assert.ok(brightness(value(50)) > brightness(value(500)), '50 is lighter than 500');
  assert.ok(brightness(value(500)) > brightness(value(900)), '500 is lighter than 900');
});

test('a chosen font reaches the stylesheet with a real fallback stack', () => {
  const css = theme.buildCss({ fontFamily: 'Inter' });
  assert.match(css, /--font: 'Inter', -apple-system/);
});

test('the Google Fonts link is requested only for fonts that need one', () => {
  assert.equal(theme.fontHref({}), null);
  assert.equal(theme.fontHref({ fontFamily: 'System default' }), null);
  assert.equal(theme.fontHref({ fontFamily: 'Plus Jakarta Sans' }), null, 'the bundled font is already loaded');

  const href = theme.fontHref({ fontFamily: 'DM Sans', headingFontFamily: 'DM Sans' });
  assert.match(href, /^https:\/\/fonts\.googleapis\.com\/css2\?/);
  assert.match(href, /family=DM\+Sans/);
  assert.equal(href.match(/family=/g).length, 1, 'a repeated family is requested once');
});

/* --------------------------------- images ---------------------------------- */

const pngPixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('a real image is accepted and an https link passes through', () => {
  assert.equal(validateImage(pngPixel), pngPixel);
  assert.equal(validateImage('https://cdn.test/flyer.png'), 'https://cdn.test/flyer.png');
  assert.equal(validateImage(''), '', 'no image is a valid answer');
});

test('SVG is refused because it can carry script', () => {
  assert.throws(
    () => validateImage('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='),
    /not accepted/,
  );
});

test('anything that is not an image data URL is refused', () => {
  ['javascript:alert(1)', 'http://insecure.test/x.png', 'data:text/html;base64,PGI+', '<script>'].forEach((value) => {
    assert.throws(() => validateImage(value), /uploaded image|not accepted/, `${value} must be rejected`);
  });
});

test('an oversized upload is refused with its actual size in the message', () => {
  // 4MB of base64 decodes to roughly 3MB.
  const huge = `data:image/png;base64,${'A'.repeat(4 * 1024 * 1024)}`;
  assert.throws(() => validateImage(huge, { maxBytes: 2 * 1024 * 1024 }), /3\.0MB — the limit is 2\.0MB/);
  assert.doesNotThrow(() => validateImage(huge, { maxBytes: 4 * 1024 * 1024 }));
});
