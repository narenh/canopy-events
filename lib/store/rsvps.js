// Answers and invitations: one row per person per event (the rsvps
// table). How the statuses move is in lib/rules.js and docs/api.md; this
// file only stores them.

function rsvpRow(r) {
  if (!r) return null;
  return {
    eventId: r.event_id,
    personId: r.person_id,
    status: r.status,
    guests: r.guests,
    invitedBy: r.invited_by,
    invitedAt: r.invited_at,
    respondedAt: r.responded_at,
    statusAt: r.status_at,
    createdAt: r.created_at
  };
}

// People with each status, and for the answers that bring anyone, their
// plus-ones (`guests`) and people plus plus-ones (`total`). Not going and
// invited bring nobody.
function zeroCounts() {
  return {
    going: 0, maybe: 0, notGoing: 0, invited: 0, waitlisted: 0,
    guests: { going: 0, maybe: 0, waitlisted: 0 },
    total: { going: 0, maybe: 0, waitlisted: 0 }
  };
}
const COUNT_KEY = { going: 'going', maybe: 'maybe', not_going: 'notGoing', invited: 'invited', waitlisted: 'waitlisted' };
const BRINGS_GUESTS = ['going', 'maybe', 'waitlisted'];

function placeholders(list) {
  return list.map(() => '?').join(',');
}

