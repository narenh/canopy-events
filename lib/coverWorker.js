// The worker thread lib/coverImage.js runs cover conversions in, so the
// WebAssembly HEIC decoder (synchronous, most of a second for a big
// photo) never holds up the main thread's requests. One message in, one
// out:
//
//   - { kind: 'cover', buf }: an upload. Every size of it, and the hue
//     that matches it: { ok: true, sizes: [{ width, height, jpeg }], hue,
//     grayscale }.
//   - { kind: 'stored', buf }: a cover stored before there were sizes
//     (lib/coverBackfill.js). Its smaller sizes: { ok: true, sizes } with
//     the last (the stored file itself) having jpeg null.
//
// Or { ok: false, bad, message }, with `bad` saying it's the image's fault
// (a 400) rather than ours (a 500).

const { parentPort } = require('worker_threads');
const { convertSizes, resizeStored, hueOf, BadImage } = require('./coverImage');

parentPort.on('message', async ({ kind, buf }) => {
  try {
    const input = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    if (kind === 'stored') {
      parentPort.postMessage({ ok: true, sizes: await resizeStored(input) });
      return;
    }
    const sizes = await convertSizes(input);
    // The hue is a suggestion: a failure there loses the suggestion, never
    // the cover.
    let match = { hue: null, grayscale: false };
    try { match = await hueOf(sizes[sizes.length - 1].jpeg); } catch (e) {}
    // Copied, not transferred: sharp's buffers live outside the JS heap,
    // where they can't be handed over, and a cover is a few hundred KB.
    parentPort.postMessage({ ok: true, sizes, hue: match.hue, grayscale: match.grayscale });
  } catch (err) {
    parentPort.postMessage({ ok: false, bad: err instanceof BadImage, message: err instanceof BadImage ? err.message : String(err && err.stack || err) });
  }
});
