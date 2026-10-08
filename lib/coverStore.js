// Cover images, one per event, stored as the JPEG lib/coverImage.js made
// (re-encoded here, so none of the original's EXIF, location included,
// survives). The same shape as the account service's lib/photoStore.js:
// one file per thing, in DATA_DIR, on the volume.
//
// DATA_DIR/covers/<event's internal id>.jpg. Public: anyone with a cover's
// URL gets it (routes/covers.js), because link previews need it. The URL
// carries the cover's random key, never the event's id.

const fs = require('fs');
const path = require('path');
const { EVENT_ID_RE } = require('./ids');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DIR = path.join(DATA_DIR, 'covers');

function fileFor(eventId) {
  if (!EVENT_ID_RE.test(String(eventId))) throw new Error('bad event id');
  return path.join(DIR, `${eventId}.jpg`);
}

module.exports = {
  // Written to a temporary name and renamed into place, so a reader never
  // gets half a file.
  save(eventId, buffer) {
    fs.mkdirSync(DIR, { recursive: true });
    const file = fileFor(eventId);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, file);
  },
  pathFor(eventId) {
    const f = fileFor(eventId);
    return fs.existsSync(f) ? f : null;
  },
  remove(eventId) {
    const f = fileFor(eventId);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};