module.exports = function rsvpsStore(db) {
  const wall = require('./wall')(db);
  const waitlist = require('./waitlist')(db);
  const q = {
    rsvp: db.prepare('SELECT * FROM rsvps WHERE event_id = ? AND person_id = ?'),
    // An answer, made or changed. status_at only moves when the status
    // does, so changing how many guests you bring doesn't lose your place.
    answer: db.prepare(`
      INSERT INTO rsvps (event_id, person_id, status, guests, responded_at, status_at, created_at)
      VALUES (@eventId, @personId, @status, @guests, @now, @now, @now)
      ON CONFLICT (event_id, person_id) DO UPDATE SET
        status = excluded.status,
        guests = excluded.guests,
        responded_at = excluded.responded_at,
        status_at = CASE WHEN rsvps.status = excluded.status THEN rsvps.status_at ELSE excluded.status_at END`),
    backToInvited: db.prepare(`
      UPDATE rsvps SET status = 'invited', guests = 0, responded_at = NULL, status_at = ?
      WHERE event_id = ? AND person_id = ?`),
    remove: db.prepare('DELETE FROM rsvps WHERE event_id = ? AND person_id = ?'),
    invite: db.prepare(`
      INSERT INTO rsvps (event_id, person_id, status, invited_by, invited_at, status_at, created_at)
      VALUES (@eventId, @personId, 'invited', @by, @now, @now, @now)
      ON CONFLICT (event_id, person_id) DO NOTHING`),
    // Someone who answered before they were invited is invited as well, so
    // taking their answer back leaves them invited rather than gone.
    markInvited: db.prepare(`
      UPDATE rsvps SET invited_by = @by, invited_at = @now
      WHERE event_id = @eventId AND person_id = @personId AND invited_by IS NULL`),
    isHost: db.prepare('SELECT 1 FROM hosts WHERE event_id = ? AND person_id = ?')
  };

  return {
    getRsvp(eventId, personId) {
      return rsvpRow(q.rsvp.get(eventId, personId));
    },

    // `personId`'s row on each of `eventIds`: Map of event id -> rsvp.
    rsvpsFor(eventIds, personId) {
      const out = new Map();
      if (!eventIds.length || !personId) return out;
      db.prepare(`SELECT * FROM rsvps WHERE person_id = ? AND event_id IN (${placeholders(eventIds)})`)
        .all(personId, ...eventIds)
        .forEach((r) => out.set(r.event_id, rsvpRow(r)));
      return out;
    },

    // going / maybe / not_going, with `guests` plus-ones, in one
    // transaction with everything it sets off (lib/store/waitlist.js):
    //
    //   - a "going" that doesn't fit the capacity is saved as waitlisted
    //     (outcome 'waitlisted');
    //   - someone already going who asks for more plus-ones than there's
    //     room for changes nothing (outcome 'no_room');
    //   - a spot it frees goes to the waitlist (`promoted`: who got one);
    //   - saying you're going puts "<you> is going" on the wall, and
    //     stopping takes it off (lib/store/wall.js).
    //
    // Returns { outcome: 'saved' | 'waitlisted' | 'no_room', rsvp,
    // before, promoted }; `before` is the row as it was.
    setAnswer(eventId, personId, status, guests = 0) {
      return db.transaction(() => {
        const before = rsvpRow(q.rsvp.get(eventId, personId));
        let saved = status;
        if (status === 'going' && !waitlist.fits(eventId, personId, guests)) {
          if (before && before.status === 'going') return { outcome: 'no_room', rsvp: before, before, promoted: [] };
          saved = 'waitlisted';
        }
        q.answer.run({ eventId, personId, status: saved, guests, now: Date.now() });
        const wasGoing = !!before && before.status === 'going';
        if (saved === 'going' && !wasGoing) wall.wallGoing(eventId, personId);
        if (saved !== 'going' && wasGoing) wall.wallNotGoing(eventId, personId);
        const promoted = waitlist.promote(eventId);
        return { outcome: saved === status ? 'saved' : 'waitlisted', rsvp: rsvpRow(q.rsvp.get(eventId, personId)), before, promoted };
      })();
    },

    // Takes an answer back. Someone who was invited is left invited (with
    // no answer); anyone else is off the list. A spot it frees goes to the
    // waitlist. Returns { rsvp (the row after, or null), promoted }.
    withdrawAnswer(eventId, personId) {
      return db.transaction(() => {
        const row = q.rsvp.get(eventId, personId);
        if (!row) return { rsvp: null, promoted: [] };
        wall.wallNotGoing(eventId, personId);
        if (row.invited_by) {
          if (row.status !== 'invited') q.backToInvited.run(Date.now(), eventId, personId);
        } else {
          q.remove.run(eventId, personId);
        }
        const promoted = waitlist.promote(eventId);
        return { rsvp: rsvpRow(q.rsvp.get(eventId, personId)), promoted };
      })();
    },

    // Fills any free spots from the waitlist (after a change to the event
    // itself, say): the ids promoted.
    promoteWaitlist(eventId) {
      return db.transaction(() => waitlist.promote(eventId))();
    },

    // Invites each of `personIds` (already checked to be real people).
    // Returns [{ personId, outcome }], outcome 'invited', 'already_on_list'
    // (invited before, or already answered) or 'is_host'.
    invite(eventId, personIds, invitedBy) {
      const now = Date.now();
      return db.transaction(() =>
        personIds.map((personId) => {
          if (q.isHost.get(eventId, personId)) return { personId, outcome: 'is_host' };
          const made = q.invite.run({ eventId, personId, by: invitedBy, now }).changes > 0;
          if (!made) q.markInvited.run({ eventId, personId, by: invitedBy, now });
          return { personId, outcome: made ? 'invited' : 'already_on_list' };
        })
      )();
    },

    // Takes back an invitation nobody has answered yet. 'ok',
    // 'not_invited', or 'already_responded' (an answer stays: it's theirs).
    uninvite(eventId, personId) {
      return db.transaction(() => {
        const row = q.rsvp.get(eventId, personId);
        if (!row || !row.invited_by) return 'not_invited';
        if (row.status !== 'invited') return 'already_responded';
        q.remove.run(eventId, personId);
        return 'ok';
      })();
    },

    // How many of each status, for each of `eventIds`: Map of event id ->
    // { going, maybe, notGoing, invited, waitlisted, guests, total } (see
    // zeroCounts).
    countsFor(eventIds) {
      const out = new Map(eventIds.map((id) => [id, zeroCounts()]));
      if (!eventIds.length) return out;
      db.prepare(`SELECT event_id, status, COUNT(*) AS n, SUM(guests) AS g FROM rsvps
                  WHERE event_id IN (${placeholders(eventIds)}) GROUP BY event_id, status`)
        .all(...eventIds)
        .forEach((r) => {
          if (!COUNT_KEY[r.status]) return;
          const c = out.get(r.event_id);
          c[COUNT_KEY[r.status]] = r.n;
          if (BRINGS_GUESTS.includes(r.status)) {
            c.guests[r.status] = r.g;
            c.total[r.status] = r.n + r.g;
          }
        });
      return out;
    },

    // The guest list: rows with one of `statuses`, in the order they got
    // that status, up to `limit` after `after` ([statusAt, personId]).
    listGuests(eventId, statuses, { after = null, limit }) {
      return db
        .prepare(`SELECT * FROM rsvps
                  WHERE event_id = ? AND status IN (${placeholders(statuses)})
                    AND (? IS NULL OR status_at > ? OR (status_at = ? AND person_id > ?))
                  ORDER BY status_at, person_id LIMIT ?`)
        .all(eventId, ...statuses, after ? after[0] : null, after ? after[0] : null, after ? after[0] : null, after ? after[1] : null, limit)
        .map(rsvpRow);
    }
  };
};
