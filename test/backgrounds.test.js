// Curated backgrounds from TMDB (lib/backgrounds.js): a manifest of exact
// backdrops (config/backgrounds.json) and, with a token, a TMDB list; the
// set GET /api/v1/backgrounds answers; choosing one making a real cover
// (PUT .../cover/background); and what's refused. Against a fake TMDB
// (test/fakeTmdb.js): no network, no images in the repo.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { startServer, client, makeEvent } = require('./harness');
const { startFakeTmdb, TOKEN, file } = require('./fakeTmdb');
const { validateManifest, readManifest, DEFAULT_MANIFEST } = require('../lib/backgrounds');

const near = (hue, target, within = 15) => Math.min(Math.abs(hue - target), 360 - Math.abs(hue - target)) <= within;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const idOf = (filePath) => Buffer.from(filePath).toString('base64url');

// A manifest file, for BACKGROUNDS_FILE.
function manifestFile(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-backgrounds-'));
  const f = path.join(dir, 'backgrounds.json');
  fs.writeFileSync(f, JSON.stringify(entries));
  return f;
}

// The owner's picks in the test manifest: two of one film with another
// title between them (grouped together anyway), and one that's wrong.
const MANIFEST = [
  { type: 'movie', tmdbId: 1, title: 'Red Sunset', year: 2001, filePath: file('redSunset') },
  { type: 'tv', tmdbId: 2, title: 'Blue Sea', filePath: file('blueSea') },
  { type: 'movie', tmdbId: 1, title: 'Red Sunset', year: 2001, filePath: file('redSunsetTwo') },
  { type: 'person', tmdbId: 3, title: 'Nobody', filePath: file('nobody') }
];

// GET /backgrounds until it has `n` (the first load runs in the
// background after the server starts).
async function waitForSet(who, n) {
  for (let i = 0; i < 150; i++) {
    const r = await who.get('/api/v1/backgrounds');
    if (r.status === 200 && r.data.backgrounds.length >= n) return r;
    await sleep(100);
  }
  throw new Error(`the set never reached ${n}`);
}

// GET a page as `who`: its HTML, and its body without the inlined scripts.
async function page(server, who, url) {
  const r = await fetch(server.base + url, { headers: { Accept: 'text/html', Cookie: `canopy_session=${server.people[who].token}` } });
  const html = await r.text();
  const start = html.indexOf('<body class=');
  const end = html.indexOf('<script type="application/json" id="pageData">');
  return { status: r.status, html, body: html.slice(start, end) };
}

test('the manifest: what an entry has to be', () => {
  const good = { type: 'movie', tmdbId: 10625, title: 'Mean Girls', filePath: '/cgFV761wxNtPxfVsEVSAM5xEkcG.jpg' };
  let r = validateManifest([good, { ...good, type: 'tv', tmdbId: 61662, title: "Schitt's Creek", filePath: '/1wFyBfKo6LpYppY9UABYkbv320s.jpg', year: 2015 }]);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.entries.map((e) => [e.title, e.year]), [['Mean Girls', null], ["Schitt's Creek", 2015]]);
  for (const bad of [
    null, 'x', [good],
    { ...good, type: 'person' }, { ...good, type: undefined },
    { ...good, tmdbId: '10625' }, { ...good, tmdbId: 0 }, { ...good, tmdbId: 1.5 },
    { ...good, title: '' }, { ...good, title: 7 }, { ...good, title: 'x'.repeat(201) },
    { ...good, filePath: 'cgFV761wxNtPxfVsEVSAM5xEkcG.jpg' }, { ...good, filePath: '/../../etc/passwd' },
    { ...good, filePath: 'https://evil.example/x.jpg' }, { ...good, filePath: '/a.jpg' }, { ...good, filePath: '/cgFV761wxNtPxfVsEVSAM5xEkcG.svg' },
    { ...good, filePath: '/cgFV761wxNtPxfVsEVSAM5xEkcG.jpg?x=1' }, { ...good, year: '2004' }, { ...good, year: 3000 }
  ]) {
    r = validateManifest([bad]);
    assert.equal(r.entries.length, 0, JSON.stringify(bad));
    assert.equal(r.problems.length, 1, JSON.stringify(bad));
  }
  // The same backdrop twice: the first is kept.
  r = validateManifest([good, { ...good, title: 'Again' }]);
  assert.deepEqual(r.entries.map((e) => e.title), ['Mean Girls']);
  assert.match(r.problems[0], /already/);
  // Not an array at all.
  assert.deepEqual(validateManifest({ entries: [] }).entries, []);
  // A title's entries go together, where the title first appears.
  r = validateManifest(MANIFEST);
  assert.deepEqual(r.entries.map((e) => e.filePath), [file('redSunset'), file('redSunsetTwo'), file('blueSea')]);
  assert.equal(r.problems.length, 1);
});

