-- Schema version 1, exactly as it first shipped. Never edit this file:
-- test/db.test.js makes a database from it and checks that UPGRADES
-- bring it to the same shape as a brand-new one.

CREATE TABLE events (
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

CREATE TABLE hosts (
      event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      person_id  TEXT NOT NULL,
      role       TEXT NOT NULL CHECK (role IN ('creator', 'cohost')),
      added_by   TEXT,
      added_at   INTEGER NOT NULL,
      PRIMARY KEY (event_id, person_id)
    );

CREATE TABLE rsvps (
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

CREATE INDEX events_over ON events(over_at);

CREATE INDEX hosts_person ON hosts(person_id);

CREATE UNIQUE INDEX hosts_one_creator ON hosts(event_id) WHERE role = 'creator';

CREATE INDEX rsvps_person ON rsvps(person_id, status);

CREATE INDEX rsvps_event ON rsvps(event_id, status, status_at);
