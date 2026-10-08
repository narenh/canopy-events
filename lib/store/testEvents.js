// Test events: past events made up for the account admin, with the account
// service's test people as guests, so the admin has history with them
// (the inviter's Suggested, the Past tab, events in common) without
// waiting months. The Account Manager's "Make past events with me" asks
// for them (routes/internal.js); "Delete all test people" deletes them.
//
// Written straight into the tables, not through the API: the API won't
// make an event in the past, and an event that's over takes no answers.
// So nothing else that making an event or answering does happens here:
// no Updates entries, no notifications or pushes, no friend edges from
// invitations, and nobody is noted as having hosted (hosted_people, which
// is kept for good). Each is marked `is_test` (lib/db.js, version 16),
// which is how they're found to be deleted and how the calendar feed
// leaves them out. They look like what they are: no cover, no color, and
// a description saying they're made up.
//
// What they're like, so Suggested has something to order:
//
//   - spread over the last six months, an evening each, three hours long;
//   - every other one hosted by the admin, the rest by a test person with
//     the admin going (now and then maybe);
//   - the guests drawn with a lean: the test people are shuffled, and the
//     first few are at most events and the rest at fewer and fewer, so
//     everyone's score is different;
//   - about one answer in five is maybe, which doesn't count as being
//     there (lib/store/friends.js).

const crypto = require('crypto');
const { newEventId } = require('../ids');
const { overAtFor } = require('../rules');

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const SPAN_DAYS = 180;
const NEWEST_DAYS = 3;
const LENGTH_MS = 3 * HOUR_MS;
const MAX_GUESTS = 25;
// The most there may be at once, however many times it's asked.
const TEST_EVENTS_MAX = 100;

const TITLES = [
  'Drag Race viewing', 'Taco night', 'Board game night', 'Rooftop drinks', 'Sunday brunch', 'Dumpling party',
  'Karaoke', 'Movie night', 'Picnic in the park', 'Birthday dinner', 'Book club', 'Trivia night',
  'Hot pot', 'Beach bonfire', 'Housewarming', 'Game day', 'Wine and cheese', 'Potluck',
  'Bowling', 'Pho night', 'Hike and lunch', 'Oscars party', 'Ramen run', 'Pancake breakfast',
  'Mahjong night', 'Farmers market and coffee', 'Bake-off', 'Salsa class', 'Sushi night', 'Pizza and a movie'
];

const PLACES = [
  'Dolores Park', 'The rooftop', 'Our place', 'The Mission', 'Ocean Beach', 'Bernal Hill',
  'The back patio', 'Lucky Bowl', 'Sunset Karaoke', 'The community garden', 'Golden Gate Park', 'Upstairs'
];

const DESCRIPTION = 'A made-up event with test people, for trying Canopy Events out (Account Manager, Test people).';

const random = () => crypto.randomInt(0, 1e9) / 1e9;

function shuffled(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

module.exports = function testEventsStore(db) {
  const q = {
    idTaken: db.prepare('SELECT 1 FROM events WHERE id = @id OR public_id = @id'),
    insertEvent: db.prepare(`
      INSERT INTO events (id, title, description, starts_at, ends_at, over_at, time_zone, location_name,
                          theme_grayscale, public_id, is_test, created_at, updated_at)
      VALUES (@id, @title, @description, @startsAt, @endsAt, @overAt, 'America/Los_Angeles', @place,
              1, @id, 1, @createdAt, @createdAt)`),
    insertHost: db.prepare(`
      INSERT INTO hosts (event_id, person_id, role, added_by, added_at) VALUES (?, ?, 'creator', NULL, ?)`),
    insertRsvp: db.prepare(`
      INSERT INTO rsvps (event_id, person_id, status, guests, invited_by, invited_at, responded_at, status_at, created_at)
      VALUES (@eventId, @personId, @status, 0, @hostId, @invitedAt, @answeredAt, @answeredAt, @invitedAt)`),
    count: db.prepare('SELECT COUNT(*) AS n FROM events WHERE is_test = 1'),
    ids: db.prepare('SELECT id FROM events WHERE is_test = 1'),
    remove: db.prepare('DELETE FROM events WHERE id = ? AND is_test = 1')
  };

  function newId() {
    for (;;) {
      const id = newEventId();
      if (!q.idTaken.get({ id })) return id;
    }
  }

  return {
    countTestEvents() {
      return q.count.get().n;
    },

    // `count` past events with `personId` (the admin) and `testPeopleIds`
    // (at least one), as above, in one transaction. Returns their ids,
    // newest first.
    createTestEvents(personId, testPeopleIds, count, now = Date.now()) {
      const people = shuffled(Array.from(new Set(testPeopleIds)).filter((id) => id !== personId));
      if (!people.length) return [];
      const titles = shuffled(TITLES);
      // The chance the k-th test person is at any one event.
      const lean = (k) => Math.max(0.06, 0.85 - 0.07 * k);
      return db.transaction(() => {
        const made = [];
        for (let i = 0; i < count; i++) {
          const daysAgo = NEWEST_DAYS + Math.floor((i + 0.2 + 0.6 * random()) * ((SPAN_DAYS - NEWEST_DAYS) / count));
          const day = new Date(now - daysAgo * DAY_MS);
          // 02:00 UTC: early evening in California.
          const startsAt = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 2);
          const endsAt = startsAt + LENGTH_MS;
          const createdAt = startsAt - (10 + crypto.randomInt(0, 20)) * DAY_MS;
          const adminHosts = i % 2 === 0;
          // A test person host is one of the first few: the people the
          // admin sees most.
          const hostId = adminHosts ? personId : people[crypto.randomInt(0, Math.min(5, people.length))];
          const id = newId();
          q.insertEvent.run({
            id, title: titles[i % titles.length], description: DESCRIPTION, startsAt, endsAt, overAt: overAtFor(startsAt, endsAt),
            place: PLACES[crypto.randomInt(0, PLACES.length)], createdAt
          });
          q.insertHost.run(id, hostId, createdAt);
          const answer = (who, status) => q.insertRsvp.run({
            eventId: id, personId: who, status, hostId, invitedAt: createdAt,
            answeredAt: createdAt + crypto.randomInt(1, 72) * HOUR_MS
          });
          if (!adminHosts) answer(personId, i % 4 === 3 ? 'maybe' : 'going');
          let guests = people.filter((p, k) => p !== hostId && random() < lean(k)).slice(0, MAX_GUESTS);
          // Never a party of one.
          if (guests.length < 2) guests = people.filter((p) => p !== hostId).slice(0, 2);
          guests.forEach((g) => answer(g, random() < 0.2 ? 'maybe' : 'going'));
          made.push(id);
        }
        return made;
      })();
    },

    // Every test event, and everything under it (hosts, answers, any
    // Updates or inbox entries: ON DELETE CASCADE). Returns their ids, for
    // the route to delete any cover someone gave one.
    deleteTestEvents() {
      return db.transaction(() => q.ids.all().map((r) => r.id).filter((id) => q.remove.run(id).changes > 0))();
    }
  };
};

module.exports.TEST_EVENTS_MAX = TEST_EVENTS_MAX;
