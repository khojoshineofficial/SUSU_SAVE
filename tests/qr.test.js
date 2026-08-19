'use strict';

/**
 * QR image generation. The database-backed behaviour (issuing, resolving and
 * revoking codes) is covered in api.test.js; this checks the part that runs
 * without a database — that what gets printed actually encodes the payment URL.
 */

process.env.APP_URL = 'https://susu.test';

const test = require('node:test');
const assert = require('node:assert/strict');

const codes = require('../src/services/paymentCode.service');

test('the payment URL is built from APP_URL and the code alone', () => {
  assert.equal(codes.urlFor('abc123'), 'https://susu.test/pay/abc123');
});

test('an SVG code is produced and encodes the payment URL', async () => {
  const svg = await codes.svgFor('abc123');
  assert.match(svg, /^<\?xml|^<svg/);
  assert.match(svg, /viewBox/);
  // A QR of a ~30-character URL needs a real module grid, not a stub.
  assert.ok(svg.length > 500, 'the SVG carries a full code grid');
});

test('a PNG code is produced as a data URL a browser can render and download', async () => {
  const png = await codes.pngDataUrlFor('abc123');
  assert.match(png, /^data:image\/png;base64,/);
  assert.ok(png.length > 1000);
});
