// Duplicating an event: the draft a host's editor starts from (GET
// /api/v1/events/{id}/duplicate-draft), making it with POST /events and
// `coverFrom` (a copy of the cover, as its own files), and the web's
// Duplicate: the host ⋯ menu item and /new?from=<id>.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { startServer, client, makeEvent, findLeaks } = require('./harness');
const UI = require('../public/ui.js');

const photo = () => sharp({ create: { width: 1800, height: 1200, channels: 3, background: '#7a1fa8' } }).jpeg().toBuffer();

const DETAILS = [
  { type: 'link', label: 'Playlist', value: 'https://open.spotify.com/playlist/x' },
  { type: 'dress_code', label: null, value: 'Fierce' },
  { type: 'food', label: 'Snacks', value: 'Popcorn' },
  { type: 'parking', label: null, value: 'Garage on 5th' },
  { type: 'accommodation', label: null, value: 'Couch' },
  { type: 'phone', label: 'Door', value: '(415) 555-0199' },
  { type: 'info', label: null, value: 'Buzz 4' }
];

// The fields a draft carries, by name, in the order the API sends them.
const DRAFT_FIELDS = ['title', 'description', 'timeZone', 'locationName', 'locationAddress', 'details', 'guestListVisibility', 'guestsAllowed',
  'capacity', 'themeHue', 'themeGrayscale', 'accentHue', 'coverFrom', 'coverImageUrl', 'coverImages', 'coverHue', 'coverGrayscale', 'lists'];

// GET a page as `who`, with no contact details anywhere in it.
async function page(server, who, url) {
  const r = await who.get(url, { headers: { Accept: 'text/html' } });
  assert.deepEqual(findLeaks(r.text, null, server.people), [], `contact details in ${url}`);
  return r;
}
function pageData(html) {
  const m = /<script type="application\/json" id="pageData">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, 'page has its data');
  return JSON.parse(m[1]);
}

