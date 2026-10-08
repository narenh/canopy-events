// The account service asking events to do something for its Account
// Manager's test people tools (its README, "Admin: test people"):
//
//   POST   /api/internal/test-friends         { personId, friendIds: [...] }
//          -> { added, alreadyFriends }
//   POST   /api/internal/test-friends/remove  { personIds: [...] }  -> { removed }
//   POST   /api/internal/test-events          { personId, testPeopleIds: [...], count }
//          -> { created }
//   DELETE /api/internal/test-events          -> { deleted }
//
// Mounted at /api/internal, outside /api/v1: not the apps' API, not in
// openapi.yaml, and nobody signs in to it. Only the account service can
// ask: each request is signed with the calendar secret
// (CANOPY_CALENDAR_SECRET), bound to its purpose ('test-friends' or
// 'test-events'), its method, its path and its body, within a minute and
// once (lib/canopy-account.js verifyInternalRequest). Anything else is a
// 401, and so is everything while the secret isn't set. The Origin check
// lets these through (server.js): they carry no cookie and read none.
//
// Events doesn't know who's a test person (the account service never
// tells a site). It takes the account service's word for the ids, which
// only ever sends is_test ones, and the admin's own as `personId`.

const express = require('express');
const { fail } = require('../lib/api');
const { PERSON_ID_RE } = require('../lib/ids');
const coverStore = require('../lib/coverStore');
const { TEST_EVENTS_MAX } = require('../lib/store/testEvents');

// As many as the account service allows test people at once.
const MAX_IDS = 200;
const MAX_COUNT = 20;

// A list of person ids, 1 to MAX_IDS, or null.
function idList(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_IDS) return null;
  return raw.every((id) => typeof id === 'string' && PERSON_ID_RE.test(id)) ? raw : null;
}

module.exports = function internalRoutes({ store, canopy }) {
  const router = express.Router();

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  const signed = (purpose) => (req, res, next) => {
    if (canopy.verifyInternalRequest(req, purpose)) return next();
    fail(res, 401, 'unauthorized', 'only the account service asks this, signed');
  };

  const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

  function badIds(res, raw, name) {
    if (Array.isArray(raw) && raw.length > MAX_IDS) return fail(res, 400, 'too_many_ids', `at most ${MAX_IDS} in ${name}`);
    return fail(res, 400, 'bad_ids', `${name} is a list of 1 to ${MAX_IDS} person ids`);
  }

  router.post('/test-friends', signed('test-friends'), (req, res) => {
    const { personId, friendIds } = body(req);
    if (typeof personId !== 'string' || !PERSON_ID_RE.test(personId)) return fail(res, 400, 'bad_person_id', "that isn't a person id");
    const ids = idList(friendIds);
    if (!ids) return badIds(res, friendIds, 'friendIds');
    res.json(store.addTestFriends(personId, ids));
  });

  router.post('/test-friends/remove', signed('test-friends'), (req, res) => {
    const { personIds } = body(req);
    const ids = idList(personIds);
    if (!ids) return badIds(res, personIds, 'personIds');
    res.json({ removed: store.removeFriendshipsOf(ids) });
  });

  router.post('/test-events', signed('test-events'), (req, res) => {
    const { personId, testPeopleIds, count } = body(req);
    if (typeof personId !== 'string' || !PERSON_ID_RE.test(personId)) return fail(res, 400, 'bad_person_id', "that isn't a person id");
    const ids = idList(testPeopleIds);
    if (!ids) return badIds(res, testPeopleIds, 'testPeopleIds');
    if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) return fail(res, 400, 'bad_count', `count is a whole number from 1 to ${MAX_COUNT}`);
    if (!ids.some((id) => id !== personId)) return fail(res, 400, 'bad_ids', 'testPeopleIds needs someone other than personId');
    if (store.countTestEvents() + count > TEST_EVENTS_MAX) {
      return fail(res, 409, 'too_many_test_events', `at most ${TEST_EVENTS_MAX} test events at once`);
    }
    res.json({ created: store.createTestEvents(personId, ids, count).length });
  });

  router.delete('/test-events', signed('test-events'), (req, res) => {
    const ids = store.deleteTestEvents();
    // Someone may have given one a cover since.
    ids.forEach((id) => { try { coverStore.remove(id); } catch (e) {} });
    res.json({ deleted: ids.length });
  });

  router.use((req, res) => fail(res, 404, 'not_found', 'not found'));

  return router;
};