test("the repo's config/backgrounds.json is all good entries", () => {
  const raw = JSON.parse(fs.readFileSync(DEFAULT_MANIFEST, 'utf8'));
  const { entries, problems } = validateManifest(raw);
  assert.deepEqual(problems, []);
  assert.equal(entries.length, raw.length);
  // References only: no image data, no URLs.
  assert.ok(!/data:|https?:/.test(JSON.stringify(raw)));
  const warned = [];
  assert.equal(readManifest(DEFAULT_MANIFEST, { warn: (m) => warned.push(m) }).length, raw.length);
  assert.deepEqual(warned, []);
  // A missing file is an empty manifest, quietly.
  assert.deepEqual(readManifest(path.join(os.tmpdir(), 'no-such-backgrounds.json'), { warn: (m) => warned.push(m) }), []);
  assert.deepEqual(warned, []);
});

test('off without settings: an empty set, no picker, no credit, nothing to choose', async (t) => {
  // No manifest, and a token without a list (or neither): off.
  for (const env of [{}, { TMDB_TOKEN: TOKEN }]) {
    const server = await startServer(env);
    t.after(() => server.stop());
    const ana = client(server, 'ana');
    assert.deepEqual((await ana.get('/api/v1/backgrounds')).data, { enabled: false, backgrounds: [] });
    assert.equal((await client(server, null).get('/api/v1/backgrounds')).status, 401);
    const e = await makeEvent(ana);
    const r = await ana.put(`/api/v1/events/${e.id}/cover/background`, { backgroundId: idOf(file('redSunset')) });
    assert.equal(r.status, 400);
    assert.equal(r.data.reason, 'bad_background');
    for (const url of ['/new', `/e/${e.id}/edit`]) {
      const p = await page(server, 'ana', url);
      assert.equal(p.status, 200);
      assert.ok(p.body.includes('id="coverFile"'), url);
      assert.ok(!p.body.includes('backgroundOpen') && !p.body.includes('backgroundPanel'), `${url}: no picker`);
    }
    assert.ok(!(await page(server, 'ana', '/')).body.includes('tmdb-credit'), 'no credit on the home page');
  }
});

