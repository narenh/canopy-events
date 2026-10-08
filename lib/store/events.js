// Events and their hosts.
//
// Lists are keyset-paginated: `after` is the last row's sort key from the
// page before (lib/api.js turns it into the opaque `cursor`), and each
// list asks for one more row than it shows so it knows whether there's a
// next page. Keyset rather than OFFSET, so an event made or cancelled
// while someone pages through doesn't shift or repeat rows.

// `id` is the event's own id, which never changes and which every other
// table points at; `publicId` is its link (/e/<publicId>), which a host
// can change (lib/db.js, version 6). Only publicId ever goes out.
function eventRow(e) {
  if (!e) return null;
  return {
    id: e.id,
    publicId: e.public_id,
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
    coverKey: e.cover_key,
    themeHue: e.theme_hue == null ? null : e.theme_hue,
    themeGrayscale: !!e.theme_grayscale,
    // A grey event's accent hue; null is white (and always null when the
    // event isn't grey).
    accentHue: e.accent_hue == null ? null : e.accent_hue,
    coverHue: e.cover_hue == null ? null : e.cover_hue,
    coverGrayscale: !!e.cover_grayscale,
    // [{ width, height }], narrowest first, the last the full-size file;
    // null with no cover, or one from before sizes waiting for its own
    // (lib/db.js, version 9).
    coverSizes: e.cover_key && e.cover_sizes ? sizesFrom(e.cover_sizes) : null,
    // [{ type, label, value }] in the host's order, [] for none
    // (lib/details.js; lib/db.js, version 13).
    details: detailsFrom(e.details),
    createdAt: e.created_at,
    updatedAt: e.updated_at
  };
}

function sizesFrom(json) {
  try {
    const list = JSON.parse(json);
    return Array.isArray(list) && list.length ? list.map(([width, height]) => ({ width, height })) : null;
  } catch (e) {
    return null;
  }
}

