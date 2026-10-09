// Places (lib/places.js, routes/places.js) and an event's pin: signing in
// to Apple Maps (the JWT, the access token, kept and renewed), the
// suggestions and a place, against a fake Apple (test/fakeAppleMaps.js),
// with places off, an event's coordinates (made, edited, refused, and
// never shown to anyone who can't see the address), typed text, and the
// Location field and directions as public/ui.js draws them.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { startServer, client, makeEvent } = require('./harness');
const { startFakeAppleMaps, verifyJwt, makeKey, completionUrl, PLACES, TEAM_ID, KEY_ID } = require('./fakeAppleMaps');
const { createPlaces, settingsFrom, signJwt, readPrivateKey, parseNear, langFrom, DEFAULT_NEAR } = require('../lib/places');
const UI = require('../public/ui.js');

const quiet = { warn() {}, log() {} };
const idOf = (p) => Buffer.from(completionUrl(p)).toString('base64url');

async function page(server, who, url, headers = {}) {
  const h = { Accept: 'text/html', ...headers };
  if (who && who.person) h.Cookie = `canopy_session=${who.person.token}`;
  const res = await fetch(server.base + url, { headers: h, redirect: 'manual' });
  return { status: res.status, body: await res.text() };
}

test('the JWT Apple trades: ES256 over the header and claims, signed with the key', () => {
  const { pem, publicKey } = makeKey();
  const key = readPrivateKey(pem);
  const at = Date.UTC(2026, 9, 8, 12, 0, 0);
  const jwt = signJwt({ teamId: TEAM_ID, keyId: KEY_ID, key }, at);
  const [h, c, sig] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'ES256', kid: KEY_ID, typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(c, 'base64url'));
  // Seconds, not milliseconds; the scope Apple's docs give for the
  // Server API; no origin (not a browser's token).
  assert.deepEqual(claims, { iss: TEAM_ID, iat: at / 1000, exp: at / 1000 + 1800, scope: 'server_api' });
  // r || s, 64 bytes, as JWS has it (not DER), and it verifies with the
  // public half.
  assert.equal(Buffer.from(sig, 'base64url').length, 64);
  assert.ok(verifyJwt(jwt, publicKey));
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
  // Anything changed doesn't.
  assert.equal(verifyJwt(`${h}.${Buffer.from(JSON.stringify({ ...claims, iss: 'SOMEONEELS' })).toString('base64url')}.${sig}`, publicKey), null);
  assert.equal(verifyJwt(jwt, makeKey().publicKey), null);
});

test('the key reads as Coolify gives it: real line breaks, "\\n" escapes, or a bare body', () => {
  const { pem } = makeKey();
  assert.ok(readPrivateKey(pem));
  assert.ok(readPrivateKey(pem.trim().replace(/\n/g, '\\n')));
  const body = pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  assert.ok(readPrivateKey(body));
  assert.equal(readPrivateKey('not a key'), null);
  assert.equal(readPrivateKey(''), null);
  // An RSA key isn't a Maps key.
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.equal(readPrivateKey(rsa), null);
});

