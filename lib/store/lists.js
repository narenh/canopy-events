// Lists: one person's own list of people, who joined it themselves by its
// link or QR code (/l/<code>), for inviting them all at once. The owner's
// idea: "I host Drag Race every week, and new people don't get invited to
// the next one." So a host makes a "Drag Race" list, shows its QR code at
// the door, attaches it to each week's event, and everyone who joined is
// invited, including anyone who joins after the event was made.
//
// The rules (routes/lists.js says who may call what):
//
//   - A list is **private**. Only its owner sees who's on it. A member
//     sees the list's name, its owner and that they're on it: never the
//     other members, nor how many there are.
//   - The owner is never on their own list (joining it is refused).
//   - **Joining makes no friends by itself**: the owner and a member are
//     friends once the owner invites them (the invitation does that, as
//     every invitation does, lib/store/rsvps.js).
//   - **Attaching a list to an event** invites everyone on it, by the
//     owner, under the same rules as any invitation: anyone who opted out
//     of the owner's invitations is skipped without a word, and so are the
//     event's hosts and anyone a host removed.
//   - **The owner can add people** too (addMembers): the same people they
//     could invite, and the same as those people joining (invited to
//     what's still to come, in the same transaction).
//   - **Joining later** invites the new member to every event the list is
//     attached to that isn't over or cancelled, in the joining's own
//     transaction.
//   - An attached list belongs to its owner's hosting: a co-host's lists
//     come off the event when they stop hosting it (lib/store/hosts.js).
//     The queries here check that the owner still hosts the event anyway.

const { newListId, newListCode } = require('../ids');

// The most lists one person can have, people on one list, and lists on
// one event. Generous for a weekly party; a ceiling for a script.
const MAX_LISTS = 50;
const MAX_MEMBERS = 1000;
const MAX_LISTS_PER_EVENT = 10;

function listRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    ownerId: r.owner_id,
    name: r.name,
    code: r.code,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    memberCount: r.member_count == null ? null : r.member_count
  };
}

