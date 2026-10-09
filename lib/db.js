// SQLite persistence for Canopy events: the events, who hosts each one,
// and everyone's answer (or invitation) to it.
//
// One file, DATA_DIR/events.db, on the service's own volume. better-sqlite3
// is synchronous and this is one process, so a transaction is the whole
// locking story.
//
// People live in the account service. Nothing here is a name, an email or
// a photo: only person ids, the same as tickets. A person deleted there
// keeps their rows here, and shows as a former member.
//
// Times are milliseconds since 1970, UTC. Each event also keeps its IANA
// time zone, so a page can show "8pm" the way the host meant it.
//
// This file is the schema, opening the file, and the daily snapshots. The
// queries live in lib/store/, one file per subject, and init() hands back
// all of them as one store. A new subject (the activity wall, say) is a
// new file there plus its tables here.
//
// A NULL column means "no value".

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'events.db');

// The schema's version, kept in SQLite's user_version. Version 1 is what
// ships first, and Coolify deploys main as soon as it changes, so from the
// first merge on a database at version 1 exists somewhere and version 1
// is never edited again. A change to the schema is three edits here:
//
//   1. createSchema gets the new shape (what a brand-new file is made with);
//   2. UPGRADES gets a step from the old version to the new one, doing
//      exactly that change to an existing file (ALTER TABLE ... ADD COLUMN,
//      CREATE TABLE, CREATE INDEX...);
//   3. SCHEMA_VERSION goes up by one.
//
// From version 2 on, the change itself is one function (VERSION_2...),
// which createSchema runs after version 1's tables and UPGRADES runs as the
// step, so the new-file shape and the upgraded shape are the same code.
// Once deployed, a version's function is as frozen as version 1.
//
// test/db.test.js checks that a file made at version 1 and brought up by
// the steps ends up with the same tables and columns as a new one.
const SCHEMA_VERSION = 18;

