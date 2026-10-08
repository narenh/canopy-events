// Events and their hosts.
//
// Lists are keyset-paginated: `after` is the last row's sort key from the
// page before (lib/api.js turns it into the opaque `cursor`), and each
// list asks for one more row than it shows so it knows whether there's a
// next page. Keyset rather than OFFSET, so an event made or cancelled
// while someone pages through doesn't shift or repeat rows.

function eventRow(e) {
  if (!e) return null;
  return {
    id: e.id,
    title: e.title,
    description: e.description,
    startsAt: e.starts_at,
    endsAt: e.ends_at,
    overAt: e.over_at,
    timeZone: e.time_zone,
    locationName: e.location_name,
    locationAddress: e.location_address,
    guestListVisibility: e.guest_list_visibility,
    status: e.status,
    cancelledAt: e.cancelled_at,
    guestsAllowed: e.guests_allowed,
    capacity: e.capacity,
    coverImageAt: e.cover_image_at,
    createdAt: e.created_at,
    updatedAt: e.updated_at
  };
}

// The columns an edit may touch, by their record names.
const EDITABLE = {
  title: 'title',
  description: 'description',
  startsAt: 'starts_at',
  endsAt: 'ends_at',
  overAt: 'over_at',
  timeZone: 'time_zone',
  locationName: 'location_name',
  locationAddress: 'location_address',
  guestListVisibility: 'guest_list_visibility',
  status: 'status',
  cancelledAt: 'cancelled_at'
};

// What counts as "your events" in each list, as SQL. @me is the person,
// @now the time.
const RSVP_ATTENDING = "('going', 'maybe', 'waitlisted')";
const LISTS = {
  // Events you host that aren't over, cancelled ones included (so the host
  // still finds them), soonest first.
  hosting: {
    where: 'EXISTS (SELECT 1 FROM hosts h WHERE h.event_id = e.id AND h.person_id = @me) AND e.over_at > @now',
    order: 'asc'
  },
  // Not over, and you said going or maybe. Cancelled ones stay, so you
  // see that they were.
  upcoming: {
    where: `EXISTS (SELECT 1 FROM rsvps r WHERE r.event_id = e.id AND r.person_id = @me AND r.status IN ${RSVP_ATTENDING})
            AND e.over_at > @now`,
    order: 'asc'
  },
  // Invited, no answer yet, not over and not cancelled.
  invitations: {
    where: `EXISTS (SELECT 1 FROM rsvps r WHERE r.event_id = e.id AND r.person_id = @me AND r.status = 'invited')
            AND e.over_at > @now AND e.status = 'active'`,
    order: 'asc'
  },
  // Over, and you hosted it or said going or maybe. Most recent first.
  past: {
    where: `(EXISTS (SELECT 1 FROM hosts h WHERE h.event_id = e.id AND h.person_id = @me)
             OR EXISTS (SELECT 1 FROM rsvps r WHERE r.event_id = e.id AND r.person_id = @me AND r.status IN ('going', 'maybe')))
            AND e.over_at <= @now`,
    order: 'desc'
  }
};

module.exports = function eventsStore(db) {
  const q = {
    event: db.prepare('SELECT * FROM events WHERE id = ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM events'),
    insertEvent: db.prepare(`
      INSERT INTO events (id, title, description, starts_at, ends_at, over_at, time_zone, location_name,
                          location_address, guest_list_visibility, created_at, updated_at)
      VALUES (@id, @title, @description, @startsAt, @endsAt, @overAt, @timeZone, @locationName,
              @locationAddress, @guestListVisibility, @now, @now)`),
    insertHost: db.prepare(`
      INSERT INTO hosts (event_id, person_id, role, added_by, added_at) VALUES (?, ?, ?, ?, ?)`),
    hostRole: db.prepare('SELECT role FROM hosts WHERE event_id = ? AND person_id = ?')
  };

  const lists = {};
  for (const [name, { where, order }] of Object.entries(LISTS)) {
    const cmp = order === 'asc' ? '>' : '<';
    lists[name] = db.prepare(`
      SELECT e.* FROM events e
      WHERE ${where}
        AND (@afterStart IS NULL OR e.starts_at ${cmp} @afterStart OR (e.starts_at = @afterStart AND e.id ${cmp} @afterId))
      ORDER BY e.starts_at ${order}, e.id ${order}
      LIMIT @limit`);
  }

  return {
    countEvents() {
      return q.count.get().n;
    },

    getEvent(id) {
      return eventRow(q.event.get(String(id || '')));
    },

    // A new event and its creator, together: there's never an event with
    // nobody hosting it.
    createEvent(id, creatorId, fields) {
      const now = Date.now();
      return db.transaction(() => {
        q.insertEvent.run({ id, ...fields, now });
        q.insertHost.run(id, creatorId, 'creator', null, now);
        return eventRow(q.event.get(id));
      })();
    },

    // `changes` uses the record's names (see EDITABLE); anything else is
    // ignored. Returns the event after.
    updateEvent(id, changes) {
      const sets = [];
      const params = { id, now: Date.now() };
      for (const [key, column] of Object.entries(EDITABLE)) {
        if (changes[key] === undefined) continue;
        sets.push(`${column} = @${key}`);
        params[key] = changes[key];
      }
      if (sets.length) db.prepare(`UPDATE events SET ${sets.join(', ')}, updated_at = @now WHERE id = @id`).run(params);
      return eventRow(q.event.get(id));
    },

    // 'creator', 'cohost', or null for someone who doesn't host it.
    hostRole(eventId, personId) {
      const row = personId ? q.hostRole.get(eventId, personId) : null;
      return row ? row.role : null;
    },

    // Every host of each of `eventIds`, creator first: Map of event id ->
    // [{ personId, role, addedAt }].
    hostsOf(eventIds) {
      const out = new Map(eventIds.map((id) => [id, []]));
      if (!eventIds.length) return out;
      const rows = db
        .prepare(`SELECT * FROM hosts WHERE event_id IN (${eventIds.map(() => '?').join(',')})
                  ORDER BY role = 'creator' DESC, added_at, person_id`)
        .all(...eventIds);
      rows.forEach((h) => out.get(h.event_id).push({ personId: h.person_id, role: h.role, addedAt: h.added_at }));
      return out;
    },

    // One of the lists in LISTS for `personId`: up to `limit` events after
    // `after` ([startsAt, id] from the page before, or null).
    listMyEvents(name, personId, { now = Date.now(), after = null, limit }) {
      return lists[name]
        .all({ me: personId, now, afterStart: after ? after[0] : null, afterId: after ? after[1] : null, limit })
        .map(eventRow);
    }
  };
};

module.exports.MY_EVENT_LISTS = Object.keys(LISTS);
