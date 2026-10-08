// Events' part of everyone's Canopy calendar: GET /api/calendar/<personId>,
// asked by the account service (never by a browser or an app), which
// merges every site's answer into the person's one calendar feed
// (account.canopysf.com/cal/<secret>.ics). Mounted at /api/calendar,
// outside /api/v1: it isn't the apps' API, and nobody signs in to it.
//
// Only the account service can ask. Its request is signed with the
// calendar secret the account admin's Sites tab showed for events
// (CANOPY_CALENDAR_SECRET here), and lib/canopy-account.js
// verifyCalendarRequest checks the signature, the person it's for and the
// time. Anything else is a 401, and so is every request while the secret
// isn't set. The account service's README ("GET <site>/api/calendar/
// <personId>") is the contract; this is events' side of it.
//
// What's in it, for that person (lib/rules.js calendarStatus):
//
//   - events they host or co-host, or said going to: confirmed;
//   - maybe, or on the waitlist: tentative, and the description says so;
//   - any of those that's been cancelled: cancelled, until 30 days after
//     it was to start;
//   - can't go, removed, only invited: not in it;
//   - from 90 days ago on (by start), and everything coming up.
//
// Each entry is what that person sees on the event's page, and less: the
// title, when, the place and its address (everyone in the calendar may see
// the address: they're signed in and on the event), the host's
// description, and the link. Never anyone else: no guest names, no hosts'
// names, nobody's contact details. The feed ends up on Google's and
// Apple's servers.
//
// The UID is the event's own id (events.id), which never changes, not its
// link (public_id), which "new link" replaces: a calendar app would take a
// new UID for a new event and show it twice. The link in the entry is the
// current one, so after a new link the entry points at the right page.

const express = require('express');
const { fail } = require('../lib/api');
const { publicBase, BASE } = require('../lib/domain');
const { PERSON_ID_RE } = require('../lib/ids');
const { calendarStatus, CALENDAR_PAST_MS } = require('../lib/rules');

const iso = (ms) => new Date(ms).toISOString();

// The line at the top of the description: their part in it.
function partLine(status, { role, rsvp, guests }) {
  if (status === 'cancelled') return 'This event was cancelled.';
  const plus = guests > 0 ? ` (plus ${guests} guest${guests === 1 ? '' : 's'})` : '';
  if (role === 'creator') return "You're hosting.";
  if (role === 'cohost') return "You're co-hosting.";
  if (rsvp === 'waitlisted') return `On the waitlist${plus}.`;
  if (rsvp === 'maybe') return `You said maybe${plus}.`;
  return `You're going${plus}.`;
}

function entryFor(req, row, now) {
  const { event } = row;
  const status = calendarStatus(event, row, now);
  if (!status) return null;
  const url = `${publicBase(req)}/e/${event.publicId}`;
  const description = [partLine(status, row), event.description, url].filter(Boolean).join('\n\n');
  // When anything in the entry last changed: the event, or their part in
  // it (an answer, a plus-one, being made a co-host).
  const updatedAt = Math.max(event.updatedAt, row.hostAt || 0, row.rsvpAt || 0, row.respondedAt || 0);
  return {
    uid: `${event.id}@events.${BASE}`,
    title: event.title,
    start: iso(event.startsAt),
    end: event.endsAt != null ? iso(event.endsAt) : null,
    allDay: false,
    timeZone: event.timeZone,
    location: [event.locationName, event.locationAddress].filter(Boolean).join(', ') || null,
    url,
    status,
    description,
    updatedAt: iso(updatedAt)
  };
}

module.exports = function calendarRoutes({ store, canopy }) {
  const router = express.Router();

  router.get('/:personId', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const personId = canopy.verifyCalendarRequest(req);
    if (!personId) return fail(res, 401, 'unauthorized', 'only the account service asks this, signed');
    if (!PERSON_ID_RE.test(personId)) return fail(res, 400, 'bad_person_id', "that isn't a person id");
    const now = Date.now();
    const entries = store.calendarEventsFor(personId, now - CALENDAR_PAST_MS)
      .map((row) => entryFor(req, row, now))
      .filter(Boolean);
    res.json({ entries });
  });

  return router;
};
