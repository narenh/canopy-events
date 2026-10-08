// What events knows about people beyond their ids: whether they've been
// seen signed in here with a proven email (the verified_people table),
// and whether they've ever hosted (hosted_people).
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
    get: db.prepare('SELECT 1 FROM verified_people WHERE person_id = ?'),
    hosted: db.prepare('INSERT OR IGNORE INTO hosted_people (person_id, first_at) VALUES (?, ?)'),
    hasHosted: db.prepare('SELECT 1 FROM hosted_people WHERE person_id = ?')
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
    },

    // `personId` hosts something now: they made an event or were made a
    // co-host. Called inside those changes' own transactions.
    noteHosted(personId) {
      q.hosted.run(personId, Date.now());
    },

    // Whether `personId` has ever hosted or co-hosted an event. Once a
    // host, always a host: stepping down, being taken off, or every event
    // being over or cancelled doesn't change it (the apps keep their
    // Hosting tab).
    hasHosted(personId) {
      return !!q.hasHosted.get(personId);
    }
  };
};
