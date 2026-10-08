// The worker thread lib/coverImage.js runs cover conversions in, so the
// WebAssembly HEIC decoder (synchronous, most of a second for a big
// photo) never holds up the main thread's requests. One message in ({
// buf }), one out: { ok: true, jpeg, hue, grayscale } or { ok: false, bad, message }, with
// `bad` saying it's the image's fault (a 400) rather than ours (a 500).

const { parentPort } = require('worker_threads');
const { convert, hueOf, BadImage } = require('./coverImage');

parentPort.on('message', async ({ buf }) => {
  try {
    const jpeg = await convert(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength));
    // The hue is a suggestion: a failure there loses the suggestion, never
    // the cover.
    let match = { hue: null, grayscale: false };
    try { match = await hueOf(jpeg); } catch (e) {}
    // Copied, not transferred: sharp's buffers live outside the JS heap,
    // where they can't be handed over, and a cover is a few hundred KB.
    parentPort.postMessage({ ok: true, jpeg, hue: match.hue, grayscale: match.grayscale });
  } catch (err) {
    parentPort.postMessage({ ok: false, bad: err instanceof BadImage, message: err instanceof BadImage ? err.message : String(err && err.stack || err) });
  }
});
