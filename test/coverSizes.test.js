// Cover sizes for covers uploaded before there were any (lib/db.js
// version 9): stored at full size only, they keep being served that way
// until the server has made their smaller sizes, which it does in the
// background after it starts (lib/coverBackfill.js). And the conversion
// itself, on photos that aren't plain 8-bit RGB.

const os = require('os');
const fs = require('fs');
const path = require('path');

// lib/coverStore.js reads DATA_DIR when it's loaded: a scratch one, for
// the tests here that call the backfill directly.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-events-sizes-'));
process.env.DATA_DIR = scratch;

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const sharp = require('sharp');
const { startServer, client, makeEvent } = require('./harness');

const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const photo = (width, height) => sharp({ create: { width, height, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 40 } } }).jpeg().toBuffer();

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

test('a cover from before sizes: the full size until they exist, then made after a restart', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const ana = client(server, 'ana');
  const anon = client(server, null);
  const covers = path.join(server.dataDir, 'covers');

  // Three covers, made old-style: only the full size on disk, and no
  // sizes in the database, as an upload before version 9 left them.
  const events = [];
  for (const [w, h] of [[1600, 1200], [1200, 1600], [500, 400]]) {
    const e = await makeEvent(ana, { title: `Old ${w}` });
    const up = (await ana.upload('PUT', `/api/v1/events/${e.id}/cover`, await photo(w, h))).data.event;
    events.push({ id: e.id, url: up.coverImageUrl, sizes: up.coverImages });
  }
  // And one with no cover at all, which the backfill leaves alone.
  const none = await makeEvent(ana, { title: 'No cover' });
  for (const e of events) {
    for (const f of fs.readdirSync(covers)) if (f.startsWith(`${e.id}-`)) fs.unlinkSync(path.join(covers, f));
  }
  server.db().prepare('UPDATE events SET cover_sizes = NULL').run();
  const fullHash = events.map((e) => hash(path.join(covers, `${e.id}.jpg`)));

  // Meanwhile: no sizes in the API, the full size still served, and the
  // page draws it without a srcset.
  const [big] = events;
  const pending = (await anon.get(`/api/v1/events/${big.id}`)).data.event;
  assert.equal(pending.coverImageUrl, big.url);
  assert.deepEqual(pending.coverImages, []);
  assert.equal((await fetch(big.url.replace(/^https?:\/\/[^/]+/, server.base))).status, 200);
  assert.equal((await fetch(big.sizes[0].url.replace(/^https?:\/\/[^/]+/, server.base))).status, 404, 'no 400 yet');
  const html = await (await fetch(`${server.base}/e/${big.id}`)).text();
  assert.ok(html.includes(`<div class="hero"><img class="cover" src="${big.url}" alt="" decoding="async">`), 'the full size, no srcset');

  // A deploy: the server starts, and makes them in the background.
  await server.restart();
  const settled = async (id) => {
    for (let i = 0; i < 100; i++) {
      const got = (await anon.get(`/api/v1/events/${id}`)).data.event.coverImages;
      if (got.length) return got;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`no sizes for ${id}:\n${server.output()}`);
  };
  for (const [i, e] of events.entries()) {
    const sizes = await settled(e.id);
    // The same sizes an upload makes now, at the same URLs (same key and
    // ?v=: the cover hasn't changed), and the full size untouched.
    assert.deepEqual(sizes, e.sizes, `event ${i}`);
    assert.equal(hash(path.join(covers, `${e.id}.jpg`)), fullHash[i], 'the full size is left exactly as it was');
    for (const c of sizes) {
      const r = await fetch(c.url.replace(/^https?:\/\/[^/]+/, server.base));
      assert.equal(r.status, 200, c.url);
      const meta = await sharp(Buffer.from(await r.arrayBuffer())).metadata();
      assert.deepEqual([meta.format, meta.width, meta.height, meta.exif], ['jpeg', c.width, c.height, undefined]);
    }
  }
  assert.deepEqual(events.map((e) => e.sizes.map((c) => c.width)), [[400, 800, 1200, 1600], [400, 800, 1200], [400, 500]]);
  assert.deepEqual((await anon.get(`/api/v1/events/${none.id}`)).data.event.coverImages, []);
  assert.match(server.output(), /cover sizes: made for 3 of 3 older covers/);
  const page = await (await fetch(`${server.base}/e/${big.id}`)).text();
  assert.ok(page.includes(' srcset="'), 'and the page has its srcset');

  // Again: nothing left to do, and nothing changes.
  const before = fs.readdirSync(covers).sort().map((f) => [f, hash(path.join(covers, f))]);
  await server.restart();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(server.output().match(/cover sizes: made/g).length, 1, 'the second start found nothing to do');
  assert.deepEqual(fs.readdirSync(covers).sort().map((f) => [f, hash(path.join(covers, f))]), before);
});

