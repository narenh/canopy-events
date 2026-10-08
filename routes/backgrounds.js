// The curated backgrounds a host can choose as a cover (lib/backgrounds.js
// has where they come from; routes/covers.js makes one the cover).
//
// GET /api/v1/backgrounds, signed in: { enabled, backgrounds }. `enabled`
// false (and none) means the feature is off, or nothing could be loaded
// yet: show no picker. The set is the same for everyone and changes at
// most daily, so this one answer may be kept a while.

const express = require('express');
const { handle } = require('../lib/api');

const MAX_AGE = 60 * 60;

module.exports = function backgroundRoutes(ctx) {
  const { auth, backgrounds } = ctx;
  const router = express.Router();

  router.get('/backgrounds', auth.requirePerson, handle(async (req, res) => {
    const set = await backgrounds.list();
    res.set('Cache-Control', `private, max-age=${MAX_AGE}`);
    res.json({ enabled: set.length > 0, backgrounds: set.map(backgrounds.view) });
  }));

  return router;
};
