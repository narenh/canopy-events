// Cover images: hosts upload and remove them (mounted at /api/v1), and
// anyone with a cover's URL gets the image (`files`, mounted at /).
//
// Covers are **public**: no sign-in, no Origin, nothing. Link previews
// (iMessage, Slack, WhatsApp) fetch the image without anyone's cookie, and
// a preview without the picture is most of the point lost. What keeps
// that from giving anything away:
//
//   - the URL is /covers/<key>.jpg, where the key is random and changes
//     with every upload; it's never the event's id (which is its link);
//   - what's stored is re-encoded (lib/coverImage.js), so the photo's
//     EXIF, where it was taken included, isn't in it;
//   - a removed or replaced cover's URL stops working at once here
//     (caches may keep it up to COVER_MAX_AGE).
//
// Uploads are multipart/form-data with the image in a field named
// `cover`: JPEG, PNG, WebP or HEIC, up to MAX_UPLOAD.

const express = require('express');
const multer = require('multer');
const { handle, fail, loadEvent } = require('../lib/api');
const { guessLimits } = require('../lib/limits');
const { isHost } = require('../lib/rules');
const { newEventId } = require('../lib/ids');
const { eventView } = require('../lib/views');
const { toCoverJpeg, BadImage } = require('../lib/coverImage');
const coverStore = require('../lib/coverStore');

const DAY = 24 * 60 * 60 * 1000;
const MAX_UPLOAD = 15 * 1024 * 1024;
// How long a browser or a CDN may keep a cover. The URL changes with every
// upload, so this only matters for one that's been removed.
const COVER_MAX_AGE = 60 * 60;
const COVER_FILE_RE = /^([0-9A-Za-z]{12})\.jpg$/;

// Re-encoding a photo is real work, so uploads are limited: 30 a day per
// person, 100 per address, 2,000 across everyone.
const uploadLimits = guessLimits({ perWho: [30, DAY], perIp: [100, DAY], overall: [2000, DAY] });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD, files: 1, fields: 10, parts: 11 }
}).single('cover');

module.exports = function coverRoutes(ctx) {
  const { store, auth } = ctx;
  const router = express.Router();
  const withEvent = loadEvent(store);

  function hostsOnly(req, res, next) {
    if (!isHost(req.role)) return fail(res, 403, 'hosts_only', 'only a host can change the cover');
    next();
  }

  // multer, with its errors in the API's shape. Besides its own
  // MulterErrors, the form parser underneath (busboy) throws plain Errors
  // for a body that isn't a well-formed form ("Unexpected end of form" for
  // one cut off, a bad part header...). Memory storage can't fail on our
  // side, so every one of them is the upload's fault: a 400, not a 500.
  function receive(req, res, next) {
    upload(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') return fail(res, 413, 'too_large', `a cover is at most ${MAX_UPLOAD / 1024 / 1024} MB`);
      if (err instanceof multer.MulterError) return fail(res, 400, 'bad_image', "send one image, in a form field named 'cover'");
      fail(res, 400, 'bad_image', "that upload was cut off or isn't a form: send one image, in a form field named 'cover'");
    });
  }

  router.put('/events/:id/cover', auth.requirePerson, withEvent, hostsOnly, receive, handle(async (req, res) => {
    if (!req.file) return fail(res, 400, 'bad_image', "send one image, in a form field named 'cover'");
    if (uploadLimits.blocked(req, req.person.id)) {
      return fail(res, 429, 'rate_limited', "that's a lot of covers for one day -- try again tomorrow");
    }
    uploadLimits.hit(req, req.person.id);
    let jpeg;
    try {
      jpeg = await toCoverJpeg(req.file.buffer);
    } catch (err) {
      if (err instanceof BadImage) return fail(res, 400, 'bad_image', err.message);
      throw err;
    }
    let key = newEventId();
    while (store.getEventByCoverKey(key)) key = newEventId();
    coverStore.save(req.event.id, jpeg);
    const event = store.setCover(req.event.id, key);
    res.json({ event: await eventView(ctx, req, event, { friendsGoing: true }) });
  }));

  router.delete('/events/:id/cover', auth.requirePerson, withEvent, hostsOnly, handle(async (req, res) => {
    const event = store.setCover(req.event.id, null);
    coverStore.remove(req.event.id);
    res.json({ event: await eventView(ctx, req, event, { friendsGoing: true }) });
  }));

  return router;
};

// GET /covers/<key>.jpg, for anyone.
module.exports.files = function coverFiles(ctx) {
  const router = express.Router();
  router.get('/covers/:file', (req, res) => {
    const m = COVER_FILE_RE.exec(req.params.file);
    const event = m ? ctx.store.getEventByCoverKey(m[1]) : null;
    const file = event ? coverStore.pathFor(event.id) : null;
    if (!file) return res.status(404).end();
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', `public, max-age=${COVER_MAX_AGE}`);
    res.sendFile(file);
  });
  return router;
};

module.exports.MAX_UPLOAD = MAX_UPLOAD;
