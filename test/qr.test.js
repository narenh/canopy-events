// The friend link's QR code (lib/qr.js): it scans. Each SVG is rendered to
// pixels with sharp (librsvg, the same as the cover pipeline uses) and read
// back with jsQR, a decoder written independently of the encoder, so a
// code that only looks right would fail here. Plus its version and size,
// for the production link and a longer local one.

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const jsQR = require('jsqr');
const { qrSvg, QUIET } = require('../lib/qr');

async function decode(svg, width) {
  const { data, info } = await sharp(Buffer.from(svg), { density: 300 })
    .resize(width, width, { kernel: 'nearest' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const found = jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), info.width, info.height);
  return found && found.data;
}

test('a friend link QR code scans back to the link', async () => {
  const links = [
    'https://events.canopysf.com/f/7Hq2mXc9LpRt',
    'http://localhost:3001/f/0123456789az',
    'https://events.canopysf.com/f/ZZZZZZZZZZZZ'
  ];
  for (const url of links) {
    const { svg } = qrSvg(url, { label: 'QR code' });
    for (const width of [180, 360]) assert.equal(await decode(svg, width), url, `${url} at ${width}px`);
  }
});

test('the production link is version 3 (29 modules), with a 4-module quiet zone', () => {
  const { svg, version, size } = qrSvg('https://events.canopysf.com/f/7Hq2mXc9LpRt');
  assert.equal(version, 3);
  assert.equal(size, 29);
  assert.match(svg, new RegExp(`viewBox="0 0 ${29 + 2 * QUIET} ${29 + 2 * QUIET}"`));
  // The finder pattern's top row starts inside the quiet zone, at (4, 4).
  assert.match(svg, /d="M4 4h7v1h-7z/);
  // Black on white, sharp edges, nothing but the two shapes.
  assert.match(svg, /<rect [^>]*fill="#fff"\/><path fill="#000" d="[Mhvz0-9 -]+"\/><\/svg>$/);
  assert.match(svg, /shape-rendering="crispEdges"/);
});

test('the label is escaped, and without one the code is hidden from screen readers', () => {
  assert.match(qrSvg('x', { label: 'Ana "<b>"' }).svg, /aria-label="Ana &#34;&#60;b&#62;&#34;"/);
  assert.match(qrSvg('x').svg, /aria-hidden="true"/);
});
