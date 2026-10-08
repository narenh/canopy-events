// Each person's inbox (the notifications table) and the phones push goes
// to (devices). Nothing here sends anything or decides who hears about
// what: that's lib/notify.js, the one way in.
//
// Types, and their details:
//
//   invited            a host (actor) invited you
//   event_changed      a host moved it or changed where: { changed:
//                      ['time', 'place'] } (one or both)
//   event_cancelled    a host cancelled it
//   event_uncancelled  ...and it's back on
//   cohost_added       the creator made you a co-host
//   waitlist_promoted  you got a spot from the waitlist (no actor)
//   wall_post          a host posted on the wall: { entryId, text }
//   rsvp               someone answered your event (hosts): { status }
//                      of the latest; folded together while unread
//                      (COLLAPSE), `count` saying how many

const TYPES = ['invited', 'event_changed', 'event_cancelled', 'event_uncancelled', 'cohost_added',
  'waitlist_promoted', 'wall_post', 'rsvp'];
// Types whose repeats, for the same person and event, fold into the one
// unread notification rather than making another (and another push).
const COLLAPSE = ['rsvp'];
// The most phones one person can have registered; the least recently
// registered goes first.
const MAX_DEVICES = 10;

function notificationRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    personId: r.person_id,
    type: r.type,
    eventId: r.event_id,
    actorId: r.actor_id,
    details: r.details ? JSON.parse(r.details) : null,
    count: r.count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    readAt: r.read_at
  };
}

module.exports = function notificationsStore(db) {
  const q = {
    insert: db.prepare(`
      INSERT INTO notifications (person_id, type, event_id, actor_id, details, count, created_at, updated_at)
      VALUES (@personId, @type, @eventId, @actorId, @details, 1, @now, @now)`),
    get: db.prepare('SELECT * FROM notifications WHERE id = ?'),
    unreadSame: db.prepare(`
      SELECT * FROM notifications
      WHERE person_id = @personId AND type = @type AND event_id IS @eventId AND read_at IS NULL
      ORDER BY updated_at DESC LIMIT 1`),
    fold: db.prepare(`
      UPDATE notifications SET actor_id = @actorId, details = @details, count = count + 1, updated_at = @now
      WHERE id = @id`),
    page: db.prepare(`
      SELECT * FROM notifications
      WHERE person_id = @personId
        AND (@afterAt IS NULL OR updated_at < @afterAt OR (updated_at = @afterAt AND id < @afterId))
      ORDER BY updated_at DESC, id DESC LIMIT @limit`),
    unread: db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE person_id = ? AND read_at IS NULL'),
    readAll: db.prepare('UPDATE notifications SET read_at = ? WHERE person_id = ? AND read_at IS NULL'),
    // Who's on an event, for "tell everyone coming": going, maybe or
    // waitlisted, and the hosts.
    audience: db.prepare(`
      SELECT person_id FROM rsvps WHERE event_id = ? AND status IN ('going', 'maybe', 'waitlisted')
      UNION SELECT person_id FROM hosts WHERE event_id = ?`),
    hosts: db.prepare('SELECT person_id FROM hosts WHERE event_id = ?'),
    device: db.prepare(`
      INSERT INTO devices (token, person_id, platform, created_at, updated_at) VALUES (@token, @personId, @platform, @now, @now)
      ON CONFLICT (token) DO UPDATE SET person_id = excluded.person_id, platform = excluded.platform, updated_at = excluded.updated_at`),
    devicesOf: db.prepare('SELECT token, platform FROM devices WHERE person_id = ? ORDER BY updated_at DESC, rowid DESC'),
    trimDevices: db.prepare(`
      DELETE FROM devices WHERE person_id = @personId AND token NOT IN
        (SELECT token FROM devices WHERE person_id = @personId ORDER BY updated_at DESC, rowid DESC LIMIT ${MAX_DEVICES})`),
    removeDevice: db.prepare('DELETE FROM devices WHERE token = ? AND (? IS NULL OR person_id = ?)')
  };

  return {
    // Writes `type` to each of `personIds`' inboxes, in one transaction.
    // Returns [{ notification, isNew }]: isNew is false when it was folded
    // into an unread one of the same kind (no new push for that).
    addNotifications(type, personIds, { eventId = null, actorId = null, details = null }) {
      if (!TYPES.includes(type)) throw new Error(`not a notification type: ${type}`);
      const now = Date.now();
      return db.transaction(() => personIds.map((personId) => {
        if (COLLAPSE.includes(type)) {
          const same = q.unreadSame.get({ personId, type, eventId });
          if (same) {
            q.fold.run({ id: same.id, actorId, details: details ? JSON.stringify(details) : null, now });
            return { notification: notificationRow(q.get.get(same.id)), isNew: false };
          }
        }
        const info = q.insert.run({ personId, type, eventId, actorId, details: details ? JSON.stringify(details) : null, now });
        return { notification: notificationRow(q.get.get(info.lastInsertRowid)), isNew: true };
      }))();
    },

    // A page of `personId`'s inbox, newest first, after `after`
    // ([updatedAt, id]).
    listNotifications(personId, { after = null, limit }) {
      return q.page
        .all({ personId, afterAt: after ? after[0] : null, afterId: after ? after[1] : null, limit })
        .map(notificationRow);
    },

    unreadCount(personId) {
      return q.unread.get(personId).n;
    },

    // Marks `ids` read, if they're `personId`'s. Others are ignored.
    markRead(personId, ids) {
      if (!ids.length) return;
      db.prepare(`UPDATE notifications SET read_at = ? WHERE person_id = ? AND read_at IS NULL
                  AND id IN (${ids.map(() => '?').join(',')})`).run(Date.now(), personId, ...ids);
    },

    markAllRead(personId) {
      q.readAll.run(Date.now(), personId);
    },

    // Everyone coming to `eventId` (going, maybe, waitlisted) and its hosts.
    audienceOf(eventId) {
      return q.audience.all(eventId, eventId).map((r) => r.person_id);
    },

    hostIdsOf(eventId) {
      return q.hosts.all(eventId).map((r) => r.person_id);
    },

    // A phone, for `personId`. The same token registered by someone else
    // moves to them (it's one phone; whoever signed in on it last gets its
    // pushes). Past MAX_DEVICES, the least recently registered goes.
    registerDevice(personId, platform, token) {
      db.transaction(() => {
        q.device.run({ token, personId, platform, now: Date.now() });
        q.trimDevices.run({ personId });
      })();
    },

    // Unregisters `token`: only if it's `personId`'s, or any owner's when
    // personId is null (a push service saying the token is dead).
    removeDevice(token, personId = null) {
      return q.removeDevice.run(token, personId, personId).changes > 0;
    },

    devicesOf(personId) {
      return q.devicesOf.all(personId);
    }
  };
};

module.exports.NOTIFICATION_TYPES = TYPES;
module.exports.MAX_DEVICES = MAX_DEVICES;