function createSchema(db) {
  db.exec(`
    -- An event. The id is the link (/e/<id>): 12 random base62
    -- characters, about 71 bits, so it can't be guessed or listed.
    CREATE TABLE IF NOT EXISTS events (
      id                    TEXT PRIMARY KEY,
      title                 TEXT NOT NULL,
      description           TEXT,
      starts_at             INTEGER NOT NULL,
      ends_at               INTEGER,
      -- When the event counts as over: ends_at, or for an event with no
      -- end time, a while after it starts (lib/rules.js). Kept as a column
      -- so "upcoming" and "past" are one indexed comparison.
      over_at               INTEGER NOT NULL,
      -- IANA, e.g. America/Los_Angeles.
      time_zone             TEXT NOT NULL,
      location_name         TEXT,
      location_address      TEXT,
      -- 'everyone': anyone with the link sees the guest list's names.
      -- 'responded': you see them once you've answered; counts before.
      guest_list_visibility TEXT NOT NULL DEFAULT 'everyone'
                            CHECK (guest_list_visibility IN ('everyone', 'responded')),
      status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
      cancelled_at          INTEGER,
      -- Plus-ones: how many guests each RSVP may bring. 0 until the host
      -- says otherwise (v1 scope item 2).
      guests_allowed        INTEGER NOT NULL DEFAULT 0 CHECK (guests_allowed >= 0),
      -- The most people going, guests included. NULL is no limit; past it,
      -- "going" becomes "waitlisted" (v1 scope item 4).
      capacity              INTEGER CHECK (capacity IS NULL OR capacity > 0),
      -- When the cover image was last uploaded: the ?v= on its URL. NULL is
      -- none (v1 scope item 4).
      cover_image_at        INTEGER,
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_over ON events(over_at);

    -- Who hosts an event. The creator, always exactly one, plus any
    -- co-hosts the creator adds (v1 scope item 2). Hosts can edit the event
    -- and always see the whole guest list.
    CREATE TABLE IF NOT EXISTS hosts (
      event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      person_id  TEXT NOT NULL,
      role       TEXT NOT NULL CHECK (role IN ('creator', 'cohost')),
      added_by   TEXT,
      added_at   INTEGER NOT NULL,
      PRIMARY KEY (event_id, person_id)
    );
    CREATE INDEX IF NOT EXISTS hosts_person ON hosts(person_id);
    CREATE UNIQUE INDEX IF NOT EXISTS hosts_one_creator ON hosts(event_id) WHERE role = 'creator';

    -- Everyone else on an event: invited and not answered yet, or their
    -- answer. One row per person per event.
    CREATE TABLE IF NOT EXISTS rsvps (
      event_id     TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      person_id    TEXT NOT NULL,
      -- 'waitlisted' is a "going" past the event's capacity (v1 scope
      -- item 4); nothing sets it yet.
      status       TEXT NOT NULL CHECK (status IN ('invited', 'going', 'maybe', 'not_going', 'waitlisted')),
      -- Plus-ones this answer brings along (v1 scope item 2).
      guests       INTEGER NOT NULL DEFAULT 0 CHECK (guests >= 0),
      -- Set when a host invited them. An invitation outlives the answer:
      -- taking an answer back leaves them invited again.
      invited_by   TEXT,
      invited_at   INTEGER,
      -- When they last answered; NULL while only invited.
      responded_at INTEGER,
      -- When status last changed: the guest list's order, and first come,
      -- first served for the waitlist.
      status_at    INTEGER NOT NULL,
      created_at   INTEGER NOT NULL,
      PRIMARY KEY (event_id, person_id)
    );
    CREATE INDEX IF NOT EXISTS rsvps_person ON rsvps(person_id, status);
    CREATE INDEX IF NOT EXISTS rsvps_event ON rsvps(event_id, status, status_at);
  `);
  VERSION_2(db);
  VERSION_3(db);
  VERSION_4(db);
  VERSION_5(db);
  VERSION_6(db);
  VERSION_7(db);
  VERSION_8(db);
  VERSION_9(db);
  VERSION_10(db);
  VERSION_11(db);
  VERSION_12(db);
  VERSION_13(db);
  VERSION_14(db);
  VERSION_15(db);
  VERSION_16(db);
  VERSION_17(db);
  VERSION_18(db);
}

// ---------------- What each version added ----------------
//
// Each is used twice: by createSchema (a new file gets everything) and by
// the upgrade step that brings an older file to that version. Written once,
// so the two can't drift apart.

// Version 2 (co-hosts): who events has seen signed in with a proven
// email. The account service's /api/people doesn't say who's verified,
// and only verified people may co-host, so events remembers it from their
// own sessions (lib/store/people.js). A row is "last seen verified"; an
// account seen unverified again (an admin changed its email) loses it.
function VERSION_2(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS verified_people (
      person_id  TEXT PRIMARY KEY,
      seen_at    INTEGER NOT NULL
    );
  `);
}

// Each step brings an existing database from the version it's keyed by
// to the next. Version 1 is frozen (test/fixtures/schema-v1.sql).
//
// A step is keyed by the version it starts from:
//
//   // 1 -> 2: events get a cover image's alt text.
//   1(db) {
//     db.exec('ALTER TABLE events ADD COLUMN cover_alt TEXT');
//   },
// Version 3 (the activity wall): posts, and the entries the server writes
// itself ("Ana is going", "the time changed"). Those are typed, with
// structured details, never English: the apps and pages say them in their
// own words (lib/store/wall.js has the types). AUTOINCREMENT so a deleted
// entry's id is never handed to a new one: an app deleting a post it saw
// a while ago can't take someone else's with it.
function VERSION_3(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wall (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      type        TEXT NOT NULL,
      -- A post's author; for the server's entries, who it's about.
      person_id   TEXT,
      -- A post's text. NULL for the server's entries.
      body        TEXT,
      -- The server's entries' structured fields, as JSON.
      details     TEXT,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS wall_event ON wall(event_id, created_at, id);
    CREATE INDEX IF NOT EXISTS wall_person ON wall(event_id, person_id, type);
  `);
}

