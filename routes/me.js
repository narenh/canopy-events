// You: your own details, your friends, and your events. Mounted at
// /api/v1. Everything here needs you signed in.

const express = require('express');
const { handle, pageParams, paginate } = require('../lib/api');
const { ownPerson, loadPeople, publicPerson } = require('../lib/people');
const { eventViews, iso } = require('../lib/views');
const { MY_EVENT_LISTS } = require('../lib/store/events');

module.exports = function meRoutes(ctx) {
  const { store, auth, canopy } = ctx;
  const router = express.Router();

  // The only place anyone's email, phone, Instagram, Venmo or Cash App
  // comes back, and it's your own. `verifyUrl` is where an unverified
  // account proves its email (apps show the same banner the pages do);
  // null once it's verified.
  router.get('/me', auth.requirePerson, (req, res) => {
    const person = ownPerson(req.person);
    res.json({ person, verifyUrl: person.emailVerified ? null : canopy.verifyUrl(req, auth.returnTo(req)) });
  });

  // Your friends (lib/store/friends.js says who counts), most events in
  // common first. Former members are left out: there's nobody to invite.
  router.get('/me/friends', auth.requirePerson, handle(async (req, res) => {
    const page = pageParams(req, res);
    if (!page) return;
    const rows = store.friendsOf(req.person.id, { after: page.after, limit: page.limit + 1 });
    const { items, nextCursor } = paginate(rows, page.limit, (r) => [r.eventsInCommon, r.personId]);
    const people = await loadPeople(canopy, items.map((r) => r.personId));
    const friends = items
      .filter((r) => people.has(r.personId))
      .map((r) => ({ person: publicPerson(people.get(r.personId)), eventsInCommon: r.eventsInCommon, lastTogetherAt: iso(r.lastTogetherAt) }));
    res.json({ friends, nextCursor });
  }));

  // Your events, in four lists (lib/store/events.js says what's in each):
  // /me/events/hosting, /upcoming, /invitations and /past.
  MY_EVENT_LISTS.forEach((name) => {
    router.get(`/me/events/${name}`, auth.requirePerson, handle(async (req, res) => {
      const page = pageParams(req, res);
      if (!page) return;
      const rows = store.listMyEvents(name, req.person.id, { after: page.after, limit: page.limit + 1 });
      const { items, nextCursor } = paginate(rows, page.limit, (e) => [e.startsAt, e.id]);
      res.json({ events: await eventViews(ctx, req, items), nextCursor });
    }));
  });

  return router;
};
