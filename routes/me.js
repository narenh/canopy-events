// You: yourself (no contact details) and your events. Mounted at /api/v1.
// Everything here needs you signed in. Your friends are routes/friends.js.

const express = require('express');
const { handle, fail, pageParams, paginate } = require('../lib/api');
const { DEFAULTS: SETTINGS_DEFAULTS } = require('../lib/store/settings');
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

  // Your settings (lib/store/settings.js has each, and its default).
  // Today one: `calendarInvites`, whether events you're invited to and
  // haven't answered go in your Canopy calendar, marked "[INVITED]"
  // (routes/calendar.js). On unless you turn it off.
  router.get('/me/settings', auth.requirePerson, (req, res) => {
    res.json(store.settingsOf(req.person.id));
  });

  // Change some: only the ones given change. A setting this doesn't know,
  // or a value of the wrong type, is a 400 and changes nothing.
  router.patch('/me/settings', auth.requirePerson, (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(res, 400, 'bad_settings', 'send the settings to change as a JSON object');
    const unknown = Object.keys(body).filter((k) => !Object.prototype.hasOwnProperty.call(SETTINGS_DEFAULTS, k));
    if (unknown.length) return fail(res, 400, 'unknown_setting', `there's no setting called ${unknown[0]}`);
    if (body.calendarInvites !== undefined && typeof body.calendarInvites !== 'boolean') {
      return fail(res, 400, 'bad_calendar_invites', 'calendarInvites is true or false');
    }
    res.json(store.updateSettings(req.person.id, body));
  });

  // Your events, in six lists (lib/store/events.js says what's in each):
  // /me/events/hosting, /upcoming, /invitations, /declined, /all and /past.
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