// Version 4 (cover images): the random key in a cover's public URL
// (/covers/<key>.jpg). Covers are public, for link previews, so the URL
// mustn't be the event's id: that's its link, and anyone who copied an
// image's address would have it. A new upload gets a new key, so the old
// image's URL stops working too. NULL is no cover.
function VERSION_4(db) {
  db.exec(`
    ALTER TABLE events ADD COLUMN cover_key TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS events_cover_key ON events(cover_key);
  `);
}

// Version 5 (notifications): each person's inbox, and the phones to push
// to. A notification is typed with structured details, never a sentence
// (the apps word it). `count` is how many repeats were folded into it
// ("Ana and 3 others answered"), and `updated_at` is when the latest
// happened, which is the inbox's order. A device is an APNs or FCM token;
// a token is one phone, so it belongs to whoever registered it last.
function VERSION_5(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id   TEXT NOT NULL,
      type        TEXT NOT NULL,
      event_id    TEXT REFERENCES events(id) ON DELETE CASCADE,
      -- Who did it; NULL when nobody did (a spot opening up).
      actor_id    TEXT,
      details     TEXT,
      count       INTEGER NOT NULL DEFAULT 1,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      read_at     INTEGER
    );
    CREATE INDEX IF NOT EXISTS notifications_inbox ON notifications(person_id, updated_at, id);
    CREATE INDEX IF NOT EXISTS notifications_unread ON notifications(person_id, read_at);

    CREATE TABLE IF NOT EXISTS devices (
      token       TEXT PRIMARY KEY,
      person_id   TEXT NOT NULL,
      platform    TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS devices_person ON devices(person_id, updated_at);
  `);
}

// Version 6 (host moderation):
//
//   - `removed`, a status a host gives someone: off the guest list, and
//     no answering again. SQLite can't change a CHECK constraint in place,
//     so rsvps is rebuilt with the new list (the usual way: a new table,
//     every row copied, the old one dropped, the new one renamed, its
//     indexes made again). Nothing refers to rsvps, so nothing else moves.
//   - `public_id`, the event's link. An event's `id` stays what it was
//     made with, for good: every other table (hosts, rsvps, wall,
//     notifications) and the cover's file point at it. The link is
//     `public_id`, the same at first; "make a new link" changes only that,
//     so the old link stops working and everything else stays put. Every
//     lookup by link goes by public_id (store.getEventByLink), never id.
function VERSION_6(db) {
  db.exec(`
    CREATE TABLE rsvps_v6 (
      event_id     TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      person_id    TEXT NOT NULL,
      -- 'removed': a host took them off. They can't answer again, and
      -- nobody else sees them; a host can undo it.
      status       TEXT NOT NULL CHECK (status IN ('invited', 'going', 'maybe', 'not_going', 'waitlisted', 'removed')),
      guests       INTEGER NOT NULL DEFAULT 0 CHECK (guests >= 0),
      invited_by   TEXT,
      invited_at   INTEGER,
      responded_at INTEGER,
      status_at    INTEGER NOT NULL,
      created_at   INTEGER NOT NULL,
      PRIMARY KEY (event_id, person_id)
    );
    INSERT INTO rsvps_v6 (event_id, person_id, status, guests, invited_by, invited_at, responded_at, status_at, created_at)
      SELECT event_id, person_id, status, guests, invited_by, invited_at, responded_at, status_at, created_at FROM rsvps;
    DROP TABLE rsvps;
    ALTER TABLE rsvps_v6 RENAME TO rsvps;
    CREATE INDEX rsvps_person ON rsvps(person_id, status);
    CREATE INDEX rsvps_event ON rsvps(event_id, status, status_at);

    ALTER TABLE events ADD COLUMN public_id TEXT;
    UPDATE events SET public_id = id;
    CREATE UNIQUE INDEX events_public_id ON events(public_id);
  `);
}

// Version 7, two things:
//
// The event's colour, `theme_hue`: the page's mesh rotated to this hue
// in degrees (0-359, OKLCH; public/ui.js and docs/api.md say how). NULL
// is Canopy's own green.
//
// And who has ever hosted, for /api/v1/me's `hasHosted` (the
// apps' Hosting tab). Once a host, always a host: someone who made an
// event, or was made a co-host, stays in here even after stepping down
// or being taken off. Rows are only ever added (lib/store/people.js
// noteHosted). An existing file fills it from everyone hosting now, and
// from the wall's "made a co-host" entries, which remember co-hosts who
// have since stepped down (unless a host deleted the entry), each with
// when they first hosted.
function VERSION_7(db) {
  db.exec(`
    ALTER TABLE events ADD COLUMN theme_hue INTEGER CHECK (theme_hue IS NULL OR (theme_hue >= 0 AND theme_hue <= 359));

    CREATE TABLE IF NOT EXISTS hosted_people (
      person_id  TEXT PRIMARY KEY,
      first_at   INTEGER NOT NULL
    );
    INSERT INTO hosted_people (person_id, first_at)
      SELECT person_id, MIN(at) FROM (
        SELECT person_id, added_at AS at FROM hosts
        UNION ALL
        SELECT person_id, created_at AS at FROM wall WHERE type = 'cohost_added' AND person_id IS NOT NULL
      ) GROUP BY person_id;
  `);
}

// Version 8, the colour of a photo and colour-free pages:
//
//   - `theme_grayscale`: the host chose no colour at all. 1 means the page
//     is neutral grey (theme_hue is then ignored); 0, as every event so
//     far, means theme_hue (or Canopy green) as before.
//   - `cover_hue`: the hue that matches the cover, worked out when it's
//     uploaded (public/ui.js hueFromPixels), and `cover_grayscale`: the
//     cover is essentially grey. Both cleared with the cover. Covers
//     uploaded before this version have neither (NULL and 0): unknown,
//     until they're uploaded again.
function VERSION_8(db) {
  db.exec(`
    ALTER TABLE events ADD COLUMN theme_grayscale INTEGER NOT NULL DEFAULT 0 CHECK (theme_grayscale IN (0, 1));
    ALTER TABLE events ADD COLUMN cover_hue INTEGER CHECK (cover_hue IS NULL OR (cover_hue >= 0 AND cover_hue <= 359));
    ALTER TABLE events ADD COLUMN cover_grayscale INTEGER NOT NULL DEFAULT 0 CHECK (cover_grayscale IN (0, 1));
  `);
}

// Version 9, a cover's sizes: `cover_sizes`, the widths it's stored at
// (lib/coverImage.js), as JSON: [[width, height], ...], narrowest first,
// the last being the full-size file (coverImageUrl). NULL with a cover is
// one uploaded before this version, stored at full size only: the server
// makes its smaller sizes in the background after it starts
// (lib/coverBackfill.js) and sets this when they're on disk. Cleared with
// the cover.
function VERSION_9(db) {
  db.exec('ALTER TABLE events ADD COLUMN cover_sizes TEXT');
}

// Version 10, explicit friends (lib/store/friends.js says how they combine
// with the implicit ones):
//
//   - `friend_edges`: person_id has friend_id in their list. One way, like
//     following: the other person's list isn't touched. `source` is how
//     it was made: 'link' (opening someone's friend link, or someone
//     opening yours), 'lookup' (added by id, after finding them by phone
//     or Instagram), 'invite' (you invited them) or 'invited_by' (they
//     invited you). The first way wins; adding again changes nothing.
//   - `hidden_friends`: people person_id took out of their list, implicit
//     or not. Hidden beats everything else, until person_id adds them
//     again themselves.
//   - `friend_links`: each person's friend link, /f/<code>. Random and
//     unguessable like an event's link, kept as it is (not hashed): it
//     only lets someone add themselves, and it's shown again every time
//     the friends page opens. A reset replaces the row, so the old code
//     finds nothing.
function VERSION_10(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS friend_edges (
      person_id   TEXT NOT NULL,
      friend_id   TEXT NOT NULL,
      source      TEXT NOT NULL CHECK (source IN ('link', 'lookup', 'invite', 'invited_by')),
      created_at  INTEGER NOT NULL,
      PRIMARY KEY (person_id, friend_id),
      CHECK (person_id <> friend_id)
    );

    CREATE TABLE IF NOT EXISTS hidden_friends (
      person_id   TEXT NOT NULL,
      friend_id   TEXT NOT NULL,
      hidden_at   INTEGER NOT NULL,
      PRIMARY KEY (person_id, friend_id)
    );

    CREATE TABLE IF NOT EXISTS friend_links (
      person_id   TEXT PRIMARY KEY,
      code        TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS friend_links_code ON friend_links(code);
  `);
}

