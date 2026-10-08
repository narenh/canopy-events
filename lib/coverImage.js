// An uploaded cover, whatever the phone or browser sent (JPEG, PNG, WebP
// or HEIC), made into the JPEG that's stored and served.
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

const sharp = require('sharp');

// Big enough for a full-width header on a laptop, small enough to load fast
// on a phone.
const MAX_SIDE = 1600;
// A 48-megapixel phone photo is the biggest worth taking; more is
// probably a decompression bomb.
const MAX_PIXELS = 50 * 1000 * 1000;
const QUALITY = 82;

// One image at a time, and nothing kept between: covers are rare, memory
// is shared with everything else.
sharp.concurrency(1);
sharp.cache(false);

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

async function heicPixels(buf) {
  const decode = require('heic-decode');
  let images;
  try {
    images = await decode.all({ buffer: buf });
  } catch (e) {
    throw new BadImage('that HEIC file could not be read');
  }
  const first = images && images[0];
  if (!first) throw new BadImage('that HEIC file has no image in it');
  if (first.width * first.height > MAX_PIXELS) throw new BadImage('that image is too big');
  const { width, height, data } = await first.decode();
  return sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), { raw: { width, height, channels: 4 } });
}

// The stored JPEG for an upload, or a BadImage to show the person.
async function toCoverJpeg(buf) {
  const type = sniff(buf);
  if (!type) throw new BadImage('a cover is a JPEG, PNG, WebP or HEIC photo');
  try {
    const input = type === 'heic' ? await heicPixels(buf) : sharp(buf, { limitInputPixels: MAX_PIXELS, failOn: 'error' });
    return await input
      .rotate()
      .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: QUALITY })
      .toBuffer();
  } catch (e) {
    if (e instanceof BadImage) throw e;
    throw new BadImage('that image could not be read');
  }
}

module.exports = { toCoverJpeg, sniff, BadImage, MAX_SIDE, MAX_PIXELS };