test('places are off without all three settings, and nothing is asked', async () => {
  const { pem } = makeKey();
  let asked = 0;
  const fetchImpl = async () => { asked++; throw new Error('no'); };
  for (const env of [{}, { APPLE_MAPS_TEAM_ID: TEAM_ID, APPLE_MAPS_KEY_ID: KEY_ID }, { APPLE_MAPS_KEY_ID: KEY_ID, APPLE_MAPS_PRIVATE_KEY: pem },
    { APPLE_MAPS_TEAM_ID: TEAM_ID, APPLE_MAPS_KEY_ID: KEY_ID, APPLE_MAPS_PRIVATE_KEY: 'garbage' }]) {
    const places = createPlaces({ ...settingsFrom(env), fetchImpl, log: quiet });
    assert.equal(places.enabled, false, JSON.stringify(Object.keys(env)));
    assert.equal(await places.autocomplete('dolores'), null);
  }
  assert.equal(asked, 0);
  assert.equal(createPlaces({ ...settingsFrom({ APPLE_MAPS_TEAM_ID: TEAM_ID, APPLE_MAPS_KEY_ID: KEY_ID, APPLE_MAPS_PRIVATE_KEY: pem }), log: quiet }).enabled, true);
  // The other settings' defaults.
  assert.equal(settingsFrom({}).url, 'https://maps-api.apple.com');
  assert.deepEqual(settingsFrom({}).defaultNear, DEFAULT_NEAR);
  assert.deepEqual(settingsFrom({ PLACES_DEFAULT_NEAR: '40.7128,-74.006' }).defaultNear, { lat: 40.7128, lng: -74.006 });
  assert.deepEqual(settingsFrom({ PLACES_DEFAULT_NEAR: 'nowhere' }).defaultNear, DEFAULT_NEAR);
});

test('near and Accept-Language', () => {
  assert.deepEqual(parseNear('37.7,-122.4'), { lat: 37.7, lng: -122.4 });
  assert.deepEqual(parseNear(' -33.86 , 151.2 '), { lat: -33.86, lng: 151.2 });
  for (const bad of ['', '91,0', '0,181', 'a,b', '1,2,3', '37.7']) assert.equal(parseNear(bad), null, bad);
  assert.equal(langFrom('fr-CA,fr;q=0.9,en;q=0.8'), 'fr-CA');
  assert.equal(langFrom('*'), 'en-US');
  assert.equal(langFrom(''), 'en-US');
  assert.equal(langFrom('<script>, de'), 'de');
});

test('the access token is kept, renewed before it runs out, and on a 401', async (t) => {
  const fake = await startFakeAppleMaps();
  t.after(() => fake.close());
  const places = createPlaces({ ...settingsFrom(fake.env()), log: quiet });
  assert.ok(places.enabled);

  assert.equal((await places.autocomplete('dolores')).length, 8);
  assert.equal((await places.autocomplete('park')).length > 0, true);
  assert.equal(fake.of('/v1/token').length, 1, 'one trade for both');
  // Each call with the access token, never the JWT.
  const token = fake.of('/v1/searchAutocomplete')[0].authorization;
  assert.match(token, /^Bearer apple_access_1_/);
  assert.ok(fake.of('/v1/searchAutocomplete').every((r) => r.authorization === token));

  // Apple stops taking it (it expired early, say): a 401, a new one, and
  // the same call again, which works.
  fake.valid.clear();
  assert.equal((await places.autocomplete('valencia')).length > 0, true);
  assert.equal(fake.of('/v1/token').length, 2);
  assert.match(fake.of('/v1/searchAutocomplete').at(-1).authorization, /^Bearer apple_access_2_/);

  // A token that's about to run out is traded before it's used.
  fake.expiresInSeconds = 30;
  fake.valid.clear();
  await places.autocomplete('market one');
  const trades = fake.of('/v1/token').length;
  await places.autocomplete('market two');
  assert.equal(fake.of('/v1/token').length, trades + 1, 'under a minute left: a new one');

  // Every JWT was a good one.
  assert.ok(fake.jwts.every((j) => j.claims.iss === TEAM_ID && j.header.kid === KEY_ID));
  // Apple refusing the trade itself: no suggestions, and no throw.
  fake.valid.clear();
  const broken = createPlaces({ ...settingsFrom(fake.env({ APPLE_MAPS_KEY_ID: 'WRONGKEYID' })), log: quiet });
  assert.equal(await broken.autocomplete('dolores'), null);
});