// Version 11, each person's settings: `person_settings`, one row per
// person who has changed one, so no row means every default. Today one:
// `calendar_invites`, whether events they're invited to and haven't
// answered go in their Canopy calendar (routes/calendar.js). On by
// default, for everyone already here too (they have no row).
function VERSION_11(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS person_settings (
      person_id         TEXT PRIMARY KEY,
      calendar_invites  INTEGER NOT NULL DEFAULT 1 CHECK (calendar_invites IN (0, 1)),
      updated_at        INTEGER NOT NULL
    );
  `);
}

// Version 12, a grey event's accent: `accent_hue`, the hue of the buttons,
// the "how soon" pill, the photo ring and links on a page with no colour
// (theme_grayscale 1), 0-359; NULL is white. Only a grey event may have
// one (the CHECK), and leaving grey clears it (lib/eventInput.js). Every
// grey event from before is white now, not grey (public/ui.js themeStyle).
function VERSION_12(db) {
  db.exec(`
    ALTER TABLE events ADD COLUMN accent_hue INTEGER
      CHECK (accent_hue IS NULL OR (accent_hue >= 0 AND accent_hue <= 359 AND theme_grayscale = 1));
  `);
}

// Version 13, an event's details (lib/details.js): the extra fields under
// the description (a link, the dress code, parking...), as one JSON list
// of { type, label, value }, in the host's order. NULL is none. A column
// rather than a table: the list is small (10 at most), always read with
// its event and only ever replaced whole, and nothing looks across events
// by it. Every event from before has none.
function VERSION_13(db) {
  db.exec(`
    ALTER TABLE events ADD COLUMN details TEXT CHECK (details IS NULL OR json_valid(details));
  `);
}

// Version 14, the guest menu on an event page (lib/store/optouts.js):
//
//   - `event_mutes`: person_id muted event_id. Their inbox (and pushes)
//     skip the chatter about it (wall posts, answers, co-hosts) and keep
//     the essentials (lib/notify.js). Goes with the event, and when they
//     leave it.
//   - `invite_optouts`: person_id won't be invited by host_id. That host's
//     invitations to them are skipped, without saying why
//     (routes/rsvps.js). One way, like friends; nothing to cascade.
function VERSION_14(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_mutes (
      event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      person_id   TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      PRIMARY KEY (event_id, person_id)
    );

    CREATE TABLE IF NOT EXISTS invite_optouts (
      person_id   TEXT NOT NULL,
      host_id     TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      PRIMARY KEY (person_id, host_id),
      CHECK (person_id <> host_id)
    );
  `);
}