// The backfill itself, against a database and covers folder of its own.
test('the backfill: one cover at a time, and a cover changed meanwhile wins', async (t) => {
  const { init } = require('../lib/db');
  const coverStore = require('../lib/coverStore');
  const { backfillCoverSizes } = require('../lib/coverBackfill');
  const { _stopWorker } = require('../lib/coverImage');
  t.after(() => _stopWorker());
  const store = init({ file: path.join(scratch, 'events.db'), snapshots: false });
  t.after(() => store.db.close());
  const quiet = { log() {}, error() {} };
  const make = (id, key) => {
    store.db.prepare(`INSERT INTO events (id, public_id, title, starts_at, over_at, time_zone, created_at, updated_at)
                      VALUES (?, ?, 'x', 1, 2, 'UTC', 1, 1)`).run(id, id);
    store.setCover(id, key);
  };

  // An old-style cover, and one whose file has gone missing.
  make('AAAAAAAAAAAA', 'KeyA00000000');
  fs.mkdirSync(coverStore.DIR, { recursive: true });
  fs.writeFileSync(path.join(coverStore.DIR, 'AAAAAAAAAAAA.jpg'), await sharp(await photo(1600, 900)).jpeg({ quality: 82 }).toBuffer());
  make('BBBBBBBBBBBB', 'KeyB00000000');
  const edited = store.getEvent('AAAAAAAAAAAA').updatedAt;
  const errors = [];
  let r = await backfillCoverSizes(store, { log: { log() {}, error: (m) => errors.push(m) } });
  assert.deepEqual(r, { pending: 2, done: 1 });
  assert.match(errors.join('\n'), /BBBBBBBBBBBB is missing/);
  assert.deepEqual(store.getEvent('AAAAAAAAAAAA').coverSizes, [{ width: 400, height: 225 }, { width: 800, height: 450 }, { width: 1200, height: 675 }, { width: 1600, height: 900 }]);
  assert.deepEqual(coverStore.variantWidths('AAAAAAAAAAAA').sort((a, b) => a - b), [400, 800, 1200]);
  assert.equal(store.getEvent('AAAAAAAAAAAA').updatedAt, edited, "making sizes isn't an edit");

  // A new upload lands while the worker is busy with the old photo: the
  // old photo's sizes are dropped, and the new cover's stay.
  make('CCCCCCCCCCCC', 'KeyC00000000');
  coverStore.save('CCCCCCCCCCCC', [{ width: 1000, height: 500, jpeg: await photo(1000, 500) }]);
  const realGet = store.getEvent;
  const raced = Object.create(store);
  raced.getEvent = (id) => {
    if (id === 'CCCCCCCCCCCC' && raced.coverKey !== 'done') {
      // The upload: a new key and its own sizes, files and all.
      raced.coverKey = 'done';
      coverStore.save('CCCCCCCCCCCC', [{ width: 300, height: 150, jpeg: Buffer.from('new 300') }]);
      store.setCover('CCCCCCCCCCCC', 'KeyC11111111', { sizes: [{ width: 300, height: 150 }] });
    }
    return realGet.call(store, id);
  };
  r = await backfillCoverSizes(raced, { log: quiet });
  assert.deepEqual(r, { pending: 2, done: 0 });
  assert.deepEqual(coverStore.variantWidths('CCCCCCCCCCCC'), [], 'none of the old photo\'s sizes were written');
  assert.deepEqual(store.getEvent('CCCCCCCCCCCC').coverSizes, [{ width: 300, height: 150 }]);
  // And the store's own guard: sizes only for the cover they were made for.
  assert.equal(store.setCoverSizes('CCCCCCCCCCCC', 'KeyC00000000', [{ width: 1, height: 1 }]), false);
  assert.equal(store.setCoverSizes('AAAAAAAAAAAA', 'KeyA00000000', [{ width: 1, height: 1 }]), false, 'nor twice');
});

test('every size is 8-bit sRGB JPEG, whatever the photo was', async () => {
  const { convertSizes, resizeStored } = require('../lib/coverImage');
  // 16-bit PNG with transparency, a greyscale JPEG, and a CMYK JPEG.
  const inputs = {
    png16: await sharp({ create: { width: 900, height: 600, channels: 4, background: { r: 200, g: 40, b: 40, alpha: 0.5 } } }).png().toColourspace('rgb16').toBuffer(),
    grey: await sharp({ create: { width: 900, height: 600, channels: 3, background: '#777777' } }).toColourspace('b-w').jpeg().toBuffer(),
    cmyk: await sharp({ create: { width: 900, height: 600, channels: 3, background: '#2266aa' } }).toColourspace('cmyk').jpeg().toBuffer()
  };
  for (const [name, buf] of Object.entries(inputs)) {
    const sizes = await convertSizes(buf);
    assert.deepEqual(sizes.map((s) => s.width), [400, 800, 900], name);
    for (const s of sizes) {
      const meta = await sharp(s.jpeg).metadata();
      assert.deepEqual([meta.format, meta.width, meta.height, meta.hasAlpha, meta.space, meta.depth], ['jpeg', s.width, s.height, false, 'srgb', 'uchar'], name);
    }
    // And from the stored full size, the same widths again.
    const again = await resizeStored(sizes[sizes.length - 1].jpeg);
    assert.deepEqual(again.map((s) => [s.width, s.height, !!s.jpeg]), [[400, sizes[0].height, true], [800, sizes[1].height, true], [900, 600, false]], name);
  }
});
