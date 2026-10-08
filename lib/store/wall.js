// The activity wall: what people post on an event, and the entries the
// server writes itself when something happens. Who may read, post and
// delete is in lib/rules.js and routes/wall.js; this file only stores.
//
// The server's entries are typed, never sentences: the apps and the pages
// say "Ana is going" in their own words (and languages). The types:
//
//   post           someone's post: person_id wrote body
//   going          person_id said they're going
//   off_waitlist   person_id got a spot from the waitlist (so is going)
//   time_changed   a host (person_id) moved it: details { startsAt,
//                  endsAt, timeZone }, the new ones
//   place_changed  a host (person_id) changed where: details
//                  { locationName, locationAddress }, the new ones
//   cancelled      a host (person_id) cancelled it
//   uncancelled    ...and took that back
//   cohost_added   person_id was made a co-host
//
// "Going" entries are kept true: a person has at most one (going or
// off_waitlist), and it goes when they stop going, so the wall never says
// someone's coming who isn't.

const TYPES = ['post', 'going', 'off_waitlist', 'time_changed', 'place_changed', 'cancelled', 'uncancelled', 'cohost_added'];
const GOING_TYPES = "('going', 'off_waitlist')";

function wallRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    eventId: r.event_id,
    type: r.type,
    personId: r.person_id,
    body: r.body,
    details: r.details ? JSON.parse(r.details) : null,
    createdAt: r.created_at
  };
}

module.exports = function wallStore(db) {
  const q = {
    insert: db.prepare(`
      INSERT INTO wall (event_id, type, person_id, body, details, created_at)
      VALUES (@eventId, @type, @personId, @body, @details, @now)`),
    get: db.prepare('SELECT * FROM wall WHERE id = ? AND event_id = ?'),
    remove: db.prepare('DELETE FROM wall WHERE id = ? AND event_id = ?'),
    dropGoing: db.prepare(`DELETE FROM wall WHERE event_id = ? AND person_id = ? AND type IN ${GOING_TYPES}`),
    // Newest first; ties (the same millisecond) by id, newest first too.
    page: db.prepare(`
      SELECT w.* FROM wall w
      WHERE w.event_id = @eventId
        AND (@afterAt IS NULL OR w.created_at < @afterAt OR (w.created_at = @afterAt AND w.id < @afterId))
      ORDER BY w.created_at DESC, w.id DESC
      LIMIT @limit`)
  };

  function add(eventId, type, personId, { body = null, details = null } = {}) {
    const info = q.insert.run({ eventId, type, personId, body, details: details ? JSON.stringify(details) : null, now: Date.now() });
    return wallRow(q.get.get(info.lastInsertRowid, eventId));
  }

  return {
    // Someone's post.
    addPost(eventId, personId, body) {
      return add(eventId, 'post', personId, { body });
    },

    // One of the server's own entries.
    addWallEntry(eventId, type, personId, details) {
      if (!TYPES.includes(type) || type === 'post') throw new Error(`not a wall entry type: ${type}`);
      return add(eventId, type, personId, { details });
    },

    // `personId` is going now ('going', or 'off_waitlist' for a spot from
    // the waitlist): their one going entry, made fresh.
    wallGoing(eventId, personId, type = 'going') {
      q.dropGoing.run(eventId, personId);
      return add(eventId, type, personId);
    },

    // `personId` isn't going any more: their going entry goes.
    wallNotGoing(eventId, personId) {
      q.dropGoing.run(eventId, personId);
    },

    getWallEntry(eventId, id) {
      return wallRow(q.get.get(id, eventId));
    },

    deleteWallEntry(eventId, id) {
      return q.remove.run(id, eventId).changes > 0;
    },

    // A page of the wall, newest first: up to `limit` after `after`
    // ([createdAt, id] from the page before).
    listWall(eventId, { after = null, limit }) {
      return q.page
        .all({ eventId, afterAt: after ? after[0] : null, afterId: after ? after[1] : null, limit })
        .map(wallRow);
    }
  };
};

module.exports.WALL_TYPES = TYPES;
