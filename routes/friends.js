// Friends: your list, adding and taking people out, and your friend link.
// Mounted at /api/v1. lib/store/friends.js has the rules: your list is the
// people you've been at events with, plus the people you've added (or who
// came through your link or an invitation), minus the ones you took out.
// One way, like following: adding someone doesn't put you in their list,
// and nothing tells them. Your list is only ever shown to you.
//
// The ways in:
//
//   - your **friend link**, /f/<code> (and its QR code, on the friends
//     page): whoever opens it and says yes gets you, and you get them.
//     Sharing it is saying yes in advance. Quick (unverified) accounts
//     have one and can use other people's.
//   - **adding by id**, after finding someone by phone or Instagram
//     (POST /api/v1/people/lookup): verified people only, the same rule as
//     the lookup, so a throwaway quick account can't be used for it.
//   - **inviting**: a host and the people they invite become friends both
//     ways (routes/rsvps.js, lib/store/rsvps.js).
//
// No notifications: nobody hears that they were added.

const express = require('express');
const { handle, fail, pageParams, paginate } = require('../lib/api');
const { attemptLimiter, guessLimits, clientIp } = require('../lib/limits');
const { PERSON_ID_RE, FRIEND_CODE_RE } = require('../lib/ids');
const { loadPeople, publicPerson } = require('../lib/people');
const { iso } = require('../lib/views');
const { publicBase } = require('../lib/domain');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Adding friends, by id or by accepting a link: each try counts one,
// found or not, so it can't be used to test ids in bulk either. 200 a
// person a day, 500 an address, 5,000 across everyone.
const addLimits = guessLimits({ perWho: [200, DAY], perIp: [500, DAY], overall: [5000, DAY] });
// Friend links that find nobody, per address. The codes can't be guessed
// (71 bits); this keeps anyone from trying for long.
const linkMisses = attemptLimiter(60, HOUR);

// How someone came to be in your list, as the API says it: an edge's way
// in when there is one (the deliberate act), otherwise the events you
// were both at.
const SOURCES = { lookup: 'added', link: 'link', invite: 'invite', invited_by: 'invite' };

function friendView(row, person) {
  return {
    person: publicPerson(person),
    source: row.edge ? SOURCES[row.edge] : 'shared_events',
    eventsInCommon: row.eventsInCommon,
    lastTogetherAt: row.lastTogetherAt == null ? null : iso(row.lastTogetherAt)
  };
}

