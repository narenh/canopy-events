// Friends. Your friends are the people in your list, and your list is:
//
//   (everyone you've been at an event with)   -- implicit, worked out
//   + (everyone you've added, or who came to you through a link or an
//      invitation)                             -- friend_edges
//   - (everyone you took out)                  -- hidden_friends
//
// **Implicit** (nothing stored): two people are friends once they've both
// been at the same event: a host of it, or an RSVP of "going", on an
// event that has started and wasn't cancelled. It's worked out from hosts
// and rsvps every time, so cancelling an event (or a "going" turning into
// "can't go" before it starts) takes the friendship back with it. "maybe"
// doesn't count: it isn't being there. An event that hasn't started yet
// doesn't count either, or anyone could make themselves your friend by
// saying "going" to your party next month.
//
// **Explicit** (friend_edges): one way, like following. Adding someone
// puts them in your list and needs no OK from them; it doesn't put you in
// theirs, and nothing tells them. The ways in:
//
//   - 'lookup': you added them by id (the friends page finds them by phone
//     or Instagram first). Your list only.
//   - 'link': you opened their friend link and said yes. Both lists:
//     sharing your link is saying yes in advance.
//   - 'invite' / 'invited_by': a host invited someone. The host gets the
//     guest ('invite') and the guest gets the host ('invited_by'), in the
//     invitation's own transaction (lib/store/rsvps.js). Taking the
//     invitation back leaves both.
//   - Test people (the account service's made-up people): the Account
//     Manager's "Make me friends with all test people" makes 'link' edges
//     both ways, exactly what each of them saying yes to your friend link
//     would (routes/internal.js), and takes them away again before the
//     test people are deleted.
//
// **Hidden** (hidden_friends): taking someone out of your list deletes
// your edge to them and hides them, whether or not they're also an
// implicit friend, so they stay out even if you're at another event
// together or they invite you again. Only you adding them again (by id,
// by their link, or inviting them) brings them back. What someone else
// does never un-hides anyone in your list.
//
// Nobody else ever sees your list, and nothing says who added whom.

// Who was at which event, by the rule above, as a CTE other queries can
// put in front of themselves. @now is the time.
const AT_THE_SAME_EVENT = `
  attended AS (
    SELECT h.event_id, h.person_id FROM hosts h
    UNION
    SELECT r.event_id, r.person_id FROM rsvps r WHERE r.status = 'going'
  ),
  together AS (
    SELECT b.person_id AS friend_id, COUNT(*) AS n, MAX(e.starts_at) AS last_at
    FROM attended a
    JOIN attended b ON b.event_id = a.event_id AND b.person_id <> a.person_id
    JOIN events e ON e.id = a.event_id
    WHERE a.person_id = @me AND e.status = 'active' AND e.starts_at <= @now
    GROUP BY b.person_id
  )`;

// Everyone in @me's list (the whole rule), as `mine`: friend_id, n (events
// in common, 0 for someone you only added), last_at (null then) and
// source (null for an implicit friend with no edge).
const MY_FRIENDS = `
  ${AT_THE_SAME_EVENT},
  edges AS (
    SELECT friend_id, source FROM friend_edges WHERE person_id = @me
  ),
  mine AS (
    SELECT f.friend_id, COALESCE(t.n, 0) AS n, t.last_at, e.source
    FROM (SELECT friend_id FROM together UNION SELECT friend_id FROM edges) f
    LEFT JOIN together t ON t.friend_id = f.friend_id
    LEFT JOIN edges e ON e.friend_id = f.friend_id
    WHERE f.friend_id NOT IN (SELECT friend_id FROM hidden_friends WHERE person_id = @me)
  )`;

// Who to suggest first when inviting (GET /api/v1/me/friends/suggested):
// the people you've been with most and most recently, more so the guests
// of events you hosted. Each event you were both at counts
// 2^(-days since it started / 90), twice that for an event you hosted;
// a way in that isn't events together counts a little, fading the same
// way from when it was made (an invitation either way 0.5, a friend link
// or adding by id 0.25). The sum is the score. docs/api.md says the same.
const HALF_LIFE_DAYS = 90;
const HOSTED_WEIGHT = 2;
const EDGE_WEIGHT = { invite: 0.5, invited_by: 0.5, link: 0.25, lookup: 0.25 };
const DAY_MS = 24 * 60 * 60 * 1000;

function fade(ageMs) {
  return Math.pow(2, -Math.max(0, ageMs) / DAY_MS / HALF_LIFE_DAYS);
}

function friendRow(r) {
  return { personId: r.friend_id, eventsInCommon: r.n, lastTogetherAt: r.last_at, edge: r.source || null };
}

