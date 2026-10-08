// An uploaded cover, whatever the phone or browser sent (JPEG, PNG, WebP
// or HEIC), made into the JPEGs that are stored and served: the full size
// (at most MAX_SIDE) and narrower copies of it (WIDTHS), so a phone
// drawing a 116 px thumbnail doesn't download a 1600 px photo.
//
// Unlike the account service's photos, which the browser crops to a small
// JPEG before uploading, a cover comes from apps as well as the page, so
// the server does the work, with sharp (libvips, prebuilt for Linux and
// macOS, nothing compiled): the photo is turned the right way up from
// its EXIF orientation, shrunk to fit MAX_SIDE, flattened onto white if it
// has transparency, and written as a quality-82 JPEG. sharp writes no
// metadata unless asked, so the EXIF (where it was taken, the camera) is
// gone: covers are public.
//
// sharp's prebuilt libvips reads HEIF only for AVIF, not the HEVC kind
// iPhones save, so HEIC is decoded by heic-decode (libheif compiled to
// WebAssembly, so still nothing native) into pixels sharp takes from
// there. The type is told by the file's first bytes, never by the name or
// the Content-Type the client sent.
//
// **Off the main thread.** The WebAssembly decoder is synchronous: a
// 12-megapixel iPhone photo holds whatever thread runs it for most of a
// second. On the main thread that's every request in the server waiting,
// so toCoverJpeg() hands the whole conversion to a worker thread
// (lib/coverWorker.js), one upload at a time, and the server keeps
// answering. One worker, started when it's needed:
//
//   - jobs queue and run one at a time (covers are rare, and one decode
//     can take a few hundred MB at the top of the size range);
//   - it's stopped after IDLE_MS with nothing to do, which hands back the
//     WebAssembly heap (it only ever grows while the worker lives);
//   - it's stopped after any job that fails, so whatever a broken file
//     left behind in the decoder (heic-decode doesn't free its decoder
//     when a file won't parse) goes with it;
//   - a job that takes longer than JOB_TIMEOUT_MS stops it too, and is
//     refused as an image that couldn't be read.
//
// `convert()` is the work itself, in whichever thread calls it: the worker
// runs it, and tests call it directly. `hueOf()` is the hue that matches
// the result (`coverHue`), worked out in the worker too, straight after.
//
// **Sizes.** The photo is decoded once, turned, shrunk to fit MAX_SIDE and
// flattened, into plain pixels; every size is encoded from those: the
// full one, and each of WIDTHS narrower than it (never wider: a photo 600
// px wide is stored at 400 and 600). All JPEG, at the same QUALITY
// (docs/decision-log.md, "Cover image sizes", says why not WebP).
// `resizeStored()` does the same for a cover stored before sizes existed
// (lib/coverBackfill.js): the smaller sizes from the stored JPEG, which
// itself is left exactly as it is.


const path = require('path');
const { Worker } = require('worker_threads');

// Big enough for a full-width header on a laptop, small enough to load fast
// on a phone.
const MAX_SIDE = 1600;
// A 48-megapixel phone photo is the biggest worth taking; more is
// probably a decompression bomb.
const MAX_PIXELS = 50 * 1000 * 1000;
// HEIC is decoded whole into memory (WebAssembly heap, then a copy for
// sharp: about 10 bytes a pixel, twice over), where sharp reads the other
// formats a piece at a time. 25 megapixels takes the 12 and 24 megapixel
// photos iPhones save by default; a 48-megapixel "HEIF Max" one is
// refused (the app shrinks it first, and Safari sends the web page a JPEG).
const MAX_HEIC_PIXELS = 25 * 1000 * 1000;
const QUALITY = 82;
// The narrower copies, in pixels wide: a list thumbnail on any phone
// (116 or 168 CSS px, at 2x or 3x), the hero on a 2x phone or a desktop at
// 1x, and the hero on a 3x phone (375-414 CSS px). The full size, up to
// 1600, is the rest (a desktop at 2x, link previews).
const WIDTHS = [400, 800, 1200];
const IDLE_MS = 30 * 1000;
const JOB_TIMEOUT_MS = 30 * 1000;

class BadImage extends Error {}

const HEIF_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'];