test('the API: suggestions, a place, the limit, and Apple down', async (t) => {
  const fake = await startFakeAppleMaps();
  const server = await startServer(fake.env());
  t.after(async () => { await server.stop(); await fake.close(); });
  const ana = client(server, 'ana');
  const ben = client(server, 'ben');
  const una = client(server, 'una');
  const anon = client(server, null);
  const auto = (who, q, opts) => who.get(`/api/v1/places/autocomplete?q=${encodeURIComponent(q)}`, opts);

  await t.test('suggestions: named places and addresses, at most 8, searches left out, no repeats', async () => {
    const r = await auto(ana, 'dolores');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.enabled, true);
    assert.equal(r.data.results.length, 8);
    const [park, services, street] = r.data.results;
    assert.deepEqual({ ...park, id: undefined }, { id: undefined, name: 'Dolores Park', address: '19th St & Dolores St, San Francisco, CA 94114, United States', kind: 'poi' });
    assert.equal(services.kind, 'poi');
    assert.deepEqual({ name: street.name, address: street.address, kind: street.kind }, { name: '1 Dolores St', address: 'San Francisco, CA 94103, United States', kind: 'address' });
    assert.equal(new Set(r.data.results.map((x) => x.id)).size, 8, 'no repeats');
    assert.ok(!r.data.results.some((x) => x.address === 'Search Nearby'), 'a search suggestion has no place');
    assert.ok(!r.text.includes('completionUrl') && !r.text.includes('metadata'));
  });

  await t.test('biased to San Francisco, or near; in the Accept-Language', async () => {
    await auto(ana, 'valencia', { headers: { 'Accept-Language': 'es-MX,es;q=0.9' } });
    let q = fake.of('/v1/searchAutocomplete').at(-1).query;
    assert.deepEqual(q, { q: 'valencia', searchLocation: '37.77,-122.42', lang: 'es-MX' });
    await ana.get('/api/v1/places/autocomplete?q=valencia&near=40.712776,-74.005974');
    q = fake.of('/v1/searchAutocomplete').at(-1).query;
    assert.equal(q.searchLocation, '40.71,-74.01', 'two decimals: about a kilometer');
    assert.equal(q.lang, 'en-US');
    const bad = await ana.get('/api/v1/places/autocomplete?q=valencia&near=up');
    assert.equal(bad.status, 400);
    assert.equal(bad.data.reason, 'bad_near');
  });

  await t.test('the same question again is answered from memory', async () => {
    const before = fake.of('/v1/searchAutocomplete').length;
    await auto(ana, 'Dolores  PARK');
    await auto(ben, 'dolores park');
    assert.equal(fake.of('/v1/searchAutocomplete').length, before + 1);
    // Under 2 characters: nothing, and Apple isn't asked.
    const short = await auto(ana, 'd');
    assert.deepEqual(short.data, { enabled: true, results: [] });
    assert.equal(fake.of('/v1/searchAutocomplete').length, before + 1);
  });

  await t.test('who may ask: people who can host', async () => {
    assert.equal((await auto(anon, 'dolores')).status, 401);
    const quick = await auto(una, 'dolores');
    assert.equal(quick.status, 403);
    assert.equal(quick.data.reason, 'email_unverified');
    assert.equal((await client(server, 'ben', { mode: 'bearer' }).get('/api/v1/places/autocomplete?q=dolores')).status, 200, 'the apps too');
  });

  await t.test('a place, whole', async () => {
    const list = (await auto(ana, 'dolores')).data.results;
    const r = await ana.get(`/api/v1/places/${list[0].id}`);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.data.place, {
      name: 'Dolores Park',
      address: '19th St & Dolores St, San Francisco, CA 94114, United States',
      addressLines: ['19th St & Dolores St', 'San Francisco, CA 94114', 'United States'],
      lat: 37.759773,
      lng: -122.427063,
      applePlaceId: 'I5B8A0D4E1F2C3B7A',
      kind: 'poi'
    });
    const street = (await ana.get(`/api/v1/places/${list[2].id}`)).data.place;
    assert.equal(street.kind, 'address');
    assert.equal(street.applePlaceId, null);
    // Apple was asked with the completion's own q and metadata.
    const asked = fake.of('/v1/search').at(-1).query;
    assert.equal(asked.metadata, Buffer.from('1 Dolores St').toString('base64'));
    assert.equal(asked.lang, 'en-US');
    // Asked again: from memory.
    const n = fake.of('/v1/search').length;
    await ben.get(`/api/v1/places/${list[2].id}`);
    assert.equal(fake.of('/v1/search').length, n);
  });

  await t.test('an id that is not a suggestion is a 404, and goes nowhere', async () => {
    const n = fake.requests.length;
    for (const url of ['/v1/token', 'https://evil.example/v1/search?q=x', '//evil.example/v1/search?q=x', '/v1/search', '/v1/searchAutocomplete?q=x']) {
      const r = await ana.get(`/api/v1/places/${Buffer.from(url).toString('base64url')}`);
      assert.equal(r.status, 404, url);
      assert.equal(r.data.reason, 'place_not_found');
    }
    assert.equal((await ana.get('/api/v1/places/not!base64')).status, 404);
    assert.equal(fake.requests.length, n, 'Apple was never asked');
    // A real-looking one Apple has nothing for.
    const nothing = await ana.get(`/api/v1/places/${idOf({ name: 'Nowhere', lines: ['Nowhere'] })}`);
    assert.equal(nothing.status, 404);
  });

  await t.test('Apple down: 502 places_unavailable, and the logs never say what was typed', async () => {
    fake.down = true;
    const r = await auto(ana, 'secret party spot');
    assert.equal(r.status, 502);
    assert.equal(r.data.reason, 'places_unavailable');
    assert.equal((await ana.get(`/api/v1/places/${idOf(PLACES[1])}`)).status, 502);
    fake.down = false;
    // An error from Apple on one question.
    assert.equal((await auto(ana, 'boom')).status, 502);
    assert.ok(server.output().includes('places: Apple Maps answered'));
    assert.ok(!server.output().includes('secret party spot') && !server.output().includes('boom'));
    assert.ok(!server.output().includes(server.people.ana.id));
  });

  await t.test('120 a minute per person, the two together', async () => {
    const fay = client(server, 'fay');
    let last;
    for (let i = 0; i < 120; i++) {
      last = i % 2 ? await auto(fay, 'dolores') : await fay.get(`/api/v1/places/${idOf(PLACES[0])}`);
      assert.equal(last.status, 200, `${i}: ${last.text}`);
    }
    last = await auto(fay, 'dolores');
    assert.equal(last.status, 429);
    assert.equal(last.data.reason, 'rate_limited');
    assert.equal((await auto(ana, 'dolores')).status, 200, 'someone else is fine');
  });

  await t.test('the editor: a combobox, for a verified host', async () => {
    const html = (await page(server, ana, '/new')).body;
    assert.match(html, /<input type="text" id="location" class="soft place-input" maxlength="500" placeholder="Place or address" value="" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="locationList" aria-haspopup="listbox">/);
    assert.match(html, /<ul class="place-list" id="locationList" role="listbox" aria-label="Places" hidden><\/ul>/);
    assert.ok(html.includes('<label class="sr-only" for="location">Location</label>'));
  });
});

