// The database file: made at the current schema version, in WAL mode,
// refused when it's from a version this code doesn't know, and copied
// into dated snapshots with only the newest 14 kept. Plus event ids.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { init, open, prepareSchema, snapshot, UPGRADES, SCHEMA_VERSION, SNAPSHOTS_KEPT } = require('../lib/db');
const { newEventId, EVENT_ID_RE } = require('../lib/ids');

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-events-db-test-'));
}

test('a new database is made at the current version, in WAL mode', (t) => {
  const dir = scratch();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = init({ file: path.join(dir, 'events.db'), snapshots: false });
  assert.equal(store.db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
  // Every version from 1 has its step.
  for (let v = 1; v < SCHEMA_VERSION; v++) assert.equal(typeof UPGRADES[v], 'function', `the step from ${v}`);
  assert.equal(store.db.pragma('journal_mode', { simple: true }), 'wal');
  // Room for what comes next, without reshaping anything.
  const cols = (table) => store.db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((c) => c.name);
  for (const c of ['guests_allowed', 'capacity', 'cover_image_at']) assert.ok(cols('events').includes(c), c);
  assert.ok(cols('rsvps').includes('guests'));
  assert.ok(cols('hosts').includes('role'));
  store.db.close();
  // Opening it again is fine.
  init({ file: path.join(dir, 'events.db'), snapshots: false }).db.close();
});

test('a database from an unknown schema version is refused, not opened', (t) => {
  const dir = scratch();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'events.db');
  init({ file, snapshots: false }).db.close();
  const db = new Database(file);
  db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
  db.close();
  assert.throws(() => init({ file, snapshots: false }), new RegExp(`schema version ${SCHEMA_VERSION + 1}`));

  // A file with tables but no version at all is someone else's database.
  const other = path.join(dir, 'other.db');
  const o = new Database(other);
  o.exec('CREATE TABLE events (id TEXT)');
  o.close();
  assert.throws(() => init({ file: other, snapshots: false }), /schema version 0/);
});

// Tables, their columns (name, type, not null, default, key) and indexes:
// what has to match between an upgraded file and a new one.
function shape(db) {
  const out = {};
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()) {
    out[name] = {
      columns: db.prepare(`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info('${name}') ORDER BY name`).all(),
      indexes: db.prepare(`SELECT name, "unique", partial FROM pragma_index_list('${name}') ORDER BY name`).all()
    };
  }
  return out;
}

