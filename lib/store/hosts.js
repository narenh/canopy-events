// Co-hosts: the creator adds and removes them (routes/hosts.js says who
// may). Reading who hosts what is in lib/store/events.js (hostRole,
// hostsOf), next to the events themselves.
//
// Hosts don't answer their own events (hosting is being there), so
// becoming a co-host takes the place of any answer or invitation they had:
// their row in rsvps goes, and their plus-ones with it. Stepping down (or
// being taken off) leaves them invited, by whoever made them a co-host, so
// the event stays in their invitations and they can answer like anyone
// else.

// The most co-hosts an event can have, besides its creator.
const MAX_COHOSTS = 10;

module.exports = function hostsStore(db) {
  const q = {
    role: db.prepare('SELECT role, added_by FROM hosts WHERE event_id = ? AND person_id = ?'),
    cohostCount: db.prepare("SELECT COUNT(*) AS n FROM hosts WHERE event_id = ? AND role = 'cohost'"),
    insert: db.prepare("INSERT INTO hosts (event_id, person_id, role, added_by, added_at) VALUES (?, ?, 'cohost', ?, ?)"),
    remove: db.prepare("DELETE FROM hosts WHERE event_id = ? AND person_id = ? AND role = 'cohost'"),
    dropRsvp: db.prepare('DELETE FROM rsvps WHERE event_id = ? AND person_id = ?'),
    creator: db.prepare("SELECT person_id FROM hosts WHERE event_id = ? AND role = 'creator'"),
    invite: db.prepare(`
      INSERT INTO rsvps (event_id, person_id, status, invited_by, invited_at, status_at, created_at)
      VALUES (@eventId, @personId, 'invited', @by, @now, @now, @now)
      ON CONFLICT (event_id, person_id) DO NOTHING`)
  };

  return {
    // Makes `personId` a co-host of `eventId`. 'added', 'already_cohost',
    // 'is_creator' or 'too_many'. `before` is their rsvp row as it was
    // (null if none), for whoever needs to know what they gave up.
    addCohost(eventId, personId, addedBy) {
      return db.transaction(() => {
        const role = q.role.get(eventId, personId);
        if (role) return { outcome: role.role === 'creator' ? 'is_creator' : 'already_cohost' };
        if (q.cohostCount.get(eventId).n >= MAX_COHOSTS) return { outcome: 'too_many' };
        const now = Date.now();
        q.dropRsvp.run(eventId, personId);
        q.insert.run(eventId, personId, addedBy, now);
        return { outcome: 'added' };
      })();
    },

    // Takes `personId` off as a co-host: 'removed' or 'not_cohost'. They're
    // left invited (see the top of this file).
    removeCohost(eventId, personId) {
      return db.transaction(() => {
        const role = q.role.get(eventId, personId);
        if (!role || role.role !== 'cohost') return { outcome: 'not_cohost' };
        q.remove.run(eventId, personId);
        const creator = q.creator.get(eventId);
        q.invite.run({ eventId, personId, by: role.added_by || (creator && creator.person_id), now: Date.now() });
        return { outcome: 'removed' };
      })();
    }
  };
};

module.exports.MAX_COHOSTS = MAX_COHOSTS;
