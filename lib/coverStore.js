// Cover images, one per event, stored as the JPEGs lib/coverImage.js made
// (re-encoded here, so none of the original's EXIF, location included,
// survives). The same shape as the account service's lib/photoStore.js:
// files in DATA_DIR, on the volume.
//
// DATA_DIR/covers/<event's internal id>.jpg is the full size, and
// <event's internal id>-<width>.jpg each narrower copy of it (400, 800,
// 1200: lib/coverImage.js WIDTHS, only those narrower than the photo).
// Public: anyone with a cover's URL gets it (routes/covers.js), because
// link previews need it. The URL carries the cover's random key, never
// the event's id: /covers/<key>.jpg and /covers/<key>-<width>.jpg.
//
// Names are built here from an event id (checked against EVENT_ID_RE) and
// a whole number, never from anything a request sent.

const fs = require('fs');
const path = require('path');
const { EVENT_ID_RE } = require('./ids');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DIR = path.join(DATA_DIR, 'covers');

function fileFor(eventId, width = null) {
  if (!EVENT_ID_RE.test(String(eventId))) throw new Error('bad event id');
  if (width === null) return path.join(DIR, `${eventId}.jpg`);
  if (!Number.isInteger(width) || width < 1 || width > 99999) throw new Error('bad cover width');
  return path.join(DIR, `${eventId}-${width}.jpg`);
}

// Written to a temporary name and renamed into place, so a reader never
// gets half a file.
function write(file, buffer) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, buffer);
  fs.renameSync(tmp, file);
}

// The widths of the narrower copies on disk for an event.
function variantWidths(eventId) {
  fileFor(eventId);
  const re = new RegExp(`^${eventId}-(\\d{1,5})\\.jpg$`);
  let names = [];
  try { names = fs.readdirSync(DIR); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return names.map((n) => re.exec(n)).filter(Boolean).map((m) => Number(m[1]));
}

function unlink(file) {
  try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

module.exports = {
  DIR,

  // A new cover: `sizes` is [{ width, height, jpeg }] narrowest first, the
  // last being the full size.
  // The narrower copies go first, the full size last, and any copy the
  // last cover had that this one hasn't (it was wider) is removed.
  save(eventId, sizes) {
    fs.mkdirSync(DIR, { recursive: true });
    const full = sizes[sizes.length - 1];
    const smaller = sizes.slice(0, -1);
    smaller.forEach((s) => write(fileFor(eventId, s.width), s.jpeg));
    write(fileFor(eventId), full.jpeg);
    const keep = new Set(smaller.map((s) => s.width));
    variantWidths(eventId).filter((w) => !keep.has(w)).forEach((w) => unlink(fileFor(eventId, w)));
  },

  // The narrower copies of the cover already stored (lib/coverBackfill.js):
  // `sizes` as from coverImage.toStoredSizes(), whose last entry (the
  // stored file itself) is left alone.
  saveSmaller(eventId, sizes) {
    fs.mkdirSync(DIR, { recursive: true });
    sizes.slice(0, -1).forEach((s) => write(fileFor(eventId, s.width), s.jpeg));
  },

  // The file for the full size (no width) or one narrower copy, or null.
  pathFor(eventId, width = null) {
    const f = fileFor(eventId, width);
    return fs.existsSync(f) ? f : null;
  },

  // Another event's cover, as its own files (duplicating an event,
  // routes/events.js): the full size and each narrower copy in `widths`
  // that's on disk, so removing or replacing either event's cover never
  // touches the other's. All or nothing: a copy that fails part way is
  // taken back off, and the error goes to the caller.
  copy(fromId, toId, widths = []) {
    fs.mkdirSync(DIR, { recursive: true });
    const one = (width) => {
      const tmp = `${fileFor(toId, width)}.${process.pid}.${Date.now()}.tmp`;
      fs.copyFileSync(fileFor(fromId, width), tmp);
      fs.renameSync(tmp, fileFor(toId, width));
    };
    try {
      widths.filter((w) => fs.existsSync(fileFor(fromId, w))).forEach(one);
      one(null);
    } catch (err) {
      this.remove(toId);
      throw err;
    }
  },

  // The full size and every narrower copy.
  remove(eventId) {
    variantWidths(eventId).forEach((w) => unlink(fileFor(eventId, w)));
    unlink(fileFor(eventId));
  },

  variantWidths
};
