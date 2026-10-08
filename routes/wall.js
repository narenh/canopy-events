// The activity wall: posts from hosts and guests, and the server's own
// entries ("Ana is going", "the time changed"). Mounted at /api/v1.
//
//   - Reading: anyone who can see the guest list's names (lib/rules.js).
//     It's full of names, so it follows the same rule. Anyone else signed
//     in gets `wallVisible: false` and no entries, like the guest list.
//   - Posting: hosts, and anyone going, maybe, or on the waitlist.
//   - Deleting: your own posts; hosts delete anything.
//
// Posts are plain text, up to MAX_POST characters, kept as written (only
// trimmed). Nothing here is ever HTML: whoever shows a post escapes it.

const express = require('express');
const { handle, fail, loadEvent, pageParams, paginate } = require('../lib/api');
const { guessLimits } = require('../lib/limits');
const { canReadWall, canPost, canDeleteWallEntry } = require('../lib/rules');
const { loadPeople } = require('../lib/people');
const { wallEntryView } = require('../lib/views');

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const MAX_POST = 1000;
const ENTRY_ID_RE = /^[1-9][0-9]{0,15}$/;

// Posting: 5 a minute and 100 a day per person; per address 20 a minute
// and 300 a day; and across everyone 300 a minute and 5,000 a day. A
// conversation never comes near; a script pasting into every event it
// has a link to does.
const burstLimits = guessLimits({ perWho: [5, MINUTE], perIp: [20, MINUTE], overall: [300, MINUTE] });
const dailyLimits = guessLimits({ perWho: [100, DAY], perIp: [300, DAY], overall: [5000, DAY] });

module.exports = function wallRoutes(ctx) {
  const { store, auth } = ctx;
  const router = express.Router();
  const withEvent = loadEvent(store);

  function viewerOf(req) {
    return { person: req.person, role: req.role, rsvp: store.getRsvp(req.event.id, req.person.id) };
  }

  // A page of the wall, newest first.
  router.get('/events/:id/wall', auth.requirePerson, withEvent, handle(async (req, res) => {
    const page = pageParams(req, res);
    if (!page) return;
    const viewer = viewerOf(req);
    const posting = canPost(viewer.role, viewer.rsvp);
    if (!canReadWall(req.event, viewer)) return res.json({ wallVisible: false, entries: [], canPost: posting, nextCursor: null });
    const rows = store.listWall(req.event.id, { after: page.after, limit: page.limit + 1 });
    const { items, nextCursor } = paginate(rows, page.limit, (w) => [w.createdAt, w.id]);
    const people = await loadPeople(ctx.canopy, items.map((w) => w.personId));
    res.json({ wallVisible: true, entries: items.map((w) => wallEntryView(w, people, viewer)), canPost: posting, nextCursor });
  }));

  // A post: { text }.
  router.post('/events/:id/wall', auth.requirePerson, withEvent, handle(async (req, res) => {
    const viewer = viewerOf(req);
    if (!canPost(viewer.role, viewer.rsvp)) {
      return fail(res, 403, 'answer_first', "say you're going or maybe to post here");
    }
    const raw = (req.body || {}).text;
    const text = typeof raw === 'string' ? raw.replace(/\r\n/g, '\n').trim() : '';
    if (!text) return fail(res, 400, 'bad_text', 'a post needs some text');
    if (text.length > MAX_POST) return fail(res, 400, 'bad_text', `a post is at most ${MAX_POST.toLocaleString('en-US')} characters`);
    if (burstLimits.blocked(req, req.person.id) || dailyLimits.blocked(req, req.person.id)) {
      return fail(res, 429, 'rate_limited', "that's a lot of posts -- try again in a bit");
    }
    burstLimits.hit(req, req.person.id);
    dailyLimits.hit(req, req.person.id);
    const entry = store.addPost(req.event.id, req.person.id, text);
    const people = await loadPeople(ctx.canopy, [req.person.id]);
    res.status(201).json({ entry: wallEntryView(entry, people, viewer) });
  }));

  // Deletes a post or entry: your own post, or anything if you're a host.
  router.delete('/events/:id/wall/:entryId', auth.requirePerson, withEvent, (req, res) => {
    const entry = ENTRY_ID_RE.test(req.params.entryId) ? store.getWallEntry(req.event.id, Number(req.params.entryId)) : null;
    if (!entry) return fail(res, 404, 'entry_not_found', "that isn't on this event's wall");
    if (!canDeleteWallEntry(entry, { person: req.person, role: req.role })) {
      return fail(res, 403, 'not_yours', 'you can only delete your own posts');
    }
    store.deleteWallEntry(req.event.id, entry.id);
    res.json({ ok: true });
  });

  return router;
};

module.exports.MAX_POST = MAX_POST;