module.exports = function friendsStore(db) {
  const { newFriendCode } = require('../ids');
  const q = {
    // Most events in common first, then by id so the order is total and a
    // cursor can pick up exactly where a page ended. People you only added
    // (no events in common) come last.
    friends: db.prepare(`
      WITH ${MY_FRIENDS}
      SELECT friend_id, n, last_at, source FROM mine
      WHERE @afterN IS NULL OR n < @afterN OR (n = @afterN AND friend_id > @afterId)
      ORDER BY n DESC, friend_id
      LIMIT @limit`),
    allFriends: db.prepare(`
      WITH ${MY_FRIENDS}
      SELECT friend_id, n, last_at, source FROM mine`),
    // Every event @me and someone else were both at (the implicit rule's
    // events), with whether @me hosted it.
    together: db.prepare(`
      WITH attended AS (
        SELECT h.event_id, h.person_id FROM hosts h
        UNION
        SELECT r.event_id, r.person_id FROM rsvps r WHERE r.status = 'going'
      )
      SELECT b.person_id AS friend_id, e.starts_at,
             EXISTS (SELECT 1 FROM hosts h WHERE h.event_id = e.id AND h.person_id = @me) AS hosted
      FROM attended a
      JOIN attended b ON b.event_id = a.event_id AND b.person_id <> a.person_id
      JOIN events e ON e.id = a.event_id
      WHERE a.person_id = @me AND e.status = 'active' AND e.starts_at <= @now`),
    edges: db.prepare('SELECT friend_id, source, created_at FROM friend_edges WHERE person_id = ?'),
    friend: db.prepare(`
      WITH ${MY_FRIENDS}
      SELECT friend_id, n, last_at, source FROM mine WHERE friend_id = @other`),
    friendsGoing: db.prepare(`
      WITH ${MY_FRIENDS}
      SELECT r.person_id FROM rsvps r
      WHERE r.event_id = @eventId AND r.status = 'going' AND r.person_id IN (SELECT friend_id FROM mine)
      ORDER BY r.status_at, r.person_id`),
    // The first way in is kept: adding someone again changes nothing.
    addEdge: db.prepare(`
      INSERT INTO friend_edges (person_id, friend_id, source, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (person_id, friend_id) DO NOTHING`),
    deleteEdge: db.prepare('DELETE FROM friend_edges WHERE person_id = ? AND friend_id = ?'),
    hide: db.prepare(`
      INSERT INTO hidden_friends (person_id, friend_id, hidden_at) VALUES (?, ?, ?)
      ON CONFLICT (person_id, friend_id) DO UPDATE SET hidden_at = excluded.hidden_at`),
    unhide: db.prepare('DELETE FROM hidden_friends WHERE person_id = ? AND friend_id = ?'),
    linkOf: db.prepare('SELECT code FROM friend_links WHERE person_id = ?'),
    linkOwner: db.prepare('SELECT person_id FROM friend_links WHERE code = ?'),
    setLink: db.prepare(`
      INSERT INTO friend_links (person_id, code, created_at) VALUES (?, ?, ?)
      ON CONFLICT (person_id) DO UPDATE SET code = excluded.code, created_at = excluded.created_at`),
    // Everything friends-related of a list of people (JSON), either side.
    removeEdgesOf: db.prepare(`
      DELETE FROM friend_edges
      WHERE person_id IN (SELECT value FROM json_each(@ids)) OR friend_id IN (SELECT value FROM json_each(@ids))`),
    removeHiddenOf: db.prepare(`
      DELETE FROM hidden_friends
      WHERE person_id IN (SELECT value FROM json_each(@ids)) OR friend_id IN (SELECT value FROM json_each(@ids))`),
    removeLinksOf: db.prepare('DELETE FROM friend_links WHERE person_id IN (SELECT value FROM json_each(@ids))')
  };

  // `me` puts `other` in their own list, by `source`. `byMe`: it's me
  // doing it, so someone I'd hidden comes back; someone else's doing
  // (they invited me, they opened my link) adds the edge but leaves my
  // hiding them as it was.
  function addEdge(me, other, source, byMe) {
    if (me === other) return;
    q.addEdge.run(me, other, source, Date.now());
    if (byMe) q.unhide.run(me, other);
  }

  return {
    // `personId`'s friends, up to `limit` after `after` ([eventsInCommon,
    // friendId] from the page before): [{ personId, eventsInCommon,
    // lastTogetherAt (null with none), edge (friend_edges' source, or
    // null) }].
    friendsOf(personId, { now = Date.now(), after = null, limit }) {
      return q.friends
        .all({ me: personId, now, afterN: after ? after[0] : null, afterId: after ? after[1] : null, limit })
        .map(friendRow);
    },

    // Up to `limit` of `personId`'s friends to suggest first when
    // inviting, best first, each with its `score` (see HALF_LIFE_DAYS
    // above); only people with a score above 0. Ties go to whoever you
    // were with last, then by id.
    suggestedFriendsOf(personId, { now = Date.now(), limit }) {
      const mine = new Map(q.allFriends.all({ me: personId, now }).map((r) => [r.friend_id, r]));
      const scores = new Map();
      const add = (id, x) => { if (mine.has(id)) scores.set(id, (scores.get(id) || 0) + x); };
      q.together.all({ me: personId, now }).forEach((r) => add(r.friend_id, fade(now - r.starts_at) * (r.hosted ? HOSTED_WEIGHT : 1)));
      q.edges.all(personId).forEach((r) => add(r.friend_id, (EDGE_WEIGHT[r.source] || 0) * fade(now - r.created_at)));
      return Array.from(scores, ([id, score]) => ({ ...friendRow(mine.get(id)), score: Math.round(score * 1000) / 1000 }))
        .filter((f) => f.score > 0)
        .sort((a, b) => b.score - a.score || (b.lastTogetherAt || 0) - (a.lastTogetherAt || 0) || (a.personId < b.personId ? -1 : 1))
        .slice(0, limit);
    },

    // `other` as one of `personId`'s friends (the same shape), or null if
    // they aren't in the list.
    friendOf(personId, other, { now = Date.now() } = {}) {
      const r = q.friend.get({ me: personId, other, now });
      return r ? friendRow(r) : null;
    },

    // The ids of `personId`'s friends who are going to `eventId`, in the
    // order they said so.
    friendsGoingTo(eventId, personId, { now = Date.now() } = {}) {
      return q.friendsGoing.all({ eventId, me: personId, now }).map((r) => r.person_id);
    },

    // `personId` adds `other` to their list ('lookup'), un-hiding them if
    // they'd been taken out.
    addFriend(personId, other) {
      db.transaction(() => addEdge(personId, other, 'lookup', true))();
    },

    // Both ways at once, for a friend link: `opener` (who said yes) adds
    // `owner`, and `owner` gets `opener`. Only the opener's hiding is undone.
    addLinkFriends(opener, owner) {
      db.transaction(() => {
        addEdge(opener, owner, 'link', true);
        addEdge(owner, opener, 'link', false);
      })();
    },

    // A host invited `guestIds`: each way, in the caller's transaction
    // (lib/store/rsvps.js invite). The host's own hiding is undone; the
    // guest's isn't.
    addInviteFriends(hostId, guestIds) {
      guestIds.forEach((guestId) => {
        addEdge(hostId, guestId, 'invite', true);
        addEdge(guestId, hostId, 'invited_by', false);
      });
    },

    // `personId` and each of `friendIds` (test people), friends both ways,
    // as if each had said yes to `personId`'s friend link ('link' edges),
    // and neither side hidden any more: the admin asked for exactly this,
    // and the test people are theirs to drive. In one transaction.
    // { added: how many changed at all, alreadyFriends: the rest }.
    addTestFriends(personId, friendIds) {
      const ids = Array.from(new Set(friendIds)).filter((id) => id !== personId);
      return db.transaction(() => {
        const now = Date.now();
        let added = 0;
        for (const id of ids) {
          const changed = q.addEdge.run(personId, id, 'link', now).changes + q.addEdge.run(id, personId, 'link', now).changes
            + q.unhide.run(personId, id).changes + q.unhide.run(id, personId).changes;
          if (changed) added++;
        }
        return { added, alreadyFriends: ids.length - added };
      })();
    },

    // Every friendship with any of `personIds` (test people about to be
    // deleted), either way: their edges, anyone's hiding of them or
    // theirs of anyone, and their friend links. A deleted person is left
    // out of every list anyway; their edges would only take room in
    // Suggested and on a page. Returns how many edges went.
    removeFriendshipsOf(personIds) {
      const ids = JSON.stringify(Array.from(new Set(personIds)));
      return db.transaction(() => {
        const removed = q.removeEdgesOf.run({ ids }).changes;
        q.removeHiddenOf.run({ ids });
        q.removeLinksOf.run({ ids });
        return removed;
      })();
    },

    // `personId` takes `other` out of their list: their edge goes, and
    // `other` is hidden (an implicit friend can't be deleted, and an
    // explicit one stays out after another event together). False if
    // `other` wasn't in the list.
    removeFriend(personId, other, { now = Date.now() } = {}) {
      return db.transaction(() => {
        if (!q.friend.get({ me: personId, other, now })) return false;
        q.deleteEdge.run(personId, other);
        q.hide.run(personId, other, Date.now());
        return true;
      })();
    },

    // `personId`'s friend link code, made the first time it's asked for.
    friendLinkOf(personId) {
      return db.transaction(() => {
        const row = q.linkOf.get(personId);
        if (row) return row.code;
        const code = newFriendCode();
        q.setLink.run(personId, code, Date.now());
        return code;
      })();
    },

    // A new code for `personId`; the old one finds nobody from now on.
    resetFriendLink(personId) {
      const code = newFriendCode();
      q.setLink.run(personId, code, Date.now());
      return code;
    },

    // Whose link `code` is, or null.
    friendLinkOwner(code) {
      const row = q.linkOwner.get(code);
      return row ? row.person_id : null;
    }
  };
};
