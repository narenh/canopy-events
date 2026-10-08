// Capacity and the waitlist. An event's `capacity` is the most people
// going, plus-ones included; null is no limit.
//
//   - Saying "going" when you and your plus-ones don't fit makes you
//     `waitlisted` instead (lib/store/rsvps.js). Someone already going who
//     asks for more plus-ones than there's room for is refused and keeps
//     their spot: asking for one more shouldn't lose you the one you had.
//   - Whenever a spot might have freed up (an answer taken back, going
//     changed to maybe or can't go, fewer plus-ones, a higher or removed
//     capacity, a guest removed or made a co-host, a cancelled event back
//     on), promote() hands it on: the earliest waitlisted answer that fits
//     with its plus-ones becomes going, then the next, until none fits.
//     Earliest is by when they were waitlisted (status_at). A big party
//     that doesn't fit is passed over for a smaller one behind it that
//     does, and stays first in line for the next spot.
//   - Lowering the capacity under how many are going bumps nobody. It only
//     means new answers wait.
//
// Every caller runs this inside its own transaction, so the change and
// the promotions it causes (and their wall entries) land together or not
// at all. better-sqlite3 is synchronous and this is one process, so
// nothing else runs between the check and the write.

const { isOver } = require('../rules');

module.exports = function waitlist(db) {
  const wall = require('./wall')(db);
  const q = {
    event: db.prepare('SELECT capacity, status, over_at FROM events WHERE id = ?'),
    taken: db.prepare(`SELECT COALESCE(SUM(1 + guests), 0) AS n FROM rsvps
                       WHERE event_id = ? AND status = 'going' AND person_id <> ?`),
    nextThatFits: db.prepare(`
      SELECT person_id FROM rsvps
      WHERE event_id = @eventId AND status = 'waitlisted' AND (@free IS NULL OR 1 + guests <= @free)
      ORDER BY status_at, person_id LIMIT 1`),
    promote: db.prepare(`UPDATE rsvps SET status = 'going', status_at = ? WHERE event_id = ? AND person_id = ?`)
  };

  // Spots taken by everyone going except `exceptId`.
  function takenBy(eventId, exceptId = '') {
    return q.taken.get(eventId, exceptId).n;
  }

  // Whether `personId` with `guests` plus-ones fits in `eventId` as it is
  // (their own current spot, if any, counted as free).
  function fits(eventId, personId, guests) {
    const e = q.event.get(eventId);
    if (!e || e.capacity == null) return true;
    return takenBy(eventId, personId) + 1 + guests <= e.capacity;
  }

  // Fills free spots from the waitlist; the ids promoted, in order. Not on
  // a cancelled event or one that's over: nobody's getting in to those.
  function promote(eventId) {
    const e = q.event.get(eventId);
    if (!e || e.status !== 'active' || isOver({ overAt: e.over_at })) return [];
    const promoted = [];
    for (;;) {
      const free = e.capacity == null ? null : e.capacity - takenBy(eventId);
      if (free !== null && free < 1) break;
      const next = q.nextThatFits.get({ eventId, free });
      if (!next) break;
      q.promote.run(Date.now(), eventId, next.person_id);
      wall.wallGoing(eventId, next.person_id, 'off_waitlist');
      promoted.push(next.person_id);
    }
    return promoted;
  }

  return { fits, promote, takenBy };
};