// 'jpeg', 'png', 'webp', 'heic', or null, from the first bytes.
function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (buf.toString('latin1', 4, 8) === 'ftyp' && HEIF_BRANDS.includes(buf.toString('latin1', 8, 12))) return 'heic';
  return null;
}

// sharp, loaded (and set up) only where a conversion actually runs: the
// worker, not the main thread.
let sharpLib = null;
function sharp() {
  if (!sharpLib) {
    sharpLib = require('sharp');
    // One image at a time, and nothing kept between: covers are rare,
    // memory is shared with everything else.
    sharpLib.concurrency(1);
    sharpLib.cache(false);
  }
  return sharpLib;
}

// The decoded pixels of a HEIC's first image, as a sharp input. Everything
// heic-decode allocates in the WebAssembly heap is freed before this
// returns or throws, on every path: without that, each upload kept about
// twice the file's size there, for good.
async function heicPixels(buf) {
  const decode = require('heic-decode');
  let images;
  try {
    images = await decode.all({ buffer: buf });
  } catch (e) {
    throw new BadImage('that HEIC file could not be read');
  }
  try {
    const first = images[0];
    if (!first) throw new BadImage('that HEIC file has no image in it');
    if (first.width * first.height > MAX_HEIC_PIXELS) throw new BadImage('that image is too big');
    const { width, height, data } = await first.decode();
    return sharp()(Buffer.from(data.buffer, data.byteOffset, data.byteLength), { raw: { width, height, channels: 4 } });
  } finally {
    images.dispose();
  }
}

// The widths a cover `width` pixels wide is stored at, narrowest first:
// each of WIDTHS narrower than it, then its own.
function widthsFor(width) {
  return [...WIDTHS.filter((w) => w < width), width];
}

// Every size of a cover, from its pixels (sharp's raw output and its
// info): [{ width, height, jpeg }], narrowest first. With `full: false`
// the last (the full size) has no jpeg: the caller already has it.
async function encodeSizes(pixels, info, { full = true } = {}) {
  const raw = { raw: { width: info.width, height: info.height, channels: info.channels } };
  const out = [];
  for (const width of widthsFor(info.width)) {
    if (width === info.width) {
      out.push({ width, height: info.height, jpeg: full ? await sharp()(pixels, raw).jpeg({ quality: QUALITY }).toBuffer() : null });
    } else {
      const { data, info: made } = await sharp()(pixels, raw).resize({ width }).jpeg({ quality: QUALITY }).toBuffer({ resolveWithObject: true });
      out.push({ width: made.width, height: made.height, jpeg: data });
    }
  }
  return out;
}

// The pixels a sharp pipeline ends in, 8-bit sRGB with no alpha: what
// every size is made from.
function pixelsOf(pipeline) {
  return pipeline.toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
}

