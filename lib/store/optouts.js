// What a guest has turned off, from the ⋯ menu on an event page
// (lib/db.js, version 14):
//
//   - muting an event (event_mutes): lib/notify.js leaves them out of
//     the chatter about it, and keeps telling them the essentials;
//   - opting out of a host's invitations (invite_optouts): that host's
//     invitations to them are skipped (routes/rsvps.js), saying no more
//     than for someone with no account.
//
// Leaving an event (lib/store/rsvps.js leaveEvent) takes its mute with it.

module.exports = function optoutsStore(db) {
  const q = {
    mute: db.prepare('INSERT INTO event_mutes (event_id, person_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING'),
    unmute: db.prepare('DELETE FROM event_mutes WHERE event_id = ? AND person_id = ?'),
    optOut: db.prepare('INSERT INTO invite_optouts (person_id, host_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING'),
    optIn: db.prepare('DELETE FROM invite_optouts WHERE person_id = ? AND host_id = ?'),
    optouts: db.prepare('SELECT host_id FROM invite_optouts WHERE person_id = ? ORDER BY created_at, host_id'),
    // Hosts don't hear about their own event less for having muted it as
    // a guest before they were made a co-host.
    mutedOnEvent: db.prepare(`
      SELECT m.person_id FROM event_mutes m
      WHERE m.event_id = ? AND NOT EXISTS (SELECT 1 FROM hosts h WHERE h.event_id = m.event_id AND h.person_id = m.person_id)`)
  };

  return {
    muteEvent(eventId, personId) {
      q.mute.run(eventId, personId, Date.now());
    },

    unmuteEvent(eventId, personId) {
      return q.unmute.run(eventId, personId).changes > 0;
    },

    // Which of `eventIds` `personId` has muted: a Set of event ids.
    mutedEvents(eventIds, personId) {
      const out = new Set();
      if (!eventIds.length || !personId) return out;
      db.prepare(`SELECT event_id FROM event_mutes WHERE person_id = ? AND event_id IN (${eventIds.map(() => '?').join(',')})`)
        .all(personId, ...eventIds)
        .forEach((r) => out.add(r.event_id));
      return out;
    },

    // Everyone who has muted the event and isn't hosting it: a Set of
    // person ids.
    mutedOn(eventId) {
      return new Set(q.mutedOnEvent.all(eventId).map((r) => r.person_id));
    },

    optOutOfInvites(personId, hostId) {
      q.optOut.run(personId, hostId, Date.now());
    },

    optInToInvites(personId, hostId) {
      return q.optIn.run(personId, hostId).changes > 0;
    },

    // The hosts `personId` has opted out of, oldest first: [person id].
    inviteOptouts(personId) {
      return q.optouts.all(personId).map((r) => r.host_id);
    },

    // Of `personIds`, the ones who have opted out of `hostId`'s
    // invitations: a Set.
    optedOutOf(hostId, personIds) {
      const out = new Set();
      if (!personIds.length) return out;
      db.prepare(`SELECT person_id FROM invite_optouts WHERE host_id = ? AND person_id IN (${personIds.map(() => '?').join(',')})`)
        .all(hostId, ...personIds)
        .forEach((r) => out.add(r.person_id));
      return out;
    }
  };
};
