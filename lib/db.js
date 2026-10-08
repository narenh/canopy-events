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
// test/db.test.js checks that a file made at version 1 and brought up by
// the steps ends up with the same tables and columns as a new one.
const SCHEMA_VERSION = 1;

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
}

// Each step brings an existing database from the version it's keyed by
// to the next. Empty until the first deploy (see SCHEMA_VERSION).
//
// A step is keyed by the version it starts from:
//
//   // 1 -> 2: events get a cover image's alt text.
//   1(db) {
//     db.exec('ALTER TABLE events ADD COLUMN cover_alt TEXT');
//   },
const UPGRADES = {};

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
    ...require('./store/friends')(db)
  };
}

module.exports = { init, open, prepareSchema, createSchema, DB_FILE, SCHEMA_VERSION, SNAPSHOTS_KEPT, snapshot };