test('a version 1 file, as first shipped, is brought up to the same shape as a new one', (t) => {
  const dir = scratch();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'events.db');
  const old = new Database(file);
  old.exec(fs.readFileSync(path.join(__dirname, 'fixtures', 'schema-v1.sql'), 'utf8'));
  old.pragma('user_version = 1');
  old.prepare("INSERT INTO events (id, title, starts_at, over_at, time_zone, created_at, updated_at) VALUES ('AAAAAAAAAAAA', 'Kept', 1, 2, 'UTC', 1, 1)").run();
  old.prepare(`INSERT INTO rsvps (event_id, person_id, status, guests, invited_by, invited_at, responded_at, status_at, created_at)
               VALUES ('AAAAAAAAAAAA', '00000000-0000-4000-8000-000000000003', 'going', 2, 'x', 5, 6, 7, 8)`).run();
  old.prepare(`INSERT INTO hosts (event_id, person_id, role, added_by, added_at)
               VALUES ('AAAAAAAAAAAA', '00000000-0000-4000-8000-000000000001', 'creator', NULL, 3)`).run();
  old.close();
  // A co-host who had stepped down before version 7 (version 3's wall
  // remembers them), added to the file once it's at version 6.
  {
    const v6 = new Database(file);
    prepareSchema(v6, file, { version: 6 });
    v6.prepare(`INSERT INTO wall (event_id, type, person_id, created_at) VALUES ('AAAAAAAAAAAA', 'cohost_added', '00000000-0000-4000-8000-000000000005', 4)`).run();
    v6.close();
  }

  const upgraded = init({ file, snapshots: false });
  const fresh = init({ file: path.join(dir, 'fresh.db'), snapshots: false });
  assert.equal(upgraded.db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
  assert.deepEqual(shape(upgraded.db), shape(fresh.db));
  assert.equal(upgraded.getEvent('AAAAAAAAAAAA').title, 'Kept');
  // Version 2: who's been seen verified.
  upgraded.noteVerification('00000000-0000-4000-8000-000000000001', true);
  // Version 3: the wall.
  assert.equal(upgraded.addPost('AAAAAAAAAAAA', '00000000-0000-4000-8000-000000000001', 'hi').body, 'hi');
  // Version 4: cover keys.
  assert.equal(upgraded.setCover('AAAAAAAAAAAA', 'CoverKey1234').coverKey, 'CoverKey1234');
  assert.equal(upgraded.getEventByCoverKey('CoverKey1234').id, 'AAAAAAAAAAAA');
  // Version 5: notifications and devices.
  assert.equal(upgraded.addNotifications('invited', ['00000000-0000-4000-8000-000000000002'], { eventId: 'AAAAAAAAAAAA' })[0].isNew, true);
  upgraded.registerDevice('00000000-0000-4000-8000-000000000002', 'ios', 'a'.repeat(64));
  assert.equal(upgraded.devicesOf('00000000-0000-4000-8000-000000000002').length, 1);
  // Version 6: the event's link is what its id was; the answer came
  // through rsvps being rebuilt whole; and 'removed' is a status.
  assert.equal(upgraded.getEventByLink('AAAAAAAAAAAA').id, 'AAAAAAAAAAAA');
  assert.deepEqual(upgraded.getRsvp('AAAAAAAAAAAA', '00000000-0000-4000-8000-000000000003'), {
    eventId: 'AAAAAAAAAAAA', personId: '00000000-0000-4000-8000-000000000003', status: 'going', guests: 2,
    invitedBy: 'x', invitedAt: 5, respondedAt: 6, statusAt: 7, createdAt: 8
  });
  assert.equal(upgraded.removeGuest('AAAAAAAAAAAA', '00000000-0000-4000-8000-000000000003').outcome, 'removed');
  assert.equal(upgraded.getRsvp('AAAAAAAAAAAA', '00000000-0000-4000-8000-000000000003').status, 'removed');
  // Version 7: an event's colour, Canopy green (null) until a host picks
  // one, and nothing outside 0-359 stored.
  assert.equal(upgraded.getEvent('AAAAAAAAAAAA').themeHue, null);
  assert.equal(upgraded.updateEvent('AAAAAAAAAAAA', { themeHue: 300 }).themeHue, 300);
  assert.throws(() => upgraded.db.prepare("UPDATE events SET theme_hue = 360 WHERE id = 'AAAAAAAAAAAA'").run(), /CHECK/);
  // Version 8: grey pages, and the colour of a cover (unknown for a cover
  // from before).
  assert.equal(upgraded.getEvent('AAAAAAAAAAAA').themeGrayscale, false);
  assert.equal(upgraded.updateEvent('AAAAAAAAAAAA', { themeGrayscale: true }).themeGrayscale, true);
  assert.deepEqual([upgraded.getEvent('AAAAAAAAAAAA').coverHue, upgraded.getEvent('AAAAAAAAAAAA').coverGrayscale], [null, false]);
  const hued = upgraded.setCover('AAAAAAAAAAAA', 'CoverKey5678', { hue: 200 });
  assert.deepEqual([hued.coverHue, hued.coverGrayscale], [200, false]);
  // Version 9: a cover's sizes; one from before has none until the
  // backfill gives it some.
  assert.equal(hued.coverSizes, null);
  assert.deepEqual(upgraded.coversWithoutSizes(), [{ id: 'AAAAAAAAAAAA', coverKey: 'CoverKey5678' }]);
  assert.equal(upgraded.setCoverSizes('AAAAAAAAAAAA', 'CoverKey5678', [{ width: 400, height: 300 }, { width: 640, height: 480 }]), true);
  assert.deepEqual(upgraded.getEvent('AAAAAAAAAAAA').coverSizes, [{ width: 400, height: 300 }, { width: 640, height: 480 }]);
  assert.deepEqual(upgraded.coversWithoutSizes(), []);
  const cleared = upgraded.setCover('AAAAAAAAAAAA', null);
  assert.deepEqual([cleared.coverHue, cleared.coverGrayscale, cleared.coverSizes], [null, false, null]);
  // And whoever was hosting at the upgrade has hosted, from when
  // they started; nobody else has, until they host.
  assert.equal(upgraded.hasHosted('00000000-0000-4000-8000-000000000001'), true);
  assert.deepEqual(upgraded.db.prepare('SELECT first_at FROM hosted_people WHERE person_id = ?').get('00000000-0000-4000-8000-000000000001'), { first_at: 3 });
  assert.equal(upgraded.hasHosted('00000000-0000-4000-8000-000000000005'), true, 'a co-host the wall remembers');
  assert.equal(upgraded.hasHosted('00000000-0000-4000-8000-000000000003'), false);
  upgraded.addCohost('AAAAAAAAAAAA', '00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001');
  upgraded.removeCohost('AAAAAAAAAAAA', '00000000-0000-4000-8000-000000000003');
  assert.equal(upgraded.hasHosted('00000000-0000-4000-8000-000000000003'), true, 'and keeps it after stepping down');
  assert.equal(upgraded.db.pragma('foreign_key_check').length, 0);
  assert.equal(upgraded.isKnownVerified('00000000-0000-4000-8000-000000000001'), true);
  upgraded.db.close();
  fresh.db.close();
});

