// Places, for the Location field (lib/places.js asks Apple Maps):
//
//   GET /api/v1/places/autocomplete?q=&near=lat,lng  suggestions as you type
//     (without near: near Cloudflare's guess at the asker's city, when
//     its visitor location headers are on, else PLACES_DEFAULT_NEAR)
//   GET /api/v1/places/{placeId}                     one of them, whole
//
// For people who can host (verified), like making an event. 120 calls a
// minute per person, the two counted together. With places off (no Apple
// Maps key), autocomplete answers `enabled: false` and no results, and the
// field is plain text; when Apple can't be asked, 502
// `places_unavailable`, and the same.

const express = require('express');
const { handle, fail } = require('../lib/api');
const { attemptLimiter } = require('../lib/limits');
const { parseNear, langFrom } = require('../lib/places');

const PER_MINUTE = 120;
const MIN_QUERY = 2;
const MAX_QUERY = 200;

module.exports = function placesRoutes(ctx) {
  const { auth, places } = ctx;
  const router = express.Router();
  const limit = attemptLimiter(PER_MINUTE, 60 * 1000);

  function limited(req, res, next) {
    const who = String(req.person.id);
    if (limit.blocked(who)) return fail(res, 429, 'rate_limited', 'too many place searches; try again in a minute');
    limit.hit(who);
    next();
  }

  function unavailable(res) {
    return fail(res, 502, 'places_unavailable', "places can't be looked up just now; type the place instead");
  }

  router.get('/places/autocomplete', auth.requireVerified, limited, handle(async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.replace(/\s+/g, ' ').trim() : '';
    if (q.length > MAX_QUERY) return fail(res, 400, 'bad_query', `q is at most ${MAX_QUERY} characters`);
    let near = null;
    if (req.query.near !== undefined && req.query.near !== '') {
      near = parseNear(req.query.near);
      if (!near) return fail(res, 400, 'bad_near', 'near is a latitude and longitude, like 37.77,-122.42');
    } else if (req.get('cf-iplatitude') && req.get('cf-iplongitude')) {
      // Cloudflare's guess at where the asker is, from their IP (its
      // "Add visitor location headers" transform): city-level, never
      // stored or logged. Only the bias of their own suggestions.
      near = parseNear(req.get('cf-iplatitude') + ',' + req.get('cf-iplongitude'));
    }
    if (!places.enabled) return res.json({ enabled: false, results: [] });
    if (q.length < MIN_QUERY) return res.json({ enabled: true, results: [] });
    const results = await places.autocomplete(q, { near, lang: langFrom(req.get('accept-language')) });
    if (!results) return unavailable(res);
    res.json({ enabled: true, results });
  }));

  router.get('/places/:placeId', auth.requireVerified, limited, handle(async (req, res) => {
    if (!places.enabled) return unavailable(res);
    const place = await places.resolve(req.params.placeId, { lang: langFrom(req.get('accept-language')) });
    if (place === false) return fail(res, 404, 'place_not_found', "there's no place with that id");
    if (!place) return unavailable(res);
    res.json({ place });
  }));

  return router;
};
