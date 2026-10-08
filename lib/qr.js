// A QR code as an inline SVG, drawn on the server for the friends page
// (your friend link). The encoding is qrcode-generator's (Kazuhiko Arase's,
// MIT, no dependencies); the drawing is here, because its own SVG is one
// <path> square per dark module, and this is one run per row.
//
// - Error correction M (15%): the usual for something shown on a screen
//   and scanned by a phone camera. The smallest version that fits is
//   picked: a production friend link (https://events.canopysf.com/f/ and
//   12 characters, 42 bytes) is version 3, 29 modules square.
// - The text goes in as UTF-8 bytes (qrcode-generator's byte mode takes
//   one character per byte, so it's handed the bytes as Latin-1).
// - A quiet zone of 4 modules all round, which the standard asks for, and
//   black on white whatever the page's colours: scanners want the
//   contrast, and some can't read a light-on-dark code.
// - It scales with its box (a viewBox and no fixed size), and
//   shape-rendering keeps the modules' edges sharp.
//
// Pure: text in, a string out. test/qr.test.js renders it to pixels with
// sharp and reads it back with jsQR.

const qrcode = require('qrcode-generator');

const QUIET = 4;

// { svg, version, size } for `text`; `label` is what a screen reader says.
function qrSvg(text, { label = '' } = {}) {
  const qr = qrcode(0, 'M');
  qr.addData(Buffer.from(String(text), 'utf8').toString('latin1'), 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  let d = '';
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n;) {
      if (!qr.isDark(y, x)) { x++; continue; }
      let run = 1;
      while (x + run < n && qr.isDark(y, x + run)) run++;
      d += `M${x + QUIET} ${y + QUIET}h${run}v1h-${run}z`;
      x += run;
    }
  }
  const size = n + QUIET * 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img"`
    + (label ? ` aria-label="${String(label).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)}"` : ' aria-hidden="true"')
    + `><rect width="${size}" height="${size}" fill="#fff"/><path fill="#000" d="${d}"/></svg>`;
  return { svg, version: (n - 17) / 4, size: n };
}

module.exports = { qrSvg, QUIET };