module.exports = function listsStore(db) {
  const rsvps = require('./rsvps')(db);
  const optouts = require('./optouts')(db);
  const COUNT = '(SELECT COUNT(*) FROM list_members m WHERE m.list_id = l.id) AS member_count';
  // An attached list whose owner still hosts the event.
  const ACTIVE = 'EXISTS (SELECT 1 FROM hosts h WHERE h.event_id = el.event_id AND h.person_id = l.owner_id)';
  const q = {
    list: db.prepare(`SELECT l.*, ${COUNT} FROM lists l WHERE l.id = ?`),
    byCode: db.prepare(`SELECT l.*, ${COUNT} FROM lists l WHERE l.code = ?`),
    owned: db.prepare(`SELECT l.*, ${COUNT} FROM lists l WHERE l.owner_id = ? ORDER BY l.created_at, l.id`),
    ownedCount: db.prepare('SELECT COUNT(*) AS n FROM lists WHERE owner_id = ?'),
    insert: db.prepare('INSERT INTO lists (id, owner_id, name, code, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'),
    idTaken: db.prepare('SELECT 1 FROM lists WHERE id = @x OR code = @x'),
    rename: db.prepare('UPDATE lists SET name = ?, updated_at = ? WHERE id = ?'),
    setCode: db.prepare('UPDATE lists SET code = ?, updated_at = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM lists WHERE id = ?'),
    member: db.prepare('SELECT joined_at FROM list_members WHERE list_id = ? AND person_id = ?'),
    memberCount: db.prepare('SELECT COUNT(*) AS n FROM list_members WHERE list_id = ?'),
    addMember: db.prepare('INSERT INTO list_members (list_id, person_id, joined_at, added_by) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING'),
    removeMember: db.prepare('DELETE FROM list_members WHERE list_id = ? AND person_id = ?'),
    memberIds: db.prepare('SELECT person_id FROM list_members WHERE list_id = ? ORDER BY joined_at, person_id'),
    // Newest first: the owner wants to see who just joined.
    members: db.prepare(`
      SELECT person_id, joined_at, added_by FROM list_members
      WHERE list_id = @listId
        AND (@afterAt IS NULL OR joined_at < @afterAt OR (joined_at = @afterAt AND person_id > @afterId))
      ORDER BY joined_at DESC, person_id
      LIMIT @limit`),
    memberships: db.prepare(`
      SELECT l.id, l.name, l.owner_id, m.joined_at FROM list_members m JOIN lists l ON l.id = m.list_id
      WHERE m.person_id = ? ORDER BY m.joined_at DESC, l.id`),
    attached: db.prepare('SELECT 1 FROM event_lists WHERE event_id = ? AND list_id = ?'),
    attachedCount: db.prepare('SELECT COUNT(*) AS n FROM event_lists WHERE event_id = ?'),
    attach: db.prepare('INSERT INTO event_lists (event_id, list_id, attached_by, attached_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING'),
    detach: db.prepare('DELETE FROM event_lists WHERE event_id = ? AND list_id = ?'),
    detachOwnedBy: db.prepare('DELETE FROM event_lists WHERE event_id = ? AND list_id IN (SELECT id FROM lists WHERE owner_id = ?)'),
    onEvent: db.prepare(`
      SELECT l.*, ${COUNT}, el.attached_at, el.attached_by FROM event_lists el JOIN lists l ON l.id = el.list_id
      WHERE el.event_id = ? AND ${ACTIVE}
      ORDER BY el.attached_at, l.id`),
    // The events a new member is invited to: attached, not cancelled, not
    // over, and still hosted by the list's owner.
    toInvite: db.prepare(`
      SELECT el.event_id FROM event_lists el JOIN lists l ON l.id = el.list_id JOIN events e ON e.id = el.event_id
      WHERE el.list_id = @listId AND e.status = 'active' AND e.over_at > @now AND ${ACTIVE}
      ORDER BY e.starts_at, e.id`)
  };

  function freshId() {
    let id = newListId();
    while (q.idTaken.get({ x: id })) id = newListId();
    return id;
  }
  function freshCode() {
    let code = newListCode();
    while (q.idTaken.get({ x: code })) code = newListCode();
    return code;
  }

  return {
    // A new list for `ownerId`, or null when they have MAX_LISTS already.
    createList(ownerId, name) {
      return db.transaction(() => {
        if (q.ownedCount.get(ownerId).n >= MAX_LISTS) return null;
        const id = freshId();
        const now = Date.now();
        q.insert.run(id, ownerId, name, freshCode(), now, now);
        return listRow(q.list.get(id));
      })();
    },

    // One list by its id, or by its join code (with memberCount), or null.
    getList(id) {
      return listRow(q.list.get(id));
    },
    listByCode(code) {
      return listRow(q.byCode.get(code));
    },

    // `ownerId`'s lists, oldest first.
    listsOf(ownerId) {
      return q.owned.all(ownerId).map(listRow);
    },

    renameList(id, name) {
      q.rename.run(name, Date.now(), id);
      return listRow(q.list.get(id));
    },

    // A new join code: the old link and QR code find nothing from now on.
    // Its members stay.
    resetListCode(id) {
      return db.transaction(() => {
        q.setCode.run(freshCode(), Date.now(), id);
        return listRow(q.list.get(id));
      })();
    },

    // The list, its members and its place on events go. Invitations it
    // made stay: they're the events' now.
    deleteList(id) {
      q.remove.run(id);
    },

    // A page of members, newest first: [{ personId, joinedAt }], after
    // `after` ([joinedAt, personId]).
    membersOf(listId, { after = null, limit }) {
      return q.members
        .all({ listId, afterAt: after ? after[0] : null, afterId: after ? after[1] : null, limit })
        .map((r) => ({ personId: r.person_id, joinedAt: r.joined_at, addedBy: r.added_by }));
    },

    // Every member's id, in the order they joined.
    memberIdsOf(listId) {
      return q.memberIds.all(listId).map((r) => r.person_id);
    },

    // When `personId` joined `listId`, or null if they aren't on it.
    joinedAt(listId, personId) {
      const r = q.member.get(listId, personId);
      return r ? r.joined_at : null;
    },

    // Which of `listIds` `personId` is on: a Set.
    memberOfLists(listIds, personId) {
      const out = new Set();
      if (!listIds.length || !personId) return out;
      db.prepare(`SELECT list_id FROM list_members WHERE person_id = ? AND list_id IN (${listIds.map(() => '?').join(',')})`)
        .all(personId, ...listIds)
        .forEach((r) => out.add(r.list_id));
      return out;
    },

    // The owner takes someone off. Invitations they had stay. False if
    // they weren't on it.
    removeMember(listId, personId) {
      return q.removeMember.run(listId, personId).changes > 0;
    },

    // The lists `personId` is on, newest first: [{ id, name, ownerId,
    // joinedAt }]. Nothing about who else is.
    membershipsOf(personId) {
      return q.memberships.all(personId).map((r) => ({ id: r.id, name: r.name, ownerId: r.owner_id, joinedAt: r.joined_at }));
    },

    // A member leaves. False if they weren't on it.
    leaveList(listId, personId) {
      return q.removeMember.run(listId, personId).changes > 0;
    },

    // `personId` joins `listId`, and in the same transaction is invited by
    // the list's owner to every attached event that isn't over or
    // cancelled (unless they opted out of the owner's invitations: then
    // they join, and nothing else happens, without a word). Returns
    // { outcome: 'joined' | 'already' | 'own_list' | 'full' | 'not_found',
    // ownerId, invitedTo: [event id] }.
    joinList(listId, personId, { now = Date.now() } = {}) {
      return db.transaction(() => {
        const list = q.list.get(listId);
        if (!list) return { outcome: 'not_found', invitedTo: [] };
        const base = { ownerId: list.owner_id, invitedTo: [] };
        if (list.owner_id === personId) return { ...base, outcome: 'own_list' };
        if (q.member.get(listId, personId)) return { ...base, outcome: 'already' };
        if (q.memberCount.get(listId).n >= MAX_MEMBERS) return { ...base, outcome: 'full' };
        q.addMember.run(listId, personId, now, null);
        const invitedTo = [];
        if (!optouts.optedOutOf(list.owner_id, [personId]).has(personId)) {
          q.toInvite.all({ listId, now }).forEach(({ event_id: eventId }) => {
            const [r] = rsvps.invite(eventId, [personId], list.owner_id);
            if (r.outcome === 'invited') invitedTo.push(eventId);
          });
        }
        return { ...base, outcome: 'joined', invitedTo };
      })();
    },

    // The owner puts people on their own list (`personIds`: ones the
    // caller has checked may be: real accounts, not the owner, not opted
    // out of the owner's invitations). The same as each of them joining,
    // in one transaction: on it, and invited by the owner to every
    // attached event that isn't over or cancelled (hosts and removed
    // guests skipped by rsvps.invite). All or nothing: if they wouldn't
    // all fit under MAX_MEMBERS, nobody is added. Returns { outcome:
    // 'added' | 'full', added: [person id], already: [person id],
    // invited: [{ eventId, personIds }] (who was newly invited to what,
    // for the notifications) }.
    addMembers(listId, ownerId, personIds, { now = Date.now() } = {}) {
      return db.transaction(() => {
        const ids = Array.from(new Set(personIds)).filter((id) => id !== ownerId);
        const already = ids.filter((id) => q.member.get(listId, id));
        const fresh = ids.filter((id) => !already.includes(id));
        if (fresh.length && q.memberCount.get(listId).n + fresh.length > MAX_MEMBERS) return { outcome: 'full', added: [], already: [], invited: [] };
        fresh.forEach((id) => q.addMember.run(listId, id, now, ownerId));
        const invited = [];
        if (fresh.length) {
          q.toInvite.all({ listId, now }).forEach(({ event_id: eventId }) => {
            const newly = rsvps.invite(eventId, fresh, ownerId).filter((r) => r.outcome === 'invited').map((r) => r.personId);
            if (newly.length) invited.push({ eventId, personIds: newly });
          });
        }
        return { outcome: 'added', added: fresh, already, invited };
      })();
    },

    // A host attaches their own list to an event, and everyone on it
    // (`personIds`: its members the caller has checked still have
    // accounts) is invited by the list's owner. Opt-outs are skipped
    // here; hosts and removed guests by rsvps.invite. Attaching again
    // invites anyone not invited yet. Returns { outcome: 'attached' |
    // 'already' | 'too_many', invited: [person id] }.
    attachList(eventId, listId, ownerId, personIds) {
      return db.transaction(() => {
        const already = !!q.attached.get(eventId, listId);
        if (!already) {
          if (q.attachedCount.get(eventId).n >= MAX_LISTS_PER_EVENT) return { outcome: 'too_many', invited: [] };
          q.attach.run(eventId, listId, ownerId, Date.now());
        }
        const out = optouts.optedOutOf(ownerId, personIds);
        const ids = personIds.filter((id) => !out.has(id) && id !== ownerId);
        const results = ids.length ? rsvps.invite(eventId, ids, ownerId) : [];
        return { outcome: already ? 'already' : 'attached', invited: results.filter((r) => r.outcome === 'invited').map((r) => r.personId) };
      })();
    },

    // Takes a list off an event. Nobody's invitation changes. False if it
    // wasn't on it.
    detachList(eventId, listId) {
      return q.detach.run(eventId, listId).changes > 0;
    },

    // Whether `listId` is on `eventId` (owner still hosting or not).
    isAttached(eventId, listId) {
      return !!q.attached.get(eventId, listId);
    },

    // The lists on an event whose owners still host it, in the order they
    // were attached: list rows plus attachedAt and attachedBy.
    listsOnEvent(eventId) {
      return q.onEvent.all(eventId).map((r) => ({ ...listRow(r), attachedAt: r.attached_at, attachedBy: r.attached_by }));
    },

    // When someone stops hosting an event, their lists come off it
    // (lib/store/hosts.js, in its transaction).
    detachListsOf(eventId, ownerId) {
      q.detachOwnedBy.run(eventId, ownerId);
    }
  };
};

module.exports.MAX_LISTS = MAX_LISTS;
module.exports.MAX_MEMBERS = MAX_MEMBERS;
module.exports.MAX_LISTS_PER_EVENT = MAX_LISTS_PER_EVENT;
