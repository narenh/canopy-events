// Lists: your own lists of people, who join by a link or QR code, and
// attaching them to events you host. Mounted at /api/v1.
// lib/store/lists.js has the rules; in short:
//
//   - **Yours** (/me/lists): make one (verified people only, like
//     hosting), rename it, delete it, see and take off its members, and
//     reset its link. Only you ever see who's on a list of yours, and only
//     as the public Person shape.
//   - **Ones you're on** (/me/list-memberships): each one's name and
//     owner, and leaving. Never who else is on it, nor how many.
//   - **The link** (/list-links/{code}, the page /l/<code>): anyone with
//     it sees the list's name and owner, signed in or not, and joining
//     takes a deliberate POST. Joining your own list is a 409.
//   - **On events** (/events/{id}/lists/{listId}): a host attaches a list
//     of their own, which invites everyone on it; anyone who joins later
//     is invited too, while the event is still to come.
//
// Joining doesn't make you and the owner friends. An invitation does, as
// every invitation does.

const express = require('express');
const { handle, fail, loadEvent, pageParams, paginate } = require('../lib/api');
const { attemptLimiter, guessLimits, clientIp } = require('../lib/limits');
const { PERSON_ID_RE, LIST_ID_RE, LIST_CODE_RE } = require('../lib/ids');
const { loadPeople, publicPerson, personFrom } = require('../lib/people');
const { isHost, inviteRefusal } = require('../lib/rules');
const { eventView, iso } = require('../lib/views');
const { publicBase } = require('../lib/domain');
const { MAX_LISTS, MAX_MEMBERS, MAX_LISTS_PER_EVENT } = require('../lib/store/lists');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MAX_NAME = 60;

// Making lists: 20 a person a day, 60 an address, 1,000 across everyone.
const createLimits = guessLimits({ perWho: [20, DAY], perIp: [60, DAY], overall: [1000, DAY] });
// Joining, the same as adding friends (routes/friends.js): every try
// counts, so it can't be used to test codes in bulk either.
const joinLimits = guessLimits({ perWho: [200, DAY], perIp: [500, DAY], overall: [5000, DAY] });
// List links that find nothing, per address. Codes can't be guessed (71
// bits); this keeps anyone from trying for long.
const linkMisses = attemptLimiter(60, HOUR);

