// Who's coming: answering an event, the guest list, and invitations.
// Mounted at /api/v1.
//
// The statuses, and how they move (docs/api.md draws it):
//
//   (nobody)  --a host invites-->  invited
//   (nobody) or invited  --you answer-->  going | maybe | not_going
//   going | maybe | not_going  --you change it-->  any other answer
//   an answer  --you take it back-->  invited (if a host invited you),
//                                     otherwise off the list
//   invited  --the host takes it back-->  off the list
//
// 'waitlisted' is kept for capacity (v1 scope item 4) and nothing makes
// it yet. Hosts don't answer their own events: hosting is being there.

const express = require('express');
const { handle, fail, loadEvent, pageParams, paginate } = require('../lib/api');
const { guessLimits } = require('../lib/limits');
const { PERSON_ID_RE } = require('../lib/ids');
const { ANSWERS, ALL_STATUSES, isHost, canSeeGuestNames, visibleStatuses, answerRefusal, inviteRefusal } = require('../lib/rules');
const { loadPeople, personFrom } = require('../lib/people');
const { eventView, guestView } = require('../lib/views');

const DAY = 24 * 60 * 60 * 1000;

// Inviting: one invitation counts one, so 300 people per host a day, 600
// per address, 5,000 across everyone, and 100 in one request. An
// invitation puts an event in someone's list, so this is the spam limit.
// It matters more once hosts can find people by phone number (an
// invitation then reaches someone who's never been to anything of theirs).
const inviteLimits = guessLimits({ perWho: [300, DAY], perIp: [600, DAY], overall: [5000, DAY] });
const MAX_INVITES_PER_REQUEST = 100;

module.exports = function rsvpsRoutes(ctx) {
  const { store, auth } = ctx;
  const router = express.Router();
  const withEvent = loadEvent(store);

  function refuse(res, [status, reason, error]) {
    return fail(res, status, reason, error);
  }

  // Your answer, made or changed. { status, guests }: guests (plus-ones)
  // is 0 unless the host allows more.
  router.put('/events/:id/rsvp', auth.requirePerson, withEvent, handle(async (req, res) => {
    const body = req.body || {};
    if (!ANSWERS.includes(body.status)) return fail(res, 400, 'bad_status', "status is 'going', 'maybe' or 'not_going'");
    const guests = body.guests === undefined ? 0 : body.guests;
    if (!Number.isInteger(guests) || guests < 0) return fail(res, 400, 'bad_guests', 'guests is a whole number, 0 or more');
    if (guests > req.event.guestsAllowed) {
      return fail(res, 400, 'too_many_guests', req.event.guestsAllowed
        ? `you can bring at most ${req.event.guestsAllowed} ${req.event.guestsAllowed === 1 ? 'guest' : 'guests'}`
        : "this event isn't taking plus-ones");
    }
    const refusal = answerRefusal(req.event, req.role);
    if (refusal) return refuse(res, refusal);
    // Not going brings nobody.
    store.setAnswer(req.event.id, req.person.id, body.status, body.status === 'not_going' ? 0 : guests);
    res.json({ event: await eventView(ctx, req, req.event, { friendsGoing: true }) });
  }));

  // Takes your answer back: invited again if a host invited you,
  // otherwise off the list. Nothing to take back is fine too.
  router.delete('/events/:id/rsvp', auth.requirePerson, withEvent, handle(async (req, res) => {
    const refusal = answerRefusal(req.event, req.role);
    if (refusal) return refuse(res, refusal);
    store.withdrawAnswer(req.event.id, req.person.id);
    res.json({ event: await eventView(ctx, req, req.event, { friendsGoing: true }) });
  }));

  // The guest list, a page at a time, in the order people answered. Counts
  // always; names by the event's visibility rule (lib/rules.js). ?status=
  // narrows it to one status.
  router.get('/events/:id/guests', auth.requirePerson, withEvent, handle(async (req, res) => {
    const page = pageParams(req, res);
    if (!page) return;
    const event = req.event;
    const counts = store.countsFor([event.id]).get(event.id);
    let statuses = visibleStatuses(req.role);
    if (req.query.status !== undefined) {
      if (!ALL_STATUSES.includes(req.query.status)) {
        return fail(res, 400, 'bad_status', `status is one of ${ALL_STATUSES.join(', ')}`);
      }
      if (!statuses.includes(req.query.status)) return fail(res, 403, 'hosts_only', 'only hosts see who has been invited');
      statuses = [req.query.status];
    }
    const rsvp = store.getRsvp(event.id, req.person.id);
    if (!canSeeGuestNames(event, { person: req.person, role: req.role, rsvp })) {
      return res.json({ guestsVisible: false, guests: [], counts, nextCursor: null });
    }
    const rows = store.listGuests(event.id, statuses, { after: page.after, limit: page.limit + 1 });
    const { items, nextCursor } = paginate(rows, page.limit, (r) => [r.statusAt, r.personId]);
    const people = await loadPeople(ctx.canopy, items.map((r) => r.personId));
    res.json({ guestsVisible: true, guests: items.map((r) => guestView(r, people)), counts, nextCursor });
  }));

  // A host invites people by id: { personIds: [...] }. The web page offers
  // friends; the API takes anyone with a Canopy account, so the phone and
  // Instagram lookup (later) can feed it. Each id comes back either in
  // `invited` or in `skipped` with why.
  router.post('/events/:id/invites', auth.requirePerson, withEvent, handle(async (req, res) => {
    if (!isHost(req.role)) return fail(res, 403, 'hosts_only', 'only a host can invite people');
    const refusal = inviteRefusal(req.event);
    if (refusal) return refuse(res, refusal);
    const raw = (req.body || {}).personIds;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_INVITES_PER_REQUEST) {
      return fail(res, 400, 'bad_person_ids', `personIds is a list of 1 to ${MAX_INVITES_PER_REQUEST} person ids`);
    }
    if (!raw.every((id) => typeof id === 'string' && PERSON_ID_RE.test(id))) {
      return fail(res, 400, 'bad_person_ids', "that isn't a list of person ids");
    }
    const ids = Array.from(new Set(raw));
    if (inviteLimits.blocked(req, req.person.id, ids.length)) {
      return fail(res, 429, 'rate_limited', "that's a lot of invitations for one day -- try again tomorrow");
    }
    const people = await loadPeople(ctx.canopy, ids);
    const skipped = ids.filter((id) => !people.has(id)).map((personId) => ({ personId, reason: 'not_found' }));
    const results = store.invite(req.event.id, ids.filter((id) => people.has(id)), req.person.id);
    const invited = [];
    results.forEach(({ personId, outcome }) => {
      if (outcome === 'invited') invited.push(personFrom(people, personId));
      else skipped.push({ personId, reason: outcome });
    });
    if (invited.length) inviteLimits.hit(req, req.person.id, invited.length);
    res.json({ invited, skipped });
  }));

  // A host takes back an invitation nobody has answered yet. Once someone
  // has answered, it's their answer, and it stays.
  router.delete('/events/:id/invites/:personId', auth.requirePerson, withEvent, (req, res) => {
    if (!isHost(req.role)) return fail(res, 403, 'hosts_only', 'only a host can take back an invitation');
    const outcome = store.uninvite(req.event.id, req.params.personId);
    if (outcome === 'not_invited') return fail(res, 404, 'not_invited', "that person hasn't been invited");
    if (outcome === 'already_responded') return fail(res, 409, 'already_responded', "they've already answered, so the invitation stays");
    res.json({ ok: true });
  });

  return router;
};