test('duplicating an event', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const P = server.people;
  const [ana, ben, cy, una] = ['ana', 'ben', 'cy', 'una'].map((n) => client(server, n));
  const anaApp = client(server, 'ana', { mode: 'bearer' });
  const anon = client(server, null);
  const fetchCover = (url) => fetch(url.replace(/^https?:\/\/[^/]+/, server.base));

  // Drag Race night: everything set, a cover, a co-host, guests, an
  // invitation, a wall post and a list on it.
  const src = await makeEvent(ana, {
    title: 'Drag Race night',
    description: 'Snacks provided.\nBring a friend.',
    startsAt: new Date(Date.now() + 3 * 86400e3).toISOString(),
    endsAt: new Date(Date.now() + 3 * 86400e3 + 3 * 3600e3).toISOString(),
    timeZone: 'America/New_York',
    locationName: "Ana's place",
    locationAddress: '1 Market St\nApt 4',
    details: DETAILS,
    guestListVisibility: 'responded',
    guestsAllowed: 2,
    capacity: 30,
    themeGrayscale: true,
    accentHue: 300
  });
  const covered = await ana.upload('PUT', `/api/v1/events/${src.id}/cover`, await photo(), { type: 'image/jpeg' });
  assert.equal(covered.status, 200, covered.text);
  const source = covered.data.event;
  assert.ok(source.coverImages.length >= 2, 'stored at several sizes');
  await cy.get('/api/v1/me');
  await ana.post(`/api/v1/events/${src.id}/cohosts`, { personId: P.cy.id });
  await ben.put(`/api/v1/events/${src.id}/rsvp`, { status: 'going' });
  await ana.post(`/api/v1/events/${src.id}/invites`, { personIds: [P.dee.id] });
  await ben.post(`/api/v1/events/${src.id}/wall`, { text: 'Can not wait' });
  const list = (await ana.post('/api/v1/me/lists', { name: 'Drag Race' })).data.list;
  await una.post(`/api/v1/list-links/${list.code}/join`);
  const attached = await ana.put(`/api/v1/events/${src.id}/lists/${list.id}`);
  assert.equal(attached.status, 200, attached.text);

  let draft;
  await t.test('the draft has everything about the event, and no date or times', async () => {
    const r = await ana.get(`/api/v1/events/${src.id}/duplicate-draft`);
    assert.equal(r.status, 200, r.text);
    draft = r.data.draft;
    assert.deepEqual(Object.keys(draft), DRAFT_FIELDS);
    assert.deepEqual(
      {
        title: draft.title, description: draft.description, timeZone: draft.timeZone, locationName: draft.locationName,
        locationAddress: draft.locationAddress, guestListVisibility: draft.guestListVisibility, guestsAllowed: draft.guestsAllowed,
        capacity: draft.capacity, themeHue: draft.themeHue, themeGrayscale: draft.themeGrayscale, accentHue: draft.accentHue
      },
      {
        title: 'Drag Race night', description: 'Snacks provided.\nBring a friend.', timeZone: 'America/New_York', locationName: "Ana's place",
        locationAddress: '1 Market St\nApt 4', guestListVisibility: 'responded', guestsAllowed: 2, capacity: 30, themeHue: null,
        themeGrayscale: true, accentHue: 300
      }
    );
    // Every detail, private ones too, in the shape POST takes.
    assert.deepEqual(draft.details, source.details.map(({ type, label, value }) => ({ type, label, value })));
    assert.equal(draft.details.length, DETAILS.length);
    // No time at all: not even null fields to send back by mistake.
    for (const k of ['startsAt', 'endsAt', 'overAt']) assert.ok(!(k in draft), k);
    // The cover, to show, and how to copy it.
    assert.equal(draft.coverFrom, src.id);
    assert.equal(draft.coverImageUrl, source.coverImageUrl);
    assert.deepEqual(draft.coverImages, source.coverImages);
    assert.equal(draft.coverHue, source.coverHue);
    assert.equal(draft.coverGrayscale, source.coverGrayscale);
    // The host's own lists that were on it, to attach again themselves.
    assert.deepEqual(draft.lists, [{ id: list.id, name: 'Drag Race' }]);
    // The same for an app, and for a co-host (whose lists those aren't).
    assert.deepEqual((await anaApp.get(`/api/v1/events/${src.id}/duplicate-draft`)).data.draft, draft);
    const cyDraft = await cy.get(`/api/v1/events/${src.id}/duplicate-draft`);
    assert.equal(cyDraft.status, 200, cyDraft.text);
    assert.deepEqual(cyDraft.data.draft, { ...draft, lists: [] });
  });

  await t.test('only hosts, signed in and verified', async () => {
    const url = `/api/v1/events/${src.id}/duplicate-draft`;
    const guest = await ben.get(url);
    assert.deepEqual([guest.status, guest.data.reason], [403, 'hosts_only']);
    assert.equal((await client(server, 'eve').get(url)).data.reason, 'hosts_only', 'not on it at all');
    const out = await anon.get(url);
    assert.deepEqual([out.status, out.data.reason], [401, 'sign_in_required']);
    const quick = await una.get(url);
    assert.deepEqual([quick.status, quick.data.reason], [403, 'email_unverified']);
    assert.ok(quick.data.verify);
    // Even an unverified host (which the API never makes), since a
    // duplicate is making an event.
    server.db().prepare("INSERT INTO hosts (event_id, person_id, role, added_by, added_at) VALUES (?, ?, 'cohost', ?, ?)").run(src.id, P.una.id, P.ana.id, Date.now());
    assert.equal((await una.get(url)).data.reason, 'email_unverified');
    server.db().prepare('DELETE FROM hosts WHERE event_id = ? AND person_id = ?').run(src.id, P.una.id);
    const wrong = await ana.get('/api/v1/events/AAAAAAAAAAAA/duplicate-draft');
    assert.deepEqual([wrong.status, wrong.data.reason], [404, 'event_not_found']);
    // The cover can't be had by anyone else either.
    const r = await ben.post('/api/v1/events', { ...draft, startsAt: '2030-01-01T20:00:00Z' });
    assert.deepEqual([r.status, r.data.reason], [403, 'hosts_only']);
    const q = await una.post('/api/v1/events', { ...draft, startsAt: '2030-01-01T20:00:00Z' });
    assert.deepEqual([q.status, q.data.reason], [403, 'email_unverified']);
    // A refusal makes nothing.
    assert.equal((await ben.get('/api/v1/me/events/hosting')).data.events.length, 0);
  });

  let copy;
  await t.test('saved: a new event with everything but its people, wall and lists, and its own cover', async () => {
    const startsAt = '2030-01-04T00:00:00.000Z';
    const r = await ana.post('/api/v1/events', { ...draft, startsAt });
    assert.equal(r.status, 201, r.text);
    copy = r.data.event;
    assert.notEqual(copy.id, src.id);
    assert.equal(copy.startsAt, startsAt);
    assert.equal(copy.endsAt, null);
    for (const k of ['title', 'description', 'timeZone', 'locationName', 'locationAddress', 'details', 'guestListVisibility', 'guestsAllowed',
      'capacity', 'themeHue', 'themeGrayscale', 'accentHue', 'coverHue', 'coverGrayscale']) {
      assert.deepEqual(copy[k], source[k], k);
    }
    // Its own cover: a new URL, every size, the same pictures.
    assert.ok(copy.coverImageUrl && copy.coverImageUrl !== source.coverImageUrl);
    assert.deepEqual(copy.coverImages.map((c) => [c.width, c.height]), source.coverImages.map((c) => [c.width, c.height]));
    for (const [a, b] of copy.coverImages.map((c, i) => [c.url, source.coverImages[i].url])) {
      assert.notEqual(a, b);
      const [x, y] = await Promise.all([fetchCover(a), fetchCover(b)]);
      assert.equal(x.status, 200);
      assert.deepEqual(Buffer.from(await x.arrayBuffer()), Buffer.from(await y.arrayBuffer()));
    }
    // Ana alone hosts it, and nobody else is on it.
    assert.deepEqual(copy.hosts.map((h) => [h.person.id, h.role]), [[P.ana.id, 'creator']]);
    assert.deepEqual([copy.counts.going, copy.counts.maybe, copy.counts.invited, copy.counts.waitlisted], [0, 0, 0, 0]);
    assert.equal((await ana.get(`/api/v1/events/${copy.id}/guests`)).data.guests.length, 0);
    assert.equal((await ana.get(`/api/v1/events/${copy.id}/guests?status=invited`)).data.guests.length, 0);
    assert.deepEqual(copy.hostLists, []);
    const wall = (await ana.get(`/api/v1/events/${copy.id}/wall`)).data.entries;
    assert.ok(!wall.some((w) => w.type === 'post'), 'no posts');
    // Nobody was told: the original's guests and its list's members have
    // no invitation to it.
    for (const who of [ben, una, client(server, 'dee'), cy]) {
      assert.ok(!(await who.get('/api/v1/me/events/all')).data.events.some((e) => e.id === copy.id));
    }
    // The original is as it was.
    const after = (await ana.get(`/api/v1/events/${src.id}`)).data.event;
    assert.equal(after.coverImageUrl, source.coverImageUrl);
    assert.equal(after.counts.going, 1);
  });

  await t.test("the copy's cover is independent: removing the original's leaves it, and the reverse", async () => {
    const del = await ana.del(`/api/v1/events/${src.id}/cover`);
    assert.equal(del.status, 200);
    assert.ok(!fs.existsSync(path.join(server.dataDir, 'covers', `${src.id}.jpg`)));
    for (const c of copy.coverImages) assert.equal((await fetchCover(c.url)).status, 200, c.url);
    for (const c of source.coverImages) assert.equal((await fetchCover(c.url)).status, 404, c.url);
    // Deleting the original altogether doesn't touch it either.
    const second = await ana.post('/api/v1/events', { ...draft, coverFrom: copy.id, startsAt: '2030-02-01T00:00:00Z' });
    assert.equal(second.status, 201, second.text);
    assert.equal((await ana.del(`/api/v1/events/${copy.id}`)).status, 200);
    for (const c of second.data.event.coverImages) assert.equal((await fetchCover(c.url)).status, 200, c.url);
  });

  await t.test('coverFrom: an event you host with a cover, or nothing is made', async () => {
    const before = (await ana.get('/api/v1/me/events/hosting')).data.events.length;
    const body = { title: 'X', startsAt: '2030-01-01T20:00:00Z', timeZone: 'UTC' };
    const gone = await ana.post('/api/v1/events', { ...body, coverFrom: src.id });
    assert.deepEqual([gone.status, gone.data.reason], [400, 'no_cover'], 'its cover was removed above');
    for (const bad of ['AAAAAAAAAAAA', 'nope', 12, true, {}]) {
      const r = await ana.post('/api/v1/events', { ...body, coverFrom: bad });
      assert.deepEqual([r.status, r.data.reason], [400, 'bad_cover_from'], JSON.stringify(bad));
    }
    assert.equal((await ana.get('/api/v1/me/events/hosting')).data.events.length, before);
    // null, like leaving it out, is no cover.
    const none = await ana.post('/api/v1/events', { ...body, coverFrom: null });
    assert.equal(none.status, 201);
    assert.equal(none.data.event.coverImageUrl, null);
    // No cover, no coverFrom in the draft.
    assert.equal((await ana.get(`/api/v1/events/${src.id}/duplicate-draft`)).data.draft.coverFrom, null);
  });

  await t.test('the web: Duplicate in the host menu, for hosts only', async () => {
    const menu = (html) => {
      const m = /<div class="menu" id="hostMenu"[\s\S]*?<\/div>/.exec(html);
      return m ? m[0] : '';
    };
    const asHost = await page(server, ana, `/e/${src.id}`);
    assert.match(menu(asHost.text), /data-action="duplicate">Duplicate</);
    const asCohost = await page(server, cy, `/e/${src.id}`);
    assert.match(menu(asCohost.text), /data-action="duplicate">Duplicate</);
    for (const who of [ben, una, anon]) {
      const r = await page(server, who, `/e/${src.id}`);
      assert.ok(!r.text.includes('data-action="duplicate"'), who.person ? who.person.name : 'signed out');
    }
    // Drawn the same in the browser: only for a verified host.
    const e = (await ana.get(`/api/v1/events/${src.id}`)).data.event;
    assert.match(UI.hostSection(e, 'upcoming', { me: { id: P.ana.id, emailVerified: true } }), /data-action="duplicate"/);
    assert.doesNotMatch(UI.hostSection(e, 'upcoming', { me: { id: P.ana.id, emailVerified: false } }), /data-action="duplicate"/);
  });

  await t.test('the web: /new?from=<id> is the new-event editor, filled in, with no date or times', async () => {
    const withCover = await makeEvent(ana, { title: 'Week 2', timeZone: 'Europe/London', details: DETAILS.slice(0, 2), themeHue: 20 });
    await ana.upload('PUT', `/api/v1/events/${withCover.id}/cover`, await photo(), { type: 'image/jpeg' });
    const r = await page(server, ana, `/new?from=${withCover.id}`);
    assert.equal(r.status, 200);
    const d = pageData(r.text);
    assert.equal(d.event, null, 'a new event');
    assert.equal(d.draft.title, 'Week 2');
    assert.equal(d.draft.coverFrom, withCover.id);
    assert.match(r.text, /<textarea id="title"[^>]*>Week 2<\/textarea>/);
    assert.match(r.text, /id="startDate" value=""/);
    assert.match(r.text, /id="startTime" value=""/);
    assert.match(r.text, /id="endsAt" value=""/);
    assert.match(r.text, /<input type="hidden" id="timeZone" value="Europe\/London">/);
    assert.match(r.text, /id="coverPreview" src="[^"]*\/covers\//);
    const body = r.text.slice(r.text.indexOf('<body class='), r.text.indexOf('id="pageData"'));
    assert.match(body, />Create event</);
    assert.ok(!body.includes('>Back</a>'));
    // Drawn in its colour.
    assert.match(r.text, /<html lang="en" style="/);
    // Not a host, a wrong id, signed out, unverified.
    const guest = await page(server, ben, `/new?from=${src.id}`);
    assert.equal(guest.status, 403);
    assert.match(guest.text, /Only a host can duplicate this event\./);
    assert.equal((await page(server, ana, '/new?from=AAAAAAAAAAAA')).status, 404);
    assert.equal((await page(server, ana, '/new?from=../../x')).status, 404);
    assert.equal((await page(server, anon, `/new?from=${src.id}`)).status, 302);
    assert.equal((await page(server, una, `/new?from=${src.id}`)).status, 403);
    // Just looking makes nothing.
    assert.ok(!(await ana.get('/api/v1/me/events/hosting')).data.events.some((e) => e.title === 'Week 2' && e.id !== withCover.id));
  });
});
