// Co-hosts. Mounted at /api/v1.
//
// The creator adds and removes them. A co-host can do what the creator
// can, except: manage co-hosts, cancel the event (or take that back), and
// make a new link. A co-host may step down by themselves.
//
// Co-hosts have to be verified, like anyone who makes an event. The
// account service doesn't tell sites whether someone else is verified, so
// events goes by what it saw the last time that person used it (lib/store/
// people.js): someone who hasn't opened events while verified gets a 403
// `email_unverified`, with no `verify` link (it's not the caller's email).

const express = require('express');
const { handle, fail, loadEvent } = require('../lib/api');
const { PERSON_ID_RE } = require('../lib/ids');
const { inviteRefusal } = require('../lib/rules');
const { loadPeople } = require('../lib/people');
const { eventView } = require('../lib/views');
const { MAX_COHOSTS } = require('../lib/store/hosts');

module.exports = function hostsRoutes(ctx) {
  const { store, auth, notify } = ctx;
  const router = express.Router();
  const withEvent = loadEvent(store);

  function refuse(res, [status, reason, error]) {
    return fail(res, status, reason, error);
  }

  // The creator makes someone a co-host: { personId }.
  router.post('/events/:id/cohosts', auth.requireVerified, withEvent, handle(async (req, res) => {
    if (req.role !== 'creator') return fail(res, 403, 'creator_only', 'only the person who made this event can add co-hosts');
    const refusal = inviteRefusal(req.event);
    if (refusal) return refuse(res, refusal);
    const personId = (req.body || {}).personId;
    if (typeof personId !== 'string' || !PERSON_ID_RE.test(personId)) {
      return fail(res, 400, 'bad_person_id', 'personId is a person id');
    }
    const people = await loadPeople(ctx.canopy, [personId]);
    if (!people.has(personId)) return fail(res, 404, 'person_not_found', "there's no Canopy account with that id");
    if (personId !== req.person.id && !store.isKnownVerified(personId)) {
      return fail(res, 403, 'email_unverified',
        "they can't co-host yet: a co-host needs a verified email, and to have opened Canopy Events with it at least once");
    }
    const { outcome, promoted } = store.addCohost(req.event.id, personId, req.person.id);
    if (outcome === 'is_creator') return fail(res, 409, 'is_creator', "you're already this event's host");
    if (outcome === 'too_many') return fail(res, 409, 'too_many_cohosts', `an event can have at most ${MAX_COHOSTS} co-hosts`);
    if (outcome === 'added') notify('cohost_added', { to: [personId], actorId: req.person.id, eventId: req.event.id });
    if (promoted && promoted.length) notify('waitlist_promoted', { to: promoted, eventId: req.event.id });
    res.json({ event: await eventView(ctx, req, store.getEvent(req.event.id), { friendsGoing: true }) });
  }));

  // The creator takes a co-host off, or a co-host steps down. They're left
  // invited, so they can still answer.
  router.delete('/events/:id/cohosts/:personId', auth.requirePerson, withEvent, handle(async (req, res) => {
    const self = req.params.personId === req.person.id;
    if (req.role !== 'creator' && !(self && req.role === 'cohost')) {
      return fail(res, 403, 'creator_only', 'only the person who made this event can take off co-hosts');
    }
    const { outcome } = store.removeCohost(req.event.id, req.params.personId);
    if (outcome === 'not_cohost') return fail(res, 404, 'not_cohost', "that person isn't a co-host of this event");
    res.json({ event: await eventView(ctx, req, store.getEvent(req.event.id), { friendsGoing: true }) });
  }));

  return router;
};