// A list's name: 1 to 60 characters, trimmed, on one line.
function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/\s+/g, ' ').trim();
  if (!name || Array.from(name).length > MAX_NAME || /[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

module.exports = function listsRoutes(ctx) {
  const { store, auth, canopy, notify } = ctx;
  const router = express.Router();
  const withEvent = loadEvent(store);

  function linkUrl(req, code) {
    return `${publicBase(req)}/l/${code}`;
  }

  // A list of yours, as you see it.
  function ownedView(req, l) {
    return { id: l.id, name: l.name, code: l.code, url: linkUrl(req, l.code), memberCount: l.memberCount, createdAt: iso(l.createdAt) };
  }

  // The list at :listId if it's the caller's, or a 404 sent. Someone
  // else's list is the same 404 as none: whether it exists is the owner's
  // business.
  function ownList(req, res) {
    const list = LIST_ID_RE.test(req.params.listId) ? store.getList(req.params.listId) : null;
    if (!list || list.ownerId !== String(req.person.id)) {
      fail(res, 404, 'list_not_found', "you don't have a list with that id");
      return null;
    }
    return list;
  }

  // The list whose link is :code, with its owner's name and photo, or a
  // 404 (or 429) sent. Unknown codes count against the address.
  async function linkList(req, res) {
    const ip = clientIp(req);
    if (linkMisses.blocked(ip)) {
      fail(res, 429, 'rate_limited', "that's a lot of list links that didn't work -- try again later");
      return null;
    }
    const list = LIST_CODE_RE.test(req.params.code) ? store.listByCode(req.params.code) : null;
    if (!list) {
      linkMisses.hit(ip);
      fail(res, 404, 'list_link_not_found', "that list link doesn't work (it may have been reset)");
      return null;
    }
    const people = await loadPeople(canopy, [list.ownerId]);
    if (!people.has(list.ownerId)) {
      fail(res, 404, 'list_link_not_found', "that list link doesn't work (it may have been reset)");
      return null;
    }
    return { list, owner: publicPerson(people.get(list.ownerId)) };
  }

  // ---------------- Your lists ----------------

  // Yours, oldest first, each with how many are on it. Not paginated:
  // nobody has more than MAX_LISTS.
  router.get('/me/lists', auth.requirePerson, (req, res) => {
    res.json({ lists: store.listsOf(String(req.person.id)).map((l) => ownedView(req, l)) });
  });

  // A new list: { name }. Verified people only, the same as making an
  // event: lists are for inviting.
  router.post('/me/lists', auth.requireVerified, (req, res) => {
    const name = cleanName((req.body || {}).name);
    if (!name) return fail(res, 400, 'bad_name', `a list's name is 1 to ${MAX_NAME} characters`);
    if (createLimits.blocked(req, req.person.id)) return fail(res, 429, 'rate_limited', "that's a lot of lists for one day -- try again tomorrow");
    const list = store.createList(String(req.person.id), name);
    if (!list) return fail(res, 409, 'too_many_lists', `you can have at most ${MAX_LISTS} lists`);
    createLimits.hit(req, req.person.id);
    res.status(201).json({ list: ownedView(req, list) });
  });

  // A new name: { name }.
  router.patch('/me/lists/:listId', auth.requirePerson, (req, res) => {
    const list = ownList(req, res);
    if (!list) return;
    const name = cleanName((req.body || {}).name);
    if (!name) return fail(res, 400, 'bad_name', `a list's name is 1 to ${MAX_NAME} characters`);
    res.json({ list: ownedView(req, store.renameList(list.id, name)) });
  });

  // Gone, with its members and its place on events. Invitations it made
  // stay. Nobody is told.
  router.delete('/me/lists/:listId', auth.requirePerson, (req, res) => {
    const list = ownList(req, res);
    if (!list) return;
    store.deleteList(list.id);
    res.json({ ok: true });
  });

  // A new link (and QR code); the old one stops working. Members stay.
  router.post('/me/lists/:listId/reset-link', auth.requirePerson, (req, res) => {
    const list = ownList(req, res);
    if (!list) return;
    res.json({ list: ownedView(req, store.resetListCode(list.id)) });
  });

  // Who's on it, newest first: each as the public Person shape, with when
  // they joined. Only ever to the owner. Deleted accounts are left out.
  router.get('/me/lists/:listId/members', auth.requirePerson, handle(async (req, res) => {
    const list = ownList(req, res);
    if (!list) return;
    const page = pageParams(req, res);
    if (!page) return;
    const rows = store.membersOf(list.id, { after: page.after, limit: page.limit + 1 });
    const { items, nextCursor } = paginate(rows, page.limit, (r) => [r.joinedAt, r.personId]);
    const people = await loadPeople(canopy, items.map((r) => r.personId));
    const members = items.filter((r) => people.has(r.personId)).map((r) => ({ person: publicPerson(people.get(r.personId)), joinedAt: iso(r.joinedAt) }));
    res.json({ members, nextCursor });
  }));

  // Take someone off. They aren't told; invitations they had stay. They
  // can join again with the link (reset it to stop that).
  router.delete('/me/lists/:listId/members/:personId', auth.requirePerson, (req, res) => {
    const list = ownList(req, res);
    if (!list) return;
    if (!PERSON_ID_RE.test(req.params.personId)) return fail(res, 400, 'bad_person_id', "that isn't a person id");
    if (!store.removeMember(list.id, req.params.personId)) return fail(res, 404, 'not_a_member', "they aren't on that list");
    res.json({ ok: true });
  });

  // ---------------- Lists you're on ----------------

  // Each list's name and owner, and when you joined, newest first. Not who
  // else is on it, nor how many.
  router.get('/me/list-memberships', auth.requirePerson, handle(async (req, res) => {
    const rows = store.membershipsOf(String(req.person.id));
    const people = await loadPeople(canopy, rows.map((r) => r.ownerId));
    res.json({
      lists: rows.map((r) => ({ id: r.id, name: r.name, owner: personFrom(people, r.ownerId), joinedAt: iso(r.joinedAt) }))
    });
  }));

  // Leave a list. The owner isn't told. Invitations you had stay.
  router.delete('/me/list-memberships/:listId', auth.requirePerson, (req, res) => {
    if (!LIST_ID_RE.test(req.params.listId) || !store.leaveList(req.params.listId, String(req.person.id))) {
      return fail(res, 404, 'not_a_member', "you aren't on that list");
    }
    res.json({ ok: true });
  });

  // ---------------- A list's link ----------------

  // The list's name and its owner, for anyone with the link, signed in or
  // not. Signed in, `viewer` says whether it's yours and whether you're
  // on it. Opening it joins nobody.
  router.get('/list-links/:code', handle(async (req, res) => {
    const found = await linkList(req, res);
    if (!found) return;
    const me = req.person ? String(req.person.id) : null;
    const viewer = me ? { isOwner: found.list.ownerId === me, isMember: store.joinedAt(found.list.id, me) != null } : null;
    res.json({ list: { name: found.list.name }, owner: found.owner, viewer });
  }));

  // Joining: you're on the list, and invited (by its owner) to every
  // event it's attached to that isn't over or cancelled. Anyone signed
  // in, quick accounts included. Already on it changes nothing.
  router.post('/list-links/:code/join', auth.requirePerson, handle(async (req, res) => {
    const found = await linkList(req, res);
    if (!found) return;
    const me = String(req.person.id);
    if (found.list.ownerId === me) return fail(res, 409, 'own_list', "that's your own list");
    if (joinLimits.blocked(req, me)) return fail(res, 429, 'rate_limited', "that's a lot of lists for one day -- try again tomorrow");
    joinLimits.hit(req, me);
    const result = store.joinList(found.list.id, me);
    if (result.outcome === 'own_list') return fail(res, 409, 'own_list', "that's your own list");
    if (result.outcome === 'full') return fail(res, 409, 'list_full', `a list can have at most ${MAX_MEMBERS} people`);
    if (result.outcome === 'not_found') return fail(res, 404, 'list_link_not_found', "that list link doesn't work (it may have been reset)");
    // A normal invitation, from the list's owner, for each event.
    result.invitedTo.forEach((eventId) => notify('invited', { to: [me], actorId: result.ownerId, eventId }));
    res.json({
      list: { id: found.list.id, name: found.list.name, owner: found.owner, joinedAt: iso(store.joinedAt(found.list.id, me)) },
      invitedTo: result.invitedTo.length
    });
  }));

  // ---------------- Lists on an event ----------------

  // The event's hosts may attach lists, each only their own (a list
  // invites in its owner's name).
  function hostOnly(req, res) {
    if (isHost(req.role)) return true;
    fail(res, 403, 'hosts_only', 'only a host can put lists on this event');
    return false;
  }

  // Attach one of your lists: everyone on it is invited, by you, with the
  // same rules as any invitation (anyone who opted out of your
  // invitations, the hosts and anyone removed are skipped, without a
  // word), and anyone who joins it later is invited while the event is
  // still to come. Again: anyone not invited yet is. Answers with the
  // event and how many were invited just now.
  router.put('/events/:id/lists/:listId', auth.requirePerson, withEvent, handle(async (req, res) => {
    if (!hostOnly(req, res)) return;
    const refusal = inviteRefusal(req.event);
    if (refusal) return fail(res, refusal[0], refusal[1], refusal[2]);
    const list = ownList(req, res);
    if (!list) return;
    const ids = store.memberIdsOf(list.id);
    const people = await loadPeople(canopy, ids);
    const result = store.attachList(req.event.id, list.id, list.ownerId, ids.filter((id) => people.has(id)));
    if (result.outcome === 'too_many') return fail(res, 409, 'too_many_lists', `an event can have at most ${MAX_LISTS_PER_EVENT} lists`);
    notify('invited', { to: result.invited, actorId: list.ownerId, eventId: req.event.id });
    res.json({ event: await eventView(ctx, req, store.getEvent(req.event.id), { friendsGoing: true }), invitedCount: result.invited.length });
  }));

  // Take a list off: its owner may, and so may the event's creator. Nobody's
  // invitation changes; people who join later just aren't invited to this
  // one. Fine to send twice (for a list of your own).
  router.delete('/events/:id/lists/:listId', auth.requirePerson, withEvent, handle(async (req, res) => {
    if (!hostOnly(req, res)) return;
    const list = LIST_ID_RE.test(req.params.listId) ? store.getList(req.params.listId) : null;
    const mine = !!list && list.ownerId === String(req.person.id);
    const attached = !!list && store.isAttached(req.event.id, list.id);
    if (!list || (!mine && !attached)) return fail(res, 404, 'list_not_found', "you don't have a list with that id");
    if (!mine && req.role !== 'creator') return fail(res, 403, 'not_your_list', 'only its owner or the person who made this event can take that list off');
    store.detachList(req.event.id, list.id);
    res.json({ event: await eventView(ctx, req, store.getEvent(req.event.id), { friendsGoing: true }) });
  }));

  return router;
};
