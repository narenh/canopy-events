// You: yourself (no contact details) and your events. Mounted at /api/v1.
// Everything here needs you signed in. Your friends are routes/friends.js.

const express = require('express');
const { handle, pageParams, paginate } = require('../lib/api');
const { ownPerson } = require('../lib/people');
const { eventViews } = require('../lib/views');
const { MY_EVENT_LISTS } = require('../lib/store/events');

module.exports = function meRoutes(ctx) {
  const { store, auth, canopy } = ctx;
  const router = express.Router();

  // You: your id, name, photo, emailVerified and findable. No contact
  // details, not even your own (lib/people.js says why; the apps get them
  // from the account service's /api/native/v1/me). `verifyUrl` is where an unverified
  // account proves its email (apps show the same banner the pages do);
  // null once it's verified. `hasHosted`: whether they've ever hosted or
  // co-hosted an event (the app shows its Hosting tab only then). Once a
  // host, always a host: stepping down doesn't take it back.
  router.get('/me', auth.requirePerson, (req, res) => {
    const person = ownPerson(req.person);
    res.json({
      person,
      verifyUrl: person.emailVerified ? null : canopy.verifyUrl(req, auth.returnTo(req)),
      hasHosted: store.hasHosted(person.id)
    });
  });

  // Your events, in five lists (lib/store/events.js says what's in each):
  // /me/events/hosting, /upcoming, /invitations, /declined and /past.
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