test('the curated set: a manifest and a TMDB list, chosen as a cover', async (t) => {
  const tmdb = await startFakeTmdb();
  t.after(() => tmdb.close());
  const server = await startServer(tmdb.env({ BACKGROUNDS_FILE: manifestFile(MANIFEST) }));
  t.after(() => server.stop());
  const P = server.people;
  const [ana, ben, fay] = ['ana', 'ben', 'fay'].map((n) => client(server, n));
  const anon = client(server, null);
  const set = (await waitForSet(ana, 9)).data;
  const byTitle = (title) => set.backgrounds.filter((b) => b.title === title);

  await t.test('its shape and order: the manifest, then the list, a title\'s together', async () => {
    assert.equal(set.enabled, true);
    assert.deepEqual(set.backgrounds.map((b) => b.title), [
      'Red Sunset', 'Red Sunset', 'Blue Sea', 'The Matrix', 'The Matrix', 'The Matrix', 'Breaking Bad', 'Breaking Bad', 'The Dark Knight'
    ]);
    assert.deepEqual(set.backgrounds.map((b) => b.year), [2001, 2001, null, 1999, 1999, 1999, 2008, 2008, 2008]);
    for (const b of set.backgrounds) {
      assert.deepEqual(Object.keys(b).sort(), ['grayscale', 'height', 'hue', 'id', 'previewUrl', 'thumbUrl', 'title', 'width', 'year']);
      // The id is opaque: no slashes, no URL.
      assert.match(b.id, /^[A-Za-z0-9_-]+$/);
      assert.match(b.thumbUrl, new RegExp(`^${tmdb.imageBase}/w300/[A-Za-z0-9]+\\.jpg$`));
      assert.equal(b.previewUrl, b.thumbUrl.replace('/w300/', '/w780/'));
      // The thumbnail's own size.
      assert.deepEqual([b.width, b.height], [300, 169]);
    }
    // The hue that matches each, worked out on the server.
    for (const b of byTitle('Red Sunset')) assert.ok(near(b.hue, 27) && b.grayscale === false, `red: ${b.hue}`);
    assert.ok(near(byTitle('Blue Sea')[0].hue, 262, 25), `blue: ${byTitle('Blue Sea')[0].hue}`);
    assert.deepEqual([byTitle('The Dark Knight')[0].hue, byTitle('The Dark Knight')[0].grayscale], [null, true]);
    // The manifest's wrong entry was skipped, and said so in the log.
    assert.ok(!set.backgrounds.some((b) => b.title === 'Nobody'));
    assert.match(server.output(), /backgrounds: backgrounds\.json entry 3: type is "movie" or "tv"; skipped/);
  });

  await t.test('textless first, the best three by votes then width; others only when there are none', async () => {
    const paths = (title) => byTitle(title).map((b) => b.thumbUrl.replace(`${tmdb.imageBase}/w300`, ''));
    // The one with words on it has the most votes, and isn't there; D has
    // more votes than the rest, then A and B tie on votes and A is wider.
    assert.deepEqual(paths('The Matrix'), [file('matrixGreenD'), file('matrixGreenA'), file('matrixGreenB')]);
    // Every one of its backdrops has words on it: those, then.
    assert.deepEqual(paths('Breaking Bad'), [file('breakingBadEn'), file('breakingBadDe')]);
    // A title whose images couldn't be had is left out; so is a person.
    assert.ok(!set.backgrounds.some((b) => b.title === 'Broken' || b.title === 'Keanu Reeves'));
    // The list was read page by page.
    const pages = tmdb.apiRequests().filter((r) => r.path === '/4/list/8100');
    assert.ok(pages.length >= 3, 'paginated');
  });

  await t.test('the token goes to TMDB\'s API only, and never comes back out', async () => {
    assert.ok(tmdb.apiRequests().length > 0);
    for (const r of tmdb.apiRequests()) assert.equal(r.authorization, `Bearer ${TOKEN}`, r.path);
    for (const r of tmdb.cdnRequests()) assert.equal(r.authorization, null, `nothing to the image CDN: ${r.path}`);
    const e = await makeEvent(ana);
    for (const url of ['/', '/new', `/e/${e.id}/edit`, `/e/${e.id}`, '/docs']) {
      const p = await page(server, 'ana', url);
      assert.ok(!p.html.includes(TOKEN), url);
    }
    for (const url of ['/api/v1/openapi.yaml']) assert.ok(!(await (await fetch(server.base + url)).text()).includes(TOKEN), url);
    // Every API answer is checked by the harness (noTmdbToken); the log too.
    assert.ok(!server.output().includes(TOKEN), 'not in the log');
  });

  await t.test('the set is cached: asking again asks TMDB nothing', async () => {
    const api = tmdb.apiRequests().length;
    const cdn = tmdb.cdnRequests().length;
    for (let i = 0; i < 3; i++) assert.deepEqual((await ana.get('/api/v1/backgrounds')).data, set);
    await page(server, 'ana', '/new');
    assert.equal(tmdb.apiRequests().length, api);
    assert.equal(tmdb.cdnRequests().length, cdn);
    const r = await ana.get('/api/v1/backgrounds');
    assert.equal(r.headers.get('cache-control'), 'private, max-age=3600');
  });

  await t.test('choosing one makes it the cover, exactly like an upload', async () => {
    const e = await makeEvent(ana, { themeHue: 200 });
    const red = byTitle('Red Sunset')[0];
    const r = await ana.put(`/api/v1/events/${e.id}/cover/background`, { backgroundId: red.id });
    assert.equal(r.status, 200, r.text);
    const up = r.data.event;
    // The original (2000 px wide) at every size, as an upload.
    assert.deepEqual(up.coverImages.map((c) => [c.width, c.height]), [[400, 225], [800, 450], [1200, 675], [1600, 900]]);
    assert.equal(up.coverImages[3].url, up.coverImageUrl);
    for (const c of up.coverImages) {
      const img = await fetch(c.url.replace(/^https?:\/\/[^/]+/, server.base));
      assert.equal(img.status, 200);
      const meta = await sharp(Buffer.from(await img.arrayBuffer())).metadata();
      assert.deepEqual([meta.format, meta.width, meta.height, meta.exif], ['jpeg', c.width, c.height, undefined]);
    }
    // Its own URL here, not TMDB's.
    assert.match(up.coverImageUrl, new RegExp(`^${server.base}/covers/[0-9A-Za-z]{12}\\.jpg\\?v=\\d+$`));
    // coverHue from the cover, the same as the set said; the event's own
    // colour left alone.
    assert.ok(near(up.coverHue, red.hue, 3), `${up.coverHue} vs ${red.hue}`);
    assert.equal(up.coverGrayscale, false);
    assert.equal(up.themeHue, 200);
    assert.ok(tmdb.cdnRequests().some((q) => q.path === `/t/p/original${file('redSunset')}`), 'the original was downloaded');
    // From then on it's an ordinary cover: removed like one.
    const gone = (await ana.del(`/api/v1/events/${e.id}/cover`)).data.event;
    assert.equal(gone.coverImageUrl, null);
    // A grey one: no hue.
    const grey = (await ana.put(`/api/v1/events/${e.id}/cover/background`, { backgroundId: byTitle('The Dark Knight')[0].id })).data.event;
    assert.deepEqual([grey.coverHue, grey.coverGrayscale], [null, true]);
    // An app, with its bearer token, the same.
    const anaApp = client(server, 'ana', { mode: 'bearer' });
    assert.equal((await anaApp.put(`/api/v1/events/${e.id}/cover/background`, { backgroundId: red.id })).status, 200);
  });

  await t.test('hosts only: co-hosts yes, guests and strangers no', async () => {
    const e = await makeEvent(ana);
    const id = set.backgrounds[0].id;
    let r = await ben.put(`/api/v1/events/${e.id}/cover/background`, { backgroundId: id });
    assert.equal(r.status, 403);
    assert.equal(r.data.reason, 'hosts_only');
    assert.equal((await anon.put(`/api/v1/events/${e.id}/cover/background`, { backgroundId: id })).status, 401);
    assert.equal((await ana.put('/api/v1/events/AAAAAAAAAAAA/cover/background', { backgroundId: id })).status, 404);
    // A page somewhere else.
    r = await client(server, 'ana', { origin: 'https://evil.example' }).put(`/api/v1/events/${e.id}/cover/background`, { backgroundId: id });
    assert.equal(r.data.reason, 'bad_origin');
    await fay.get('/api/v1/me');
    await ana.post(`/api/v1/events/${e.id}/cohosts`, { personId: P.fay.id });
    assert.equal((await fay.put(`/api/v1/events/${e.id}/cover/background`, { backgroundId: id })).status, 200);
  });

  await t.test('only an id in the set: nothing else is ever fetched (no SSRF)', async () => {
    const e = await makeEvent(ana);
    const before = tmdb.requests.length;
    for (const backgroundId of [
      idOf(file('notInTheSet')), // a TMDB-shaped path, but not one of ours
      idOf(file('matrixGreenText')), // TMDB has it; the set doesn't
      idOf(file('matrixGreenE')), // the fourth best: not in the set
      idOf('/../../t/p/original/x.jpg'),
      idOf(`${tmdb.base}/t/p/original${file('redSunset')}`),
      idOf('http://169.254.169.254/latest/meta-data/'),
      file('redSunset'), // a raw path
      set.backgrounds[0].thumbUrl, // a URL
      'AAAA', '', 'x'.repeat(500), `${set.backgrounds[0].id}/../x`, `${set.backgrounds[0].id}=`
    ]) {
      const r = await ana.put(`/api/v1/events/${e.id}/cover/background`, { backgroundId });
      assert.equal(r.status, 400, backgroundId);
      assert.equal(r.data.reason, 'bad_background', backgroundId);
    }
    for (const body of [{}, { backgroundId: 7 }, { backgroundId: null }, { backgroundId: [set.backgrounds[0].id] }, { id: set.backgrounds[0].id }]) {
      const r = await ana.put(`/api/v1/events/${e.id}/cover/background`, body);
      assert.equal(r.data.reason, 'bad_background', JSON.stringify(body));
    }
    assert.equal(tmdb.requests.length, before, 'TMDB was asked nothing');
    assert.equal((await ana.get(`/api/v1/events/${e.id}`)).data.event.coverImageUrl, null);
  });

  await t.test('TMDB\'s CDN down when choosing: 502, and the cover is as it was', async () => {
    const e = await makeEvent(ana);
    tmdb.cdnDown = true;
    try {
      const r = await ana.put(`/api/v1/events/${e.id}/cover/background`, { backgroundId: set.backgrounds[0].id });
      assert.equal(r.status, 502);
      assert.equal(r.data.reason, 'background_unreachable');
    } finally {
      tmdb.cdnDown = false;
    }
    assert.equal((await ana.get(`/api/v1/events/${e.id}`)).data.event.coverImageUrl, null);
  });

  await t.test('the same daily limit as uploads, counted together', async () => {
    // Dee hasn't uploaded anything: 29 uploads (refused, but counted),
    // then a background is the 30th, and the next is over.
    const dee = client(server, 'dee');
    const e = await makeEvent(dee);
    for (let i = 0; i < 29; i++) await dee.upload('PUT', `/api/v1/events/${e.id}/cover`, Buffer.from('GIF89a not a photo'));
    assert.equal((await dee.put(`/api/v1/events/${e.id}/cover/background`, { backgroundId: set.backgrounds[0].id })).status, 200);
    const r = await dee.put(`/api/v1/events/${e.id}/cover/background`, { backgroundId: set.backgrounds[0].id });
    assert.equal(r.status, 429);
    assert.equal(r.data.reason, 'rate_limited');
    assert.equal((await dee.upload('PUT', `/api/v1/events/${e.id}/cover`, Buffer.from('GIF89a'))).status, 429);
  });

  await t.test('the editor has the picker, grouped and labelled, with TMDB\'s credit; Your Events has the credit', async () => {
    const e = await makeEvent(ana);
    for (const url of ['/new', `/e/${e.id}/edit`]) {
      const { body, html } = await page(server, 'ana', url);
      assert.match(body, /<button type="button" class="hero-btn" id="backgroundOpen" data-action="open-backgrounds" aria-haspopup="dialog" aria-controls="backgroundPanel" aria-label="Choose a background"/);
      assert.match(body, /id="backgroundPanel" role="dialog" aria-modal="true" aria-labelledby="backgroundHeading" hidden>/);
      const picks = Array.from(body.matchAll(/<button type="button" class="bg-pick" data-action="pick-background" data-id="([^"]+)" aria-label="([^"]+)"/g));
      assert.deepEqual(picks.map((m) => m[1]), set.backgrounds.map((b) => b.id));
      assert.deepEqual(picks.map((m) => m[2]).slice(0, 6), [
        'Red Sunset (2001), 1 of 2', 'Red Sunset (2001), 2 of 2', 'Blue Sea',
        'The Matrix (1999), 1 of 3', 'The Matrix (1999), 2 of 3', 'The Matrix (1999), 3 of 3'
      ]);
      assert.deepEqual(Array.from(body.matchAll(/<p class="bg-title">([^<]+)<\/p>/g)).map((m) => m[1]),
        ['Red Sunset (2001)', 'Blue Sea', 'The Matrix (1999)', 'Breaking Bad (2008)', 'The Dark Knight (2008)']);
      assert.match(body, /<p class="tmdb-credit bg-credit"><svg class="tmdb-logo"[^>]*role="img" aria-label="TMDB">[\s\S]*?<span>This product uses the TMDB API but is not endorsed or certified by TMDB\.<\/span><\/p>/);
      // The page's script has the set, with each one's hue.
      const data = JSON.parse(/<script type="application\/json" id="pageData">([\s\S]*?)<\/script>/.exec(html)[1]);
      assert.deepEqual(data.backgrounds, set.backgrounds);
    }
    const home = await page(server, 'ana', '/');
    assert.match(home.body, /<p class="tmdb-credit home-credit"><svg class="tmdb-logo"/);
  });
});