module.exports = function friendsRoutes(ctx) {
  const { store, auth, canopy } = ctx;
  const router = express.Router();

  function linkView(req, code) {
    return { url: `${publicBase(req)}/f/${code}`, code };
  }

  // `other` as one of the caller's friends, with their name and photo.
  async function oneFriend(req, other) {
    const row = store.friendOf(req.person.id, other);
    const people = await loadPeople(canopy, [other]);
    return row && people.has(other) ? friendView(row, people.get(other)) : null;
  }

  // The friend link at :code: its owner's id, or a 404 sent. Unknown
  // codes count against the address.
  function linkOwner(req, res) {
    const ip = clientIp(req);
    if (linkMisses.blocked(ip)) {
      fail(res, 429, 'rate_limited', "that's a lot of friend links that didn't work -- try again later");
      return null;
    }
    const owner = FRIEND_CODE_RE.test(req.params.code) ? store.friendLinkOwner(req.params.code) : null;
    if (!owner) {
      linkMisses.hit(ip);
      fail(res, 404, 'friend_link_not_found', "that friend link doesn't work (it may have been reset)");
      return null;
    }
    return owner;
  }

  // Your friends, most events in common first, then the people you've
  // only added. Former members are left out: there's nobody to invite.
  router.get('/me/friends', auth.requirePerson, handle(async (req, res) => {
    const page = pageParams(req, res);
    if (!page) return;
    const rows = store.friendsOf(req.person.id, { after: page.after, limit: page.limit + 1 });
    const { items, nextCursor } = paginate(rows, page.limit, (r) => [r.eventsInCommon, r.personId]);
    const people = await loadPeople(canopy, items.map((r) => r.personId));
    const friends = items.filter((r) => people.has(r.personId)).map((r) => friendView(r, people.get(r.personId)));
    res.json({ friends, nextCursor });
  }));

  // Add someone by id: { personId }. One way. Adding someone already in
  // your list changes nothing; adding someone you took out brings them
  // back.
  router.post('/me/friends', auth.requireVerified, handle(async (req, res) => {
    const personId = (req.body || {}).personId;
    if (typeof personId !== 'string' || !PERSON_ID_RE.test(personId)) return fail(res, 400, 'bad_person_id', "that isn't a person id");
    if (personId === String(req.person.id)) return fail(res, 409, 'is_you', "you can't add yourself");
    if (addLimits.blocked(req, req.person.id)) return fail(res, 429, 'rate_limited', "that's a lot of friends for one day -- try again tomorrow");
    addLimits.hit(req, req.person.id);
    const people = await loadPeople(canopy, [personId]);
    if (!people.has(personId)) return fail(res, 404, 'person_not_found', "there's no Canopy account with that id");
    store.addFriend(req.person.id, personId);
    res.json({ friend: await oneFriend(req, personId) });
  }));

  // Take someone out of your list. Someone you added goes; someone you
  // were at events with is hidden, and stays out until you add them again.
  // They aren't told.
  router.delete('/me/friends/:personId', auth.requirePerson, (req, res) => {
    if (!PERSON_ID_RE.test(req.params.personId)) return fail(res, 400, 'bad_person_id', "that isn't a person id");
    if (!store.removeFriend(req.person.id, req.params.personId)) return fail(res, 404, 'not_a_friend', "they aren't in your friends");
    res.json({ ok: true });
  });

  // Your friend link: { url, code }, made the first time it's asked for.
  // `url` is what to share, and what the QR code says.
  router.get('/me/friend-link', auth.requirePerson, (req, res) => {
    res.json(linkView(req, store.friendLinkOf(req.person.id)));
  });

  // A new friend link; the old one stops working. Friends made with it
  // stay friends.
  router.post('/me/friend-link/reset', auth.requirePerson, (req, res) => {
    res.json(linkView(req, store.resetFriendLink(req.person.id)));
  });

  // Whose friend link this is: their name and photo, nothing else, for
  // anyone with it, signed in or not (the page shows who they'd be adding).
  // Signed in, `viewer` says whether it's your own and whether they're
  // already in your list. Opening it adds nobody.
  router.get('/friend-links/:code', handle(async (req, res) => {
    const owner = linkOwner(req, res);
    if (!owner) return;
    const people = await loadPeople(canopy, [owner]);
    if (!people.has(owner)) return fail(res, 404, 'friend_link_not_found', "that friend link doesn't work (it may have been reset)");
    const viewer = req.person
      ? { isYou: String(req.person.id) === owner, isFriend: String(req.person.id) !== owner && !!store.friendOf(req.person.id, owner) }
      : null;
    res.json({ person: publicPerson(people.get(owner)), viewer });
  }));

  // Saying yes to a friend link: you get its owner, and its owner gets
  // you. Your own link is a 409.
  router.post('/friend-links/:code/accept', auth.requirePerson, handle(async (req, res) => {
    const owner = linkOwner(req, res);
    if (!owner) return;
    if (owner === String(req.person.id)) return fail(res, 409, 'own_link', "that's your own friend link");
    if (addLimits.blocked(req, req.person.id)) return fail(res, 429, 'rate_limited', "that's a lot of friends for one day -- try again tomorrow");
    addLimits.hit(req, req.person.id);
    const people = await loadPeople(canopy, [owner]);
    if (!people.has(owner)) return fail(res, 404, 'friend_link_not_found', "that friend link doesn't work (it may have been reset)");
    store.addLinkFriends(String(req.person.id), owner);
    res.json({ friend: await oneFriend(req, owner) });
  }));

  return router;
};
