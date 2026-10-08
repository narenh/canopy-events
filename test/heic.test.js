// HEIC covers: the decoder gives back what it takes, every time, and the
// conversion runs off the main thread so the server keeps answering while
// it works (lib/coverImage.js, lib/coverWorker.js).
//
// fixtures/cover-2mp.heic is a 1600x1200 photo of noise (so it's slow to
// decode, like a real photo, and big enough that a leak shows);
// fixtures/cover-26mp.heic is a plain 5800x4400 one, just over the HEIC
// limit.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const libheif = require('libheif-js/wasm-bundle');
const { convert, toCoverJpeg, BadImage, MAX_HEIC_PIXELS, _stopWorker } = require('../lib/coverImage');
const { startServer, client, makeEvent } = require('./harness');

const PHOTO = fs.readFileSync(path.join(__dirname, 'fixtures', 'cover-2mp.heic'));
const TOO_BIG = fs.readFileSync(path.join(__dirname, 'fixtures', 'cover-26mp.heic'));
const MB = 1024 * 1024;

test('HEIC decoding frees its WebAssembly memory, on every path', async () => {
  assert.ok(5800 * 4400 > MAX_HEIC_PIXELS, 'the too-big fixture is over the limit');
  // The heap grows to fit the biggest decode, then has to stay put. Before
  // the fix it grew by about twice the file's size with every upload.
  const heap = () => libheif.HEAPU8.length;
  for (let i = 0; i < 3; i++) await convert(PHOTO);
  const settled = heap();
  for (let i = 0; i < 12; i++) await convert(PHOTO);
  assert.ok(heap() - settled <= 2 * MB, `heap grew ${((heap() - settled) / MB).toFixed(1)} MB over 12 conversions`);

  // Too big: refused before decoding, and nothing kept either.
  const before = heap();
  for (let i = 0; i < 12; i++) {
    await assert.rejects(convert(TOO_BIG), (e) => e instanceof BadImage && /too big/.test(e.message));
  }
  assert.ok(heap() - before <= 2 * MB, `heap grew ${((heap() - before) / MB).toFixed(1)} MB over 12 refusals`);
});

test("converting the same HEIC over and over doesn't make the process grow", async () => {
  // Through the worker, as the server does it. A loose bound: the point is
  // that it levels off, where a leak climbs with every upload.
  for (let i = 0; i < 3; i++) await toCoverJpeg(PHOTO);
  global.gc && global.gc();
  const settled = process.memoryUsage().rss;
  for (let i = 0; i < 20; i++) {
    const jpeg = await toCoverJpeg(PHOTO);
    assert.equal((await sharp(jpeg).metadata()).format, 'jpeg');
  }
  const grew = process.memoryUsage().rss - settled;
  assert.ok(grew < 80 * MB, `RSS grew ${(grew / MB).toFixed(0)} MB over 20 conversions`);
  // A file that won't parse is a BadImage, and the next one still works
  // (the worker is replaced after a failure).
  await assert.rejects(toCoverJpeg(Buffer.from('\0\0\0\x18ftypheic\0\0\0\0not really a photo')), BadImage);
  assert.equal((await sharp(await toCoverJpeg(PHOTO)).metadata()).format, 'jpeg');
  await assert.rejects(toCoverJpeg(TOO_BIG), /too big/);
  _stopWorker();
});

test('the server keeps answering while it converts a HEIC', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const ana = client(server, 'ana');
  const e = await makeEvent(ana);
  const upload = () => ana.upload('PUT', `/api/v1/events/${e.id}/cover`, PHOTO);
  // The first upload starts the worker; time a second one.
  assert.equal((await upload()).status, 200);

  const started = Date.now();
  let done = false;
  const putting = upload().finally(() => { done = true; });
  const waits = [];
  while (!done) {
    const t0 = Date.now();
    const r = await fetch(`${server.base}/healthz`);
    assert.equal(r.status, 200);
    await r.text();
    waits.push(Date.now() - t0);
  }
  const r = await putting;
  const took = Date.now() - started;
  assert.equal(r.status, 200, r.text);
  // On the main thread, one /healthz would wait out the whole decode (most
  // of the upload's time). Off it, every one comes back quickly: well
  // under half the upload's time, however slow this machine is.
  assert.ok(waits.length >= 2, `only ${waits.length} /healthz answered during a ${took} ms upload`);
  const slowest = Math.max(...waits);
  assert.ok(slowest < took / 2, `a /healthz took ${slowest} ms during a ${took} ms upload`);
});