// Every size of the stored cover for an upload, [{ width, height, jpeg }]
// narrowest first (the last is the full size), or a BadImage to show the
// person. Runs in the calling thread.
async function convertSizes(buf) {
  const type = sniff(buf);
  if (!type) throw new BadImage('a cover is a JPEG, PNG, WebP or HEIC photo');
  try {
    const input = type === 'heic' ? await heicPixels(buf) : sharp()(buf, { limitInputPixels: MAX_PIXELS, failOn: 'error' });
    const { data, info } = await pixelsOf(input
      .rotate()
      .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' }));
    return await encodeSizes(data, info);
  } catch (e) {
    if (e instanceof BadImage) throw e;
    throw new BadImage('that image could not be read');
  }
}

// Just the full-size JPEG.
async function convert(buf) {
  const sizes = await convertSizes(buf);
  return sizes[sizes.length - 1].jpeg;
}

// The sizes of a cover stored before there were any (a JPEG convert()
// made, so upright, with no EXIF and no alpha): [{ width, height, jpeg }],
// the last being the stored file itself, with jpeg null.
async function resizeStored(jpeg) {
  try {
    const { data, info } = await pixelsOf(sharp()(jpeg, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).flatten({ background: '#ffffff' }));
    return await encodeSizes(data, info, { full: false });
  } catch (e) {
    throw new BadImage('that stored cover could not be read');
  }
}

// The hue that matches a stored cover, for `coverHue`: the photo shrunk
// to 64×64 and handed to public/ui.js's hueFromPixels (the same code the
// editor runs on a photo just picked). { hue, grayscale }: grayscale is a
// photo with essentially no colour, which gets no hue.
async function hueOf(jpeg) {
  const { data, info } = await sharp()(jpeg).resize(64, 64, { fit: 'inside' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const hue = require('../public/ui.js').hueFromPixels(data, info.channels);
  return { hue, grayscale: hue === null };
}

// ---------------- The worker ----------------

let worker = null;
let idleTimer = null;
const queue = [];
let running = null;

function stopWorker() {
  clearTimeout(idleTimer);
  idleTimer = null;
  if (!worker) return;
  const w = worker;
  worker = null;
  w.removeAllListeners();
  // Its 'exit' after this doesn't concern anyone.
  w.on('error', () => {});
  w.terminate().catch(() => {});
}

function startWorker() {
  const w = new Worker(path.join(__dirname, 'coverWorker.js'));
  w.on('message', (msg) => finish(w, msg));
  w.on('error', (err) => finish(w, { ok: false, crashed: err }));
  w.on('exit', (code) => finish(w, { ok: false, crashed: new Error(`the cover worker stopped (exit ${code})`) }));
  return w;
}

function finish(w, msg) {
  if (w !== worker || !running) {
    if (w === worker) stopWorker();
    return;
  }
  const job = running;
  running = null;
  clearTimeout(job.timer);
  if (msg.ok) {
    const sizes = msg.sizes.map((s) => ({ width: s.width, height: s.height, jpeg: s.jpeg ? Buffer.from(s.jpeg.buffer, s.jpeg.byteOffset, s.jpeg.byteLength) : null }));
    job.resolve({ sizes, jpeg: sizes[sizes.length - 1].jpeg, hue: msg.hue, grayscale: msg.grayscale });
  } else {
    // Whatever failed, the next job gets a fresh worker.
    stopWorker();
    job.reject(msg.crashed || (msg.bad ? new BadImage(msg.message) : new Error(msg.message)));
  }
  next();
}

function next() {
  if (running) return;
  const job = queue.shift();
  if (!job) {
    clearTimeout(idleTimer);
    if (worker) {
      // Waiting for work doesn't keep the process alive (a script that
      // made a cover can end); a job running does.
      worker.unref();
      idleTimer = setTimeout(stopWorker, IDLE_MS).unref();
    }
    return;
  }
  clearTimeout(idleTimer);
  idleTimer = null;
  if (!worker) worker = startWorker();
  worker.ref();
  running = job;
  job.timer = setTimeout(() => {
    if (running !== job) return;
    running = null;
    stopWorker();
    job.reject(new BadImage('that image took too long to read'));
    next();
  }, JOB_TIMEOUT_MS);
  job.timer.unref();
  worker.postMessage({ kind: job.kind, buf: job.buf });
}

function enqueue(kind, buf) {
  return new Promise((resolve, reject) => {
    queue.push({ kind, buf, resolve, reject, timer: null });
    next();
  });
}

// The stored JPEGs for an upload and the hue that matches them, made in
// the worker: { sizes: [{ width, height, jpeg }] (narrowest first), jpeg
// (the full size), hue, grayscale }. A BadImage to show the person, or any
// other error for a 500.
function toCover(buf) {
  if (!sniff(buf)) return Promise.reject(new BadImage('a cover is a JPEG, PNG, WebP or HEIC photo'));
  return enqueue('cover', buf);
}

// Just the full-size JPEG.
function toCoverJpeg(buf) {
  return toCover(buf).then((c) => c.jpeg);
}

// The smaller sizes of a cover stored before there were any, made in the
// worker, behind any upload already waiting: { sizes } as resizeStored()
// says (the last, the stored file, has jpeg null).
function toStoredSizes(jpeg) {
  return enqueue('stored', jpeg).then(({ sizes }) => ({ sizes }));
}

module.exports = { toCover, toCoverJpeg, toStoredSizes, convert, convertSizes, resizeStored, widthsFor, hueOf, WIDTHS, QUALITY, sniff, BadImage, MAX_SIDE, MAX_PIXELS, MAX_HEIC_PIXELS, _stopWorker: stopWorker };
