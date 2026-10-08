// What events knows about people beyond their ids: only whether they've
// been seen signed in here with a proven email (the verified_people
// table).
//
// Why it's needed: co-hosts have to be verified (docs/decisions.md), and
// the account service's /api/people, the only way to ask about someone
// else, doesn't say. Their own session does (`emailVerified`), so every
// API request notes it for the person making it. Someone who has never
// used events while verified can't be made a co-host until they have:
// opening any event link signed in is enough.
//
// Most requests change nothing, so what was last written is remembered in
// memory and only a change touches the database.

const MEMO_MAX = 10000;

module.exports = function peopleStore(db) {
  const q = {
    mark: db.prepare(`
      INSERT INTO verified_people (person_id, seen_at) VALUES (?, ?)
      ON CONFLICT (person_id) DO UPDATE SET seen_at = excluded.seen_at`),
    unmark: db.prepare('DELETE FROM verified_people WHERE person_id = ?'),
    get: db.prepare('SELECT 1 FROM verified_people WHERE person_id = ?')
  };
  // person id -> the verified state last written for them.
  const memo = new Map();

  return {
    // From a request's own session: `verified` is req.person.emailVerified.
    noteVerification(personId, verified) {
      if (!personId || memo.get(personId) === verified) return;
      if (verified) q.mark.run(personId, Date.now());
      else q.unmark.run(personId);
      if (memo.size > MEMO_MAX) memo.clear();
      memo.set(personId, verified);
    },

    // Whether `personId` was last seen here with a proven email.
    isKnownVerified(personId) {
      return !!q.get.get(personId);
    }
  };
};
