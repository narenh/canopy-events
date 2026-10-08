// Events themselves: making one, reading one, and editing one (which
// includes cancelling it, and taking that back). Mounted at /api/v1.
//
// There's no deleting. A cancelled event keeps its link, its guest list
// and its history, so the people who had it in their calendar can open it
// and see that it's off.

const express = require('express');
const { handle, fail, loadEvent } = require('../lib/api');
const { guessLimits } = require('../lib/limits');
const { cleanEventInput } = require('../lib/eventInput');
const { newEventId } = require('../lib/ids');
const { isHost } = require('../lib/rules');
const { eventView } = require('../lib/views');

const DAY = 24 * 60 * 60 * 1000;

// Making events: 20 per person a day, 60 per address, 1,000 a day across
// everyone. Plenty for anyone actually throwing parties, and a ceiling on
// what a script with a stolen session (or a pile of fresh accounts) can
// fill the database with.
const createLimits = guessLimits({ perWho: [20, DAY], perIp: [60, DAY], overall: [1000, DAY] });

module.exports = function eventsRoutes(ctx) {
  const { store, auth } = ctx;
  const router = express.Router();
  const withEvent = loadEvent(store);

  function refuse(res, [status, reason, error]) {
    return fail(res, status, reason, error);
  }

  // Verified people only: a quick account proves its email first.
  router.post('/events', auth.requireVerified, handle(async (req, res) => {
    if (createLimits.blocked(req, req.person.id)) {
      return fail(res, 429, 'rate_limited', "that's a lot of events for one day -- try again tomorrow");
    }
    const { fields, error } = cleanEventInput(req.body, null);
    if (error) return refuse(res, error);
    let id = newEventId();
    while (store.getEvent(id)) id = newEventId();
    const event = store.createEvent(id, req.person.id, fields);
    createLimits.hit(req, req.person.id);
    res.status(201).json({ event: await eventView(ctx, req, event, { friendsGoing: true }) });
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
    const event = store.updateEvent(req.event.id, fields);
    res.json({ event: await eventView(ctx, req, event, { friendsGoing: true }) });
  }));

  return router;
};