function detailsFrom(json) {
  if (!json) return [];
  try {
    const list = JSON.parse(json);
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

const detailsJson = (list) => (list && list.length ? JSON.stringify(list.map((d) => ({ type: d.type, label: d.label, value: d.value }))) : null);

const sizesJson = (sizes) => (sizes && sizes.length ? JSON.stringify(sizes.map((s) => [s.width, s.height])) : null);

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
  cancelledAt: 'cancelled_at',
  guestsAllowed: 'guests_allowed',
  capacity: 'capacity',
  themeHue: 'theme_hue',
  themeGrayscale: 'theme_grayscale',
  accentHue: 'accent_hue',
  details: 'details'
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
  // You said you can't go, not over and not cancelled: the other half of
  // the app's Invites tab, so you can change your mind. Soonest first.
  declined: {
    where: `EXISTS (SELECT 1 FROM rsvps r WHERE r.event_id = e.id AND r.person_id = @me AND r.status = 'not_going')
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
  const wall = require('./wall')(db);
  const waitlist = require('./waitlist')(db);
  const people = require('./people')(db);
  const q = {
    event: db.prepare('SELECT * FROM events WHERE id = ?'),
    byLink: db.prepare('SELECT * FROM events WHERE public_id = ?'),
    idTaken: db.prepare('SELECT 1 FROM events WHERE id = @id OR public_id = @id'),
    setLink: db.prepare('UPDATE events SET public_id = ?, updated_at = ? WHERE id = ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM events'),
    remove: db.prepare('DELETE FROM events WHERE id = ?'),
    insertEvent: db.prepare(`
      INSERT INTO events (id, title, description, starts_at, ends_at, over_at, time_zone, location_name,
                          location_address, guest_list_visibility, guests_allowed, capacity, theme_hue, theme_grayscale, accent_hue, details, public_id, created_at, updated_at)
      VALUES (@id, @title, @description, @startsAt, @endsAt, @overAt, @timeZone, @locationName,
              @locationAddress, @guestListVisibility, @guestsAllowed, @capacity, @themeHue, @themeGrayscale, @accentHue, @details, @id, @now, @now)`),
    insertHost: db.prepare(`
      INSERT INTO hosts (event_id, person_id, role, added_by, added_at) VALUES (?, ?, ?, ?, ?)`),
    hostRole: db.prepare('SELECT role FROM hosts WHERE event_id = ? AND person_id = ?'),
    byCoverKey: db.prepare('SELECT * FROM events WHERE cover_key = ?'),
    setCover: db.prepare(`UPDATE events SET cover_key = @key, cover_image_at = @at, cover_hue = @hue, cover_grayscale = @grey,
                          cover_sizes = @sizes, updated_at = @now WHERE id = @id`),
    // Not an edit: updated_at stays.
    setCoverSizes: db.prepare('UPDATE events SET cover_sizes = @sizes WHERE id = @id AND cover_key = @key AND cover_sizes IS NULL'),
    coversWithoutSizes: db.prepare('SELECT id, cover_key FROM events WHERE cover_key IS NOT NULL AND cover_sizes IS NULL ORDER BY id')
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

  // An edit by a host (`actorId`), with what it means for everyone else,
  // in one transaction: the wall gets an entry for a new time, a new
  // place, a cancellation or taking one back (lib/store/wall.js), and
  // `happened` says which, for notifications: { time, place,
  // cancelled, uncancelled }, each true or false. Only a real change
  // counts: sending the same start time again isn't moving the event.
  // A higher (or no) capacity, or a cancelled event back on, can make
  // room for the waitlist: `promoted` is who got a spot.
  function editEvent(id, changes, actorId) {
    return db.transaction(() => {
      const before = eventRow(q.event.get(id));
      const sets = [];
      const params = { id, now: Date.now() };
      for (const [key, column] of Object.entries(EDITABLE)) {
        if (changes[key] === undefined) continue;
        sets.push(`${column} = @${key}`);
        // SQLite has no booleans (themeGrayscale): 1 and 0. The details
        // are JSON.
        if (key === 'details') params[key] = detailsJson(changes[key]);
        else params[key] = typeof changes[key] === 'boolean' ? (changes[key] ? 1 : 0) : changes[key];
      }
      if (sets.length) db.prepare(`UPDATE events SET ${sets.join(', ')}, updated_at = @now WHERE id = @id`).run(params);
      const event = eventRow(q.event.get(id));
      const differs = (keys) => keys.some((k) => before[k] !== event[k]);
      const happened = {
        time: differs(['startsAt', 'endsAt', 'timeZone']),
        place: differs(['locationName', 'locationAddress']),
        cancelled: before.status === 'active' && event.status === 'cancelled',
        uncancelled: before.status === 'cancelled' && event.status === 'active'
      };
      if (happened.time) {
        wall.addWallEntry(id, 'time_changed', actorId, { startsAt: event.startsAt, endsAt: event.endsAt, timeZone: event.timeZone });
      }
      if (happened.place) {
        wall.addWallEntry(id, 'place_changed', actorId, { locationName: event.locationName, locationAddress: event.locationAddress });
      }
      if (happened.cancelled) wall.addWallEntry(id, 'cancelled', actorId);
      if (happened.uncancelled) wall.addWallEntry(id, 'uncancelled', actorId);
      const promoted = before.capacity !== event.capacity || happened.uncancelled ? waitlist.promote(id) : [];
      return { event, happened, promoted };
    })();
  }

  return {
    countEvents() {
      return q.count.get().n;
    },

    // By the event's own id: for the store and the server, never for an id
    // that came from outside (that's a link: getEventByLink).
    getEvent(id) {
      return eventRow(q.event.get(String(id || '')));
    },

    // By its link, as people and apps have it. An old link (from before
    // "make a new link") finds nothing.
    getEventByLink(publicId) {
      return eventRow(q.byLink.get(String(publicId || '')));
    },

    // Whether an id is in use, as an event's own id or as a link: a new
    // event or link must be neither.
    isEventIdTaken(id) {
      return !!q.idTaken.get({ id });
    },

    // A new link for the event: `publicId` (unused, see isEventIdTaken)
    // replaces the old one, which stops working. Nothing else changes.
    setEventLink(id, publicId) {
      q.setLink.run(publicId, Date.now(), id);
      return eventRow(q.event.get(id));
    },

    // A new event and its creator, together: there's never an event with
    // nobody hosting it.
    createEvent(id, creatorId, fields) {
      const now = Date.now();
      return db.transaction(() => {
        q.insertEvent.run({ themeHue: null, accentHue: null, ...fields, themeGrayscale: fields.themeGrayscale ? 1 : 0, details: detailsJson(fields.details), id, now });
        q.insertHost.run(id, creatorId, 'creator', null, now);
        people.noteHosted(creatorId);
        return eventRow(q.event.get(id));
      })();
    },

    // `changes` uses the record's names (see EDITABLE); anything else is
    // ignored. Returns the event after.
    updateEvent(id, changes) {
      return editEvent(id, changes, null).event;
    },

    editEvent,

    // Deletes the event and everything under it: its hosts, answers,
    // invitations, wall and inbox entries all go with it (every table
    // that points at events does ON DELETE CASCADE). Who has hosted
    // (hosted_people) stays: once a host, always a host. The cover's file
    // is the route's to remove.
    deleteEvent(id) {
      return q.remove.run(id).changes > 0;
    },

    // The event whose cover has this public key, or null.
    getEventByCoverKey(key) {
      return eventRow(q.byCoverKey.get(String(key || '')));
    },

    // A new cover: a new key (so the old URL stops working), its time
    // (the ?v=), the hue that matches it (`hue`, or `grayscale` for a
    // grey photo; neither when unknown), and the sizes it's stored at
    // ([{ width, height }], narrowest first; none: only the full size,
    // as before version 9). setCover(id, null) is no cover.
    setCover(id, key, { hue = null, grayscale = false, sizes = null } = {}) {
      const now = Date.now();
      q.setCover.run({ id, key, at: key ? now : null, hue: key ? hue : null, grey: key && grayscale ? 1 : 0, sizes: key ? sizesJson(sizes) : null, now });
      return eventRow(q.event.get(id));
    },

    // The sizes of a cover from before version 9, once they're on disk.
    // Only while the event still has that cover (`key`) and no sizes yet:
    // false when it was replaced or removed meanwhile.
    setCoverSizes(id, key, sizes) {
      return q.setCoverSizes.run({ id, key, sizes: sizesJson(sizes) }).changes > 0;
    },

    // The covers stored at full size only, waiting for their smaller
    // sizes: [{ id, coverKey }].
    coversWithoutSizes() {
      return q.coversWithoutSizes.all().map((r) => ({ id: r.id, coverKey: r.cover_key }));
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
module.exports.eventRow = eventRow;
