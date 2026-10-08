// Friends are implicit. Two people are friends once they've both been at
// the same event: a host of it, or an RSVP of "going", on an event that
// has started and wasn't cancelled. There are no friend requests and
// nothing is stored: it's worked out from hosts and rsvps every time, so
// cancelling an event (or a "going" turning into "can't go" before it
// starts) takes the friendship back with it.
//
// "maybe" doesn't count: it isn't being there. An event that hasn't
// started yet doesn't count either, or anyone could make themselves your
// friend by saying "going" to your party next month.

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

module.exports = function friendsStore(db) {
  const q = {
    // Most events in common first, then by id so the order is total and a
    // cursor can pick up exactly where a page ended.
    friends: db.prepare(`
      WITH ${AT_THE_SAME_EVENT}
      SELECT friend_id, n, last_at FROM together
      WHERE @afterN IS NULL OR n < @afterN OR (n = @afterN AND friend_id > @afterId)
      ORDER BY n DESC, friend_id
      LIMIT @limit`),
    friendsGoing: db.prepare(`
      WITH ${AT_THE_SAME_EVENT}
      SELECT r.person_id FROM rsvps r
      WHERE r.event_id = @eventId AND r.status = 'going' AND r.person_id IN (SELECT friend_id FROM together)
      ORDER BY r.status_at, r.person_id`)
  };

  return {
    // `personId`'s friends, up to `limit` after `after` ([eventsInCommon,
    // friendId] from the page before): [{ personId, eventsInCommon,
    // lastTogetherAt }].
    friendsOf(personId, { now = Date.now(), after = null, limit }) {
      return q.friends
        .all({ me: personId, now, afterN: after ? after[0] : null, afterId: after ? after[1] : null, limit })
        .map((r) => ({ personId: r.friend_id, eventsInCommon: r.n, lastTogetherAt: r.last_at }));
    },

    // The ids of `personId`'s friends who are going to `eventId`, in the
    // order they said so.
    friendsGoingTo(eventId, personId, { now = Date.now() } = {}) {
      return q.friendsGoing.all({ eventId, me: personId, now }).map((r) => r.person_id);
    }
  };
};