test('a TMDB outage keeps the last good set; it comes back when TMDB does', async (t) => {
  const tmdb = await startFakeTmdb();
  t.after(() => tmdb.close());
  const server = await startServer(tmdb.env({ BACKGROUNDS_FILE: manifestFile(MANIFEST), BACKGROUNDS_REFRESH_MS: '600' }));
  t.after(() => server.stop());
  const ana = client(server, 'ana');
  const good = (await waitForSet(ana, 9)).data;

  // Down, API and CDN: the refreshes fail, and the set stays.
  tmdb.down = true;
  const asked = tmdb.requests.length;
  for (let i = 0; i < 50 && tmdb.requests.length < asked + 2; i++) await sleep(100);
  assert.ok(tmdb.requests.length >= asked + 2, 'it tried again');
  await sleep(700);
  assert.deepEqual((await ana.get('/api/v1/backgrounds')).data, good);
  assert.match(server.output(), /the TMDB list couldn't be loaded \(TMDB answered 503 for \/4\/list\/8100\); keeping the last one/);
  assert.ok(!server.output().includes(TOKEN));

  // Back, with a title gone from the list: the next refresh has it so.
  tmdb.down = false;
  tmdb.data.lists['8100'] = tmdb.data.lists['8100'].filter((x) => x.id !== 155);
  let now;
  for (let i = 0; i < 60; i++) {
    now = (await ana.get('/api/v1/backgrounds')).data;
    if (now.backgrounds.length === 8) break;
    await sleep(100);
  }
  assert.ok(!now.backgrounds.some((b) => b.title === 'The Dark Knight'), 'refreshed');
  assert.equal(now.backgrounds.length, 8);
});

test('a manifest alone needs no token: TMDB\'s API is never asked', async (t) => {
  const tmdb = await startFakeTmdb();
  t.after(() => tmdb.close());
  const server = await startServer({ BACKGROUNDS_FILE: manifestFile(MANIFEST), TMDB_IMAGE_BASE: tmdb.imageBase });
  t.after(() => server.stop());
  const ana = client(server, 'ana');
  const set = (await waitForSet(ana, 3)).data;
  assert.equal(set.enabled, true);
  assert.deepEqual(set.backgrounds.map((b) => b.title), ['Red Sunset', 'Red Sunset', 'Blue Sea']);
  assert.equal(tmdb.apiRequests().length, 0);
  const e = await makeEvent(ana);
  const r = await ana.put(`/api/v1/events/${e.id}/cover/background`, { backgroundId: set.backgrounds[2].id });
  assert.equal(r.status, 200, r.text);
  assert.ok(near(r.data.event.coverHue, set.backgrounds[2].hue, 3));
  assert.equal(tmdb.apiRequests().length, 0);
});
