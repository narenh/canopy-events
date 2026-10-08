// The guest's ⋯ menu on an event page, for anyone on an event who isn't
// hosting it (invited, or with an answer). Mounted at /api/v1.
//
//   - **Mute** (PUT/DELETE /events/:id/mute): the chatter about the event
//     stops reaching them (wall posts, answers, co-hosts) and the
//     essentials don't (cancelled, back on, a new time or place, a spot off
//     the waitlist): lib/notify.js. Nothing changes on the guest list, and
//     nobody else can tell. `viewer.muted` says so.
//   - **Leave** (POST /events/:id/leave): off the event entirely, as if
//     they'd never been on it (lib/store/rsvps.js leaveEvent). Not a host's
//     removal: the link still works for them, and they can answer again.
//     There's no taking an answer back (routes/rsvps.js); this is the one
//     way off, and it's deliberate (the page asks first).
//   - **Opt out of a host's invitations** (GET /me/invite-optouts,
//     PUT/DELETE /me/invite-optouts/:personId): that person's invitations
//     to you are skipped from then on, and the host is told no more than
//     for someone with no account (routes/rsvps.js). Nothing about the
//     event you're on changes. Your list is yours alone.

const express = require('express');
const { handle, fail, loadEvent } = require('../lib/api');
const { PERSON_ID_RE } = require('../lib/ids');
const { loadPeople, personFrom } = require('../lib/people');
const { eventView } = require('../lib/views');

module.exports = function guestMenuRoutes(ctx) {
  const { store, auth, notify } = ctx;
  const router = express.Router();
  const withEvent = loadEvent(store);

  // Why this person can't mute or leave this event, or null: hosts have
  // their own controls (a co-host steps down instead), someone a host
  // removed has nothing to mute or leave, and someone who isn't on it
  // has nothing either.
  function guestRefusal(req) {
    if (req.role) return [409, 'is_host', "you're hosting this event; a co-host can step down instead"];
    const rsvp = store.getRsvp(req.event.id, req.person.id);
    if (!rsvp) return [409, 'not_on_event', "you aren't on this event"];
    if (rsvp.status === 'removed') return [409, 'removed', 'a host has removed you from this event'];
    return null;
  }

  router.put('/events/:id/mute', auth.requirePerson, withEvent, handle(async (req, res) => {
    const refusal = guestRefusal(req);
    if (refusal) return fail(res, ...refusal);
    store.muteEvent(req.event.id, req.person.id);
    res.json({ event: await eventView(ctx, req, req.event, { friendsGoing: true }) });
  }));

  // Unmuting is always fine, even off the event (it just does nothing).
  router.delete('/events/:id/mute', auth.requirePerson, withEvent, handle(async (req, res) => {
    store.unmuteEvent(req.event.id, req.person.id);
    res.json({ event: await eventView(ctx, req, req.event, { friendsGoing: true }) });
  }));

  // Answers with the event as they now see it: like anyone who opens the
  // link (viewer.rsvp null).
  router.post('/events/:id/leave', auth.requirePerson, withEvent, handle(async (req, res) => {
    const refusal = guestRefusal(req);
    if (refusal) return fail(res, ...refusal);
    const { promoted } = store.leaveEvent(req.event.id, req.person.id);
    if (promoted.length) notify('waitlist_promoted', { to: promoted, eventId: req.event.id });
    res.json({ event: await eventView(ctx, req, store.getEvent(req.event.id), { friendsGoing: true }) });
  }));

  // The people whose invitations you've opted out of, oldest first, as
  // the five public fields.
  router.get('/me/invite-optouts', auth.requirePerson, handle(async (req, res) => {
    const ids = store.inviteOptouts(req.person.id);
    const people = await loadPeople(ctx.canopy, ids);
    res.json({ hosts: ids.map((id) => personFrom(people, id)) });
  }));

  function personParam(req, res, next) {
    if (!PERSON_ID_RE.test(req.params.personId)) return fail(res, 400, 'bad_person_id', "that isn't a person id");
    if (req.params.personId === req.person.id) return fail(res, 409, 'is_you', "that's you");
    next();
  }

  // Both ways are idempotent: opting out twice, or back in when you
  // weren't out, is fine.
  router.put('/me/invite-optouts/:personId', auth.requirePerson, personParam, handle(async (req, res) => {
    const people = await loadPeople(ctx.canopy, [req.params.personId]);
    if (!people.has(req.params.personId)) return fail(res, 404, 'person_not_found', "there's no Canopy Account with that id");
    store.optOutOfInvites(req.person.id, req.params.personId);
    res.json({ ok: true });
  }));

  router.delete('/me/invite-optouts/:personId', auth.requirePerson, personParam, (req, res) => {
    store.optInToInvites(req.person.id, req.params.personId);
    res.json({ ok: true });
  });

  return router;
};
