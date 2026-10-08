// Host moderation. Mounted at /api/v1.
//
//   - Removing someone (hosts, co-hosts included): their status becomes
//     `removed`. They can't answer again, they're off the guest list (and
//     its counts) for everyone but a host who asks for ?status=removed,
//     their "going" leaves the wall and their posts are hidden, and any
//     spot they held goes to the waitlist. They still see what anyone
//     signed out sees: the event is the link, and hiding it from them
//     alone would hide nothing (they could sign out). Not the address,
//     the guest list, the wall or friends going. A host can undo it,
//     which leaves them invited. Nobody is notified either way, and their
//     own notifications about the event are deleted (each one carries the
//     event's link, which a new link may be about to replace).
//   - Making a new link (the creator only): the event gets a new id, the
//     old one is a 404 like any wrong link, and everyone keeps their place
//     (lib/db.js, version 6). For a link that got out.

const express = require('express');
const { handle, fail, loadEvent } = require('../lib/api');
const { PERSON_ID_RE, newEventId } = require('../lib/ids');
const { isHost } = require('../lib/rules');
const { loadPeople } = require('../lib/people');
const { eventView } = require('../lib/views');

module.exports = function moderationRoutes(ctx) {
  const { store, auth, notify } = ctx;
  const router = express.Router();
  const withEvent = loadEvent(store);

  function hostsOnly(req, res, next) {
    if (!isHost(req.role)) return fail(res, 403, 'hosts_only', 'only a host can do that');
    next();
  }

  function personParam(req, res, next) {
    if (!PERSON_ID_RE.test(req.params.personId)) return fail(res, 400, 'bad_person_id', "that isn't a person id");
    next();
  }

  router.put('/events/:id/removed/:personId', auth.requirePerson, withEvent, hostsOnly, personParam, handle(async (req, res) => {
    const personId = req.params.personId;
    // Someone with no row yet can be removed ahead of time, if they exist.
    if (!store.getRsvp(req.event.id, personId) && !store.hostRole(req.event.id, personId)) {
      const people = await loadPeople(ctx.canopy, [personId]);
      if (!people.has(personId)) return fail(res, 404, 'person_not_found', "there's no Canopy account with that id");
    }
    const { outcome, promoted } = store.removeGuest(req.event.id, personId);
    if (outcome === 'is_host') {
      return fail(res, 409, 'is_host', "hosts can't be removed; the creator can take a co-host off first");
    }
    if (promoted.length) notify('waitlist_promoted', { to: promoted, eventId: req.event.id });
    res.json({ ok: true });
  }));

  router.delete('/events/:id/removed/:personId', auth.requirePerson, withEvent, hostsOnly, personParam, (req, res) => {
    const outcome = store.restoreGuest(req.event.id, req.params.personId, req.person.id);
    if (outcome === 'not_removed') return fail(res, 404, 'not_removed', "that person hasn't been removed");
    res.json({ ok: true });
  });

  router.post('/events/:id/new-link', auth.requirePerson, withEvent, handle(async (req, res) => {
    if (req.role !== 'creator') return fail(res, 403, 'creator_only', 'only the person who made this event can make a new link');
    let id = newEventId();
    while (store.isEventIdTaken(id)) id = newEventId();
    const event = store.setEventLink(req.event.id, id);
    res.json({ event: await eventView(ctx, req, event, { friendsGoing: true }) });
  }));

  return router;
};