test('upgrades run one step at a time, and a failed step changes nothing', (t) => {
  const dir = scratch();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // A file at version 1, and two made-up steps (not the real ones: this is
  // about how steps are run).
  const file = path.join(dir, 'events.db');
  const v1 = new Database(file);
  v1.exec(fs.readFileSync(path.join(__dirname, 'fixtures', 'schema-v1.sql'), 'utf8'));
  v1.pragma('user_version = 1');
  v1.close();
  const upgrades = {
    1(db) { db.exec('ALTER TABLE events ADD COLUMN two TEXT'); },
    2(db) { db.exec('ALTER TABLE events ADD COLUMN three TEXT'); }
  };
  const cols = (db) => db.prepare("SELECT name FROM pragma_table_info('events')").all().map((c) => c.name);

  // A step that throws: the file stays at version 1, without its column.
  let db = open(file);
  assert.throws(() => prepareSchema(db, file, { version: 3, upgrades: { ...upgrades, 2() { throw new Error('boom'); } } }), /boom/);
  assert.equal(db.pragma('user_version', { simple: true }), 1);
  assert.ok(!cols(db).includes('two'));
  // A missing step is an error, not a skip.
  assert.throws(() => prepareSchema(db, file, { version: 3, upgrades: { 1: upgrades[1] } }), /no upgrade from schema version 2/);
  assert.equal(db.pragma('user_version', { simple: true }), 1);
  // Both steps: version 3, both columns.
  prepareSchema(db, file, { version: 3, upgrades });
  assert.equal(db.pragma('user_version', { simple: true }), 3);
  assert.ok(cols(db).includes('two') && cols(db).includes('three'));
  db.close();
  // And code that only knows version 2 won't open it now.
  db = open(file);
  assert.throws(() => prepareSchema(db, file, { version: 2, upgrades }), /schema version 3/);
  db.close();
});

test('snapshots: one a day, newest 14 kept', async (t) => {
  const dir = scratch();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = init({ file: path.join(dir, 'events.db'), snapshots: false });
  const snaps = path.join(dir, 'backups', 'sqlite');
  fs.mkdirSync(snaps, { recursive: true });
  for (let d = 1; d <= 20; d++) fs.writeFileSync(path.join(snaps, `events-2020-01-${String(d).padStart(2, '0')}.db`), '');
  fs.writeFileSync(path.join(snaps, 'not-a-snapshot.txt'), '');
  await snapshot(store.db, snaps);
  const left = fs.readdirSync(snaps).filter((f) => f.startsWith('events-')).sort();
  assert.equal(left.length, SNAPSHOTS_KEPT);
  assert.equal(left[left.length - 1], `events-${new Date().toISOString().slice(0, 10)}.db`);
  assert.ok(fs.existsSync(path.join(snaps, 'not-a-snapshot.txt')), 'other files are left alone');
  // The snapshot is a real, openable copy.
  const copy = new Database(path.join(snaps, left[left.length - 1]), { readonly: true });
  assert.equal(copy.pragma('user_version', { simple: true }), SCHEMA_VERSION);
  copy.close();
  store.db.close();
});

test('event ids: 12 characters of base62, and different every time', () => {
  const seen = new Set();
  for (let i = 0; i < 5000; i++) {
    const id = newEventId();
    assert.match(id, EVENT_ID_RE);
    seen.add(id);
  }
  assert.equal(seen.size, 5000);
  // Every character of the alphabet turns up (no byte-to-character bias
  // that leaves some out).
  const chars = new Set([...Array.from(seen).join('')]);
  assert.equal(chars.size, 62);
});