// Version 15, lists (lib/store/lists.js): a person's own, private lists
// of people who joined by its link or QR code, for inviting them all.
//
//   - `lists`: owned by one person. `id` is how the API names it (12
//     random base62 characters, never shown in a link); `code` is its join
//     link, /l/<code>, as random, and replaced by a reset so the old link
//     finds nothing (the list and its members stay).
//   - `list_members`: who joined, and when. Only the owner ever sees who.
//     The owner is never a member of their own list (lib/store/lists.js).
//   - `event_lists`: lists a host attached to an event. Attaching invites
//     everyone on it, and anyone who joins later is invited to its
//     attached events still to come. Goes with the event or the list.
function VERSION_15(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lists (
      id          TEXT PRIMARY KEY,
      owner_id    TEXT NOT NULL,
      name        TEXT NOT NULL,
      code        TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS lists_owner ON lists(owner_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS lists_code ON lists(code);

    CREATE TABLE IF NOT EXISTS list_members (
      list_id     TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      person_id   TEXT NOT NULL,
      joined_at   INTEGER NOT NULL,
      PRIMARY KEY (list_id, person_id)
    );
    CREATE INDEX IF NOT EXISTS list_members_person ON list_members(person_id);
    CREATE INDEX IF NOT EXISTS list_members_joined ON list_members(list_id, joined_at);

    CREATE TABLE IF NOT EXISTS event_lists (
      event_id     TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      list_id      TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      attached_by  TEXT NOT NULL,
      attached_at  INTEGER NOT NULL,
      PRIMARY KEY (event_id, list_id)
    );
    CREATE INDEX IF NOT EXISTS event_lists_list ON event_lists(list_id);
  `);
}

// Version 16, test events (lib/store/testEvents.js): `is_test` marks a
// past event made up for the account admin by the Account Manager's "Make
// past events with me" (routes/internal.js), with test people as its
// guests. 1 for those, 0 for every real event, all of which were made
// before this. It's how they're all found again to be deleted, and how
// the calendar feed leaves them out. Indexed on the few that are.
function VERSION_16(db) {
  db.exec(`
    ALTER TABLE events ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1));
    CREATE INDEX IF NOT EXISTS events_test ON events(is_test) WHERE is_test = 1;
  `);
}

// Version 17, adding people to a list (lib/store/lists.js addMembers):
// `added_by` on `list_members` is the owner when they put someone on it
// themselves, and NULL for someone who joined by the link (everyone on a
// list before this joined that way). It's how the owner's list says
// "Added Oct 8" or "Joined Oct 8" (`source` in the API).
function VERSION_17(db) {
  db.exec('ALTER TABLE list_members ADD COLUMN added_by TEXT');
}

// Version 18, where an event is on a map (lib/places.js, lib/eventInput.js):
// `location_latitude` and `location_longitude`, in degrees (both or
// neither), and `location_apple_place_id`, Apple Maps' id for the place.
// Private, exactly like the address: only people who see the address see
// them (lib/views.js). NULL for every event from before, which keep their
// place and address as they were.
function VERSION_18(db) {
  db.exec(`
    ALTER TABLE events ADD COLUMN location_latitude REAL
      CHECK (location_latitude IS NULL OR (location_latitude >= -90 AND location_latitude <= 90));
    ALTER TABLE events ADD COLUMN location_longitude REAL
      CHECK ((location_longitude IS NULL) = (location_latitude IS NULL)
             AND (location_longitude IS NULL OR (location_longitude >= -180 AND location_longitude <= 180)));
    ALTER TABLE events ADD COLUMN location_apple_place_id TEXT;
  `);
}

const UPGRADES = {
  // 1 -> 2: co-hosts need to know who's verified.
  1: VERSION_2,
  // 2 -> 3: the activity wall.
  2: VERSION_3,
  // 3 -> 4: cover images' public keys.
  3: VERSION_4,
  // 4 -> 5: notifications and devices.
  4: VERSION_5,
  // 5 -> 6: removing guests, and new links.
  5: VERSION_6,
  // 6 -> 7: an event's colour, and once a host, always a host.
  6: VERSION_7,
  // 7 -> 8: grey pages, and the hue of a cover.
  7: VERSION_8,
  // 8 -> 9: a cover's sizes.
  8: VERSION_9,
  // 9 -> 10: explicit friends, hidden friends and friend links.
  9: VERSION_10,
  // 10 -> 11: each person's settings (invitations in the calendar).
  10: VERSION_11,
  // 11 -> 12: a grey event's accent.
  11: VERSION_12,
  // 12 -> 13: an event's details.
  12: VERSION_13,
  // 13 -> 14: muting an event, and opting out of a host's invitations.
  13: VERSION_14,
  // 14 -> 15: lists, their members, and the events they're attached to.
  14: VERSION_15,
  // 15 -> 16: test events.
  15: VERSION_16,
  // 16 -> 17: who put someone on a list.
  16: VERSION_17,
  // 17 -> 18: where an event is on a map.
  17: VERSION_18
};

// Opens a new database at `version` (SCHEMA_VERSION), or brings an
// existing one up to it, one step at a time. A new file is made by
// createSchema alone; an existing one is changed by the steps alone, never
// by createSchema (whose CREATE ... IF NOT EXISTS would skip a table that's
// there and could trip over an index on a column a step hasn't added
// yet). It all happens in one transaction: a step that fails leaves the
// file as it was. A file from newer (or unknown) code is refused rather
// than opened with columns this code doesn't know about. `version` and
// `upgrades` are only ever given by the tests.
function prepareSchema(db, file, { version: target = SCHEMA_VERSION, upgrades = UPGRADES } = {}) {
  let version = db.pragma('user_version', { simple: true });
  const isNew = version === 0 && !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'events'").get();
  if (!isNew && (version < 1 || version > target)) {
    throw new Error(`${file} is at schema version ${version}, and this code only opens versions 1 to ${target}.`);
  }
  db.transaction(() => {
    if (isNew) createSchema(db);
    else {
      for (; version < target; version++) {
        if (!upgrades[version]) throw new Error(`no upgrade from schema version ${version} to ${version + 1}`);
        upgrades[version](db);
      }
    }
    db.pragma(`user_version = ${target}`);
  })();
}

function open(file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

// A consistent copy of the database, made with SQLite's own online
// backup, at startup and then daily -- Coolify's volume backups archive
// files as they sit on disk, and a live database file can come out of
// that inconsistent. backups/sqlite/events-YYYY-MM-DD.db, newest 14 kept.
const SNAPSHOTS_KEPT = 14;

function snapshot(db, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  return db
    .backup(path.join(dir, `events-${day}.db`))
    .then(() => {
      fs.readdirSync(dir)
        .filter((f) => /^events-\d{4}-\d{2}-\d{2}\.db$/.test(f))
        .sort()
        .slice(0, -SNAPSHOTS_KEPT)
        .forEach((f) => fs.unlinkSync(path.join(dir, f)));
    })
    .catch((err) => console.error(`[canopy-events] database snapshot failed: ${err.message}`));
}

// Opens (and if need be, creates) the database, and returns the store:
// every query from lib/store/, plus `db` itself. `file` is for tests; the
// server uses DATA_DIR/events.db. Throws if the file is at a schema
// version this code doesn't open.
function init({ file = DB_FILE, snapshots = true } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = open(file);
  prepareSchema(db, file);

  if (snapshots) {
    const dir = path.join(path.dirname(file), 'backups', 'sqlite');
    snapshot(db, dir);
    setInterval(() => snapshot(db, dir), 24 * 60 * 60 * 1000).unref();
  }

  return {
    db,
    ...require('./store/events')(db),
    ...require('./store/rsvps')(db),
    ...require('./store/hosts')(db),
    ...require('./store/wall')(db),
    ...require('./store/notifications')(db),
    ...require('./store/friends')(db),
    ...require('./store/people')(db),
    ...require('./store/calendar')(db),
    ...require('./store/settings')(db),
    ...require('./store/optouts')(db),
    ...require('./store/lists')(db),
    ...require('./store/testEvents')(db)
  };
}

module.exports = { init, open, prepareSchema, createSchema, UPGRADES, DB_FILE, SCHEMA_VERSION, SNAPSHOTS_KEPT, snapshot };
