// Events themselves: making one, reading one, editing one (which includes
// cancelling it, and taking that back), and deleting one. Mounted at
// /api/v1.
//
// Cancelling is how an event that's off is told to everyone: it keeps its
// link, its guest list and its history, so people who had it in their
// calendar can open it and see that it's off. Deleting (the creator only)
// is for an event that shouldn't exist at all: everything under it goes,
// and the link is a 404 like any wrong one. Nobody is told.

const express = require('express');
const coverStore = require('../lib/coverStore');
const { handle, fail, loadEvent } = require('../lib/api');
const { guessLimits } = require('../lib/limits');
const { cleanEventInput } = require('../lib/eventInput');
const { newEventId, EVENT_ID_RE } = require('../lib/ids');
const { isHost } = require('../lib/rules');
const { eventView } = require('../lib/views');

const DAY = 24 * 60 * 60 * 1000;

// Making events: 20 per person a day, 60 per address, 1,000 a day across
// everyone. Plenty for anyone actually throwing parties, and a ceiling on
// what a script with a stolen session (or a pile of fresh accounts) can
// fill the database with.
const createLimits = guessLimits({ perWho: [20, DAY], perIp: [60, DAY], overall: [1000, DAY] });

module.exports = function eventsRoutes(ctx) {
  const { store, auth, notify } = ctx;
  const router = express.Router();
  const withEvent = loadEvent(store);

  function refuse(res, [status, reason, error, extra]) {
    return fail(res, status, reason, error, extra);
  }

  // Verified people only: a quick account proves its email first.
  //
  // `coverFrom` (an event's id, from a duplicate draft below) starts the
  // new event with a copy of that event's cover: its own files and its own
  // key, so the two never share one. Only from an event the caller hosts
  // that has a cover; checked before anything is made, so a refusal
  // leaves nothing behind.
  router.post('/events', auth.requireVerified, handle(async (req, res) => {
    if (createLimits.blocked(req, req.person.id)) {
      return fail(res, 429, 'rate_limited', "that's a lot of events for one day -- try again tomorrow");
    }
    const { fields, error } = cleanEventInput(req.body, null);
    if (error) return refuse(res, error);
    const coverFrom = req.body && req.body.coverFrom;
    let source = null;
    if (coverFrom !== undefined && coverFrom !== null) {
      source = typeof coverFrom === 'string' && EVENT_ID_RE.test(coverFrom) ? store.getEventByLink(coverFrom) : null;
      if (!source) return fail(res, 400, 'bad_cover_from', "coverFrom is the id of an event you host, and there's no event at that one");
      if (!isHost(store.hostRole(source.id, req.person.id))) return fail(res, 403, 'hosts_only', "only a host of that event can copy its cover");
      if (!source.coverKey || !coverStore.pathFor(source.id)) return fail(res, 400, 'no_cover', "that event has no cover to copy any more");
    }
    let id = newEventId();
    while (store.isEventIdTaken(id)) id = newEventId();
    // The files first: if copying them fails, there's no event either.
    if (source) coverStore.copy(source.id, id, (source.coverSizes || []).slice(0, -1).map((s) => s.width));
    let event = store.createEvent(id, req.person.id, fields);
    if (source) {
      let key = newEventId();
      while (store.getEventByCoverKey(key)) key = newEventId();
      event = store.setCover(id, key, { hue: source.coverHue, grayscale: source.coverGrayscale, sizes: source.coverSizes });
    }
    createLimits.hit(req, req.person.id);
    res.status(201).json({ event: await eventView(ctx, req, event, { friendsGoing: true }) });
  }));

  // Duplicating an event: what a copy of it starts with, for the editor
  // to show (nothing is made until the host saves, with POST /events).
  // Everything about the event itself, except when: an event can't exist
  // without a start, so the date and times are the host's to pick. Not
  // its people (guests, invitations, co-hosts), its wall or its lists:
  // attaching a list invites everyone on it, so `lists` names the
  // caller's own lists that were on it, for the host to attach again
  // themselves. The cover is copied on save (`coverFrom`). Any host who
  // may make events.
  router.get('/events/:id/duplicate-draft', auth.requireVerified, withEvent, handle(async (req, res) => {
    if (!isHost(req.role)) return fail(res, 403, 'hosts_only', 'only a host can duplicate this event');
    const e = await eventView(ctx, req, req.event, { friendsGoing: true });
    const draft = {
      title: e.title,
      description: e.description,
      timeZone: e.timeZone,
      locationName: e.locationName,
      locationAddress: e.locationAddress,
      details: e.details.map((d) => ({ type: d.type, label: d.label, value: d.value })),
      guestListVisibility: e.guestListVisibility,
      guestsAllowed: e.guestsAllowed,
      capacity: e.capacity,
      themeHue: e.themeHue,
      themeGrayscale: e.themeGrayscale,
      accentHue: e.accentHue,
      coverFrom: e.coverImageUrl ? e.id : null,
      coverImageUrl: e.coverImageUrl,
      coverImages: e.coverImages,
      coverHue: e.coverHue,
      coverGrayscale: e.coverGrayscale,
      lists: (e.hostLists || []).filter((l) => l.isYours).map((l) => ({ id: l.id, name: l.name }))
    };
    res.json({ draft });
  }));

  // Anyone with the link, signed in or not (lib/views.js says what a
  // signed-out caller gets).
  router.get('/events/:id', withEvent, handle(async (req, res) => {
    res.json({ event: await eventView(ctx, req, req.event, { friendsGoing: true }) });
  }));

  // Hosts (the creator and co-hosts). Any of the fields from making it,
  // plus status: 'cancelled' to cancel it, 'active' to take that back,
  // which only the creator may send.
  router.patch('/events/:id', auth.requirePerson, withEvent, handle(async (req, res) => {
    if (!isHost(req.role)) return fail(res, 403, 'hosts_only', 'only a host can change this event');
    const { fields, error } = cleanEventInput(req.body, req.event);
    if (error) return refuse(res, error);
    // Cancelling, and taking it back, is the creator's call alone.
    if (fields.status !== undefined && req.role !== 'creator') {
      return fail(res, 403, 'creator_only', 'only the person who made this event can cancel it');
    }
    const { event, happened, promoted } = store.editEvent(req.event.id, fields, req.person.id);
    // Everyone coming (going, maybe, waitlisted) and the other hosts hear
    // about a new time or place, and about cancelling or taking it back.
    const tell = { to: store.audienceOf(event.id), actorId: req.person.id, eventId: event.id };
    const changed = ['time', 'place'].filter((k) => happened[k]);
    if (changed.length) notify('event_changed', { ...tell, details: { changed } });
    if (happened.cancelled) notify('event_cancelled', tell);
    if (happened.uncancelled) notify('event_uncancelled', tell);
    if (promoted.length) notify('waitlist_promoted', { to: promoted, eventId: event.id });
    res.json({ event: await eventView(ctx, req, event, { friendsGoing: true }) });
  }));

  // The creator deletes the event: it, its hosts, answers, wall and
  // everyone's inbox entries about it (the database cascades), and the
  // cover's file. No notification: there's no event left to open, and
  // cancelling is the way to tell people it's off.
  router.delete('/events/:id', auth.requirePerson, withEvent, (req, res) => {
    if (req.role !== 'creator') return fail(res, 403, 'creator_only', 'only the person who made this event can delete it');
    store.deleteEvent(req.event.id);
    coverStore.remove(req.event.id);
    res.json({ ok: true });
  });

  return router;
};