test('places off: no suggestions, no errors, a plain field', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const ana = client(server, 'ana');
  const r = await ana.get('/api/v1/places/autocomplete?q=dolores');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { enabled: false, results: [] });
  const p = await ana.get(`/api/v1/places/${idOf(PLACES[0])}`);
  assert.equal(p.status, 502);
  assert.equal(p.data.reason, 'places_unavailable');
  const html = (await page(server, ana, '/new')).body;
  // The form as drawn (the page also carries ui.js itself).
  const form = html.slice(html.indexOf('<form class="stack editor"'), html.indexOf('</form>'));
  assert.ok(form.includes('id="location"') && !form.includes('role="combobox"') && !form.includes('id="locationList"'));
  assert.ok(server.output().includes('Apple Maps off: missing APPLE_MAPS_TEAM_ID, APPLE_MAPS_KEY_ID, APPLE_MAPS_PRIVATE_KEY.'));
});

test('the startup log says why Apple Maps is off, never the key', async (t) => {
  const server = await startServer({ APPLE_MAPS_TEAM_ID: 'TEAM123456', APPLE_MAPS_KEY_ID: 'KEY1234567', APPLE_MAPS_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nnotakeyatallsecretish\\n' });
  t.after(() => server.stop());
  const out = server.output();
  assert.match(out, /Apple Maps off: the private key didn't read \(\d+ characters, 3 lines, has BEGIN line, no END line\)/);
  assert.ok(!out.includes('notakeyatallsecretish'));
});

test("an event's pin: made, edited, refused, and as private as the address", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const P = server.people;
  const ana = client(server, 'ana');
  const ben = client(server, 'ben');
  const anon = client(server, null);
  const pin = { locationName: 'Dolores Park', locationAddress: '19th St & Dolores St, San Francisco, CA 94114', latitude: 37.7597727, longitude: -122.4270634, applePlaceId: 'I5B8A0D4E1F2C3B7A' };
  let e;

  await t.test('made with a pin, kept to 6 decimals', async () => {
    e = await makeEvent(ana, pin);
    assert.deepEqual([e.locationName, e.locationAddress, e.latitude, e.longitude, e.applePlaceId],
      ['Dolores Park', pin.locationAddress, 37.759773, -122.427063, 'I5B8A0D4E1F2C3B7A']);
    const plain = await makeEvent(ana);
    assert.deepEqual([plain.latitude, plain.longitude, plain.applePlaceId], [null, null, null]);
  });

  await t.test('only people who see the address see it', async () => {
    const out = (await anon.get(`/api/v1/events/${e.id}`)).data.event;
    assert.equal(out.locationName, 'Dolores Park', 'the name is public');
    assert.deepEqual([out.locationAddress, out.latitude, out.longitude, out.applePlaceId, out.locationAddressHidden], [null, null, null, null, true]);
    const seen = (await ben.get(`/api/v1/events/${e.id}`)).data.event;
    assert.deepEqual([seen.latitude, seen.longitude, seen.applePlaceId], [37.759773, -122.427063, 'I5B8A0D4E1F2C3B7A']);
    // Removed: what someone signed out sees.
    await ben.put(`/api/v1/events/${e.id}/rsvp`, { status: 'going' });
    await ana.put(`/api/v1/events/${e.id}/removed/${P.ben.id}`);
    const removed = await ben.get(`/api/v1/events/${e.id}`);
    assert.deepEqual([removed.data.event.latitude, removed.data.event.applePlaceId, removed.data.event.locationAddressHidden], [null, null, true]);
    assert.ok(!removed.text.includes('37.75') && !removed.text.includes('I5B8A0D4E1F2C3B7A'));
    await ana.del(`/api/v1/events/${e.id}/removed/${P.ben.id}`);
    // Nor anywhere on the signed-out page (or in its embedded data).
    const html = (await page(server, anon, `/e/${e.id}`)).body;
    assert.ok(!html.includes('37.75') && !html.includes('-122.42') && !html.includes('I5B8A0D4E1F2C3B7A') && !html.includes('19th St'));
    // A pin with no address is still hidden, and says there's more.
    const pinOnly = await makeEvent(ana, { locationName: 'The roof', locationAddress: null, latitude: 37.8, longitude: -122.4 });
    const pinOut = (await anon.get(`/api/v1/events/${pinOnly.id}`)).data.event;
    assert.deepEqual([pinOut.latitude, pinOut.locationAddressHidden], [null, true]);
  });

  await t.test('edits: kept when the place stays, cleared when it moves', async () => {
    let r = await ana.patch(`/api/v1/events/${e.id}`, { description: 'Bring a blanket' });
    assert.equal(r.data.event.latitude, 37.759773, 'another field: the pin stays');
    r = await ana.patch(`/api/v1/events/${e.id}`, { locationName: 'Dolores Park', locationAddress: pin.locationAddress });
    assert.equal(r.data.event.latitude, 37.759773, 'the same place sent again: it stays');
    // An app from before pins changes the address: the old pin goes.
    r = await ana.patch(`/api/v1/events/${e.id}`, { locationAddress: '500 Castro St, San Francisco' });
    assert.deepEqual([r.data.event.latitude, r.data.event.longitude, r.data.event.applePlaceId], [null, null, null]);
    r = await ana.patch(`/api/v1/events/${e.id}`, pin);
    assert.equal(r.data.event.applePlaceId, 'I5B8A0D4E1F2C3B7A');
    r = await ana.patch(`/api/v1/events/${e.id}`, { latitude: null, longitude: null, applePlaceId: null });
    assert.deepEqual([r.data.event.latitude, r.data.event.applePlaceId, r.data.event.locationName], [null, null, 'Dolores Park']);
    // No place at all: no pin either.
    await ana.patch(`/api/v1/events/${e.id}`, pin);
    r = await ana.patch(`/api/v1/events/${e.id}`, { locationName: null, locationAddress: null });
    assert.deepEqual([r.data.event.latitude, r.data.event.applePlaceId], [null, null]);
  });

  await t.test('refused: half a pin, out of range, not numbers, a bad id, a pin with no place', async () => {
    const cases = [
      [{ latitude: 37.7 }, 'bad_coordinates'],
      [{ longitude: -122.4 }, 'bad_coordinates'],
      [{ latitude: 91, longitude: 0 }, 'bad_coordinates'],
      [{ latitude: 0, longitude: -180.5 }, 'bad_coordinates'],
      [{ latitude: '37.7', longitude: '-122.4' }, 'bad_coordinates'],
      [{ latitude: null, longitude: 3 }, 'bad_coordinates'],
      [{ applePlaceId: 'has spaces' }, 'bad_apple_place_id'],
      [{ applePlaceId: 'x'.repeat(129) }, 'bad_apple_place_id'],
      [{ applePlaceId: 42 }, 'bad_apple_place_id'],
      [{ locationName: null, locationAddress: null, latitude: 37.7, longitude: -122.4 }, 'bad_coordinates'],
      [{ locationName: null, locationAddress: null, applePlaceId: 'I1' }, 'bad_coordinates']
    ];
    for (const [body, reason] of cases) {
      const r = await ana.post('/api/v1/events', { title: 'x', startsAt: '2030-01-01T20:00:00Z', timeZone: 'UTC', locationName: 'Somewhere', ...body });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.data.reason, reason, JSON.stringify(body));
      const p = await ana.patch(`/api/v1/events/${e.id}`, body);
      assert.equal(p.status, 400, JSON.stringify(body));
    }
  });

  await t.test('a street address sent as the name too is the address: the name goes', async () => {
    const r = await makeEvent(ana, { locationName: '1 Dolores St', locationAddress: '1 Dolores St, San Francisco, CA 94103', latitude: 37.7693, longitude: -122.4264 });
    assert.equal(r.locationName, null);
    assert.equal(r.locationAddress, '1 Dolores St, San Francisco, CA 94103');
    const out = (await anon.get(`/api/v1/events/${r.id}`)).data.event;
    assert.equal(out.locationName, null);
    assert.ok(!JSON.stringify(out).includes('Dolores'));
    // A name that isn't the address is kept.
    const kept = await makeEvent(ana, { locationName: 'The park', locationAddress: 'Dolores Park' });
    assert.equal(kept.locationName, 'The park');
  });

  await t.test('typed text is the address: nothing public', async () => {
    // What the editor sends for typed text (UI.locationFromText).
    const typed = UI.locationFromText('  742 Evergreen   Terrace ');
    assert.deepEqual(typed, { locationName: null, locationAddress: '742 Evergreen Terrace', latitude: null, longitude: null, applePlaceId: null });
    assert.deepEqual(UI.locationFromText('   ').locationAddress, null);
    const ev = await makeEvent(ana, typed);
    const out = await anon.get(`/api/v1/events/${ev.id}`);
    assert.deepEqual([out.data.event.locationName, out.data.event.locationAddress, out.data.event.locationAddressHidden], [null, null, true]);
    assert.ok(!out.text.includes('Evergreen'));
    const html = (await page(server, anon, `/e/${ev.id}`)).body;
    assert.ok(!html.includes('Evergreen') && html.includes('The address shows once you sign in.'));
    assert.ok((await page(server, ben, `/e/${ev.id}`)).body.includes('742 Evergreen Terrace'));
  });

  await t.test('the event page: with a pin, the address is directions in your maps', async () => {
    await ana.patch(`/api/v1/events/${e.id}`, pin);
    const iphone = (await page(server, ben, `/e/${e.id}`, { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' })).body;
    assert.ok(iphone.includes('<a class="sub address directions" href="https://maps.apple.com/?q=Dolores%20Park&amp;ll=37.759773%2C-122.427063" target="_blank" rel="noopener noreferrer">19th St &amp; Dolores St, San Francisco, CA 94114</a>'));
    const android = (await page(server, ben, `/e/${e.id}`, { 'User-Agent': 'Mozilla/5.0 (Linux; Android 15; Pixel 9)' })).body;
    assert.ok(android.includes('href="https://www.google.com/maps/dir/?api=1&amp;destination=37.759773%2C-122.427063"'));
    const card = android.slice(android.indexOf('id="details"'), android.indexOf('</section>', android.indexOf('id="details"')));
    assert.ok(card.includes('directions') && !card.includes('Open in Maps'));
    // No pin: as before, the address and "Open in Maps".
    const plain = await makeEvent(ana);
    const before = (await page(server, ben, `/e/${plain.id}`)).body;
    assert.ok(before.includes('<span class="sub address">1 Market St, San Francisco</span>') && before.includes('>Open in Maps</a>'));
  });

  await t.test('the editor starts from what the event has', async () => {
    const html = (await page(server, ana, `/e/${e.id}/edit`)).body;
    assert.ok(html.includes('id="location" class="soft place-input" maxlength="500" placeholder="Place or address" value="Dolores Park">'));
    assert.ok(html.includes('<div class="place-picked" id="locationPicked"><span class="place-picked-line" id="locationLine">19th St &amp; Dolores St, San Francisco, CA 94114</span>'));
    assert.ok(html.includes('<input type="hidden" id="latitude" value="37.759773">') && html.includes('<input type="hidden" id="applePlaceId" value="I5B8A0D4E1F2C3B7A">'));
  });
});

test('the Location field, its suggestions and directions (public/ui.js)', () => {
  // Use "…" is always first, escaped, then Apple's: a pin for a named
  // place, a house for an address, the address muted under the name.
  const html = UI.placeOptions('  Ana\'s <b>  ', [
    { id: 'a1', name: 'Dolores Park', address: 'San Francisco', kind: 'poi' },
    { id: 'a2', name: '1 Dolores St', address: '', kind: 'address' }
  ], 1);
  const rows = html.match(/<li [^>]*>/g);
  assert.equal(rows.length, 3);
  assert.equal(rows[0], '<li role="option" id="locationOpt-0" class="place-opt place-use" data-index="0" aria-selected="false">');
  assert.equal(rows[1], '<li role="option" id="locationOpt-1" class="place-opt place-poi" data-index="1" aria-selected="true">');
  assert.equal(rows[2], '<li role="option" id="locationOpt-2" class="place-opt place-address" data-index="2" aria-selected="false">');
  assert.ok(html.includes('<span class="place-opt-name">Use “Ana&#39;s &lt;b&gt;”</span>'));
  assert.ok(html.includes('<span class="place-opt-name">Dolores Park</span><span class="place-opt-address">San Francisco</span>'));
  assert.ok(!html.slice(html.indexOf('locationOpt-2')).includes('place-opt-address'), 'no empty address line');
  assert.equal(UI.placeOptions('dol', [], -1).match(/role="option"/g).length, 1, 'with nothing from Apple: Use "…" alone');

  // What a pick saves: a named place's name is public; an address's isn't.
  assert.deepEqual(UI.locationFromPlace({ name: 'Dolores Park', address: '19th St, SF', lat: 37.7, lng: -122.4, applePlaceId: 'I1', kind: 'poi' }),
    { locationName: 'Dolores Park', locationAddress: '19th St, SF', latitude: 37.7, longitude: -122.4, applePlaceId: 'I1' });
  assert.deepEqual(UI.locationFromPlace({ name: '1 Dolores St', address: '1 Dolores St, SF', lat: 37.7, lng: -122.4, applePlaceId: null, kind: 'address' }),
    { locationName: null, locationAddress: '1 Dolores St, SF', latitude: 37.7, longitude: -122.4, applePlaceId: null });

  // Where the field starts.
  assert.deepEqual(UI.locationStart({ locationName: 'Ana\'s', locationAddress: '1 Market St' }), { text: 'Ana\'s', line: '1 Market St' });
  assert.deepEqual(UI.locationStart({ locationName: null, locationAddress: '1 Market St' }), { text: '1 Market St', line: '' });
  assert.deepEqual(UI.locationStart({ locationName: 'The roof', locationAddress: null }), { text: 'The roof', line: '' });
  assert.deepEqual(UI.locationStart(null), { text: '', line: '' });

  // The field, off and on.
  const off = UI.locationField({}, false);
  assert.ok(off.includes('placeholder="Place or address" value="">') && !off.includes('combobox') && !off.includes('listbox'));
  assert.ok(off.includes('<div class="place-picked" id="locationPicked" hidden>'));
  const on = UI.locationField({ locationName: 'X', locationAddress: 'Y' }, true);
  assert.ok(on.includes('role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="locationList"'));
  assert.ok(on.includes('id="locationList" role="listbox"'));
  assert.ok(on.includes('<button type="button" class="place-clear" id="locationClear" aria-label="Clear location" title="Clear location">×</button>'));
  // No help text: the only words are the placeholder and the read-out label.
  assert.ok(!/<p\b|field-hint/.test(on));

  // Directions.
  assert.equal(UI.mapsApp('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'), 'apple');
  assert.equal(UI.mapsApp('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), 'apple');
  assert.equal(UI.mapsApp('Mozilla/5.0 (Linux; Android 15)'), 'google');
  assert.equal(UI.mapsApp('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'google');
  assert.equal(UI.mapsApp(undefined), 'google');
  const ev = { locationName: 'Dolores Park', locationAddress: '19th St', latitude: 37.5, longitude: -122.25 };
  assert.equal(UI.directionsUrl(ev, 'apple'), 'https://maps.apple.com/?q=Dolores%20Park&ll=37.5%2C-122.25');
  assert.equal(UI.directionsUrl(ev, 'google'), 'https://www.google.com/maps/dir/?api=1&destination=37.5%2C-122.25');
  assert.equal(UI.directionsUrl({ ...ev, locationName: null }, 'apple'), 'https://maps.apple.com/?q=19th%20St&ll=37.5%2C-122.25');
  assert.equal(UI.directionsUrl({ ...ev, latitude: null }, 'apple'), null);
});
