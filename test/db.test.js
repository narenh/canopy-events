// The database file: made at the current schema version, in WAL mode,
// refused when it's from a version this code doesn't know, and copied
// into dated snapshots with only the newest 14 kept. Plus event ids.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { init, snapshot, SCHEMA_VERSION, SNAPSHOTS_KEPT } = require('../lib/db');
const { newEventId, EVENT_ID_RE } = require('../lib/ids');

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-events-db-test-'));
}

test('a new database is made at the current version, in WAL mode', (t) => {
  const dir = scratch();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = init({ file: path.join(dir, 'events.db'), snapshots: false });
  assert.equal(SCHEMA_VERSION, 1);
  assert.equal(store.db.pragma('user_version', { simple: true }), 1);
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
  db.pragma('user_version = 2');
  db.close();
  assert.throws(() => init({ file, snapshots: false }), /schema version 2/);

  // A file with tables but no version at all is someone else's database.
  const other = path.join(dir, 'other.db');
  const o = new Database(other);
  o.exec('CREATE TABLE events (id TEXT)');
  o.close();
  assert.throws(() => init({ file: other, snapshots: false }), /schema version 0/);
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
