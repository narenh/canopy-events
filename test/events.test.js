// Events end to end against the real server: making one (verified people
// only), what each kind of caller sees of it, editing and cancelling (hosts
// only), what's refused and why, and the limit on making them.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, eventBody, makeEvent, counts } = require('./harness');

test('events', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const ana = client(server, 'ana');
  const ben = client(server, 'ben');
  const una = client(server, 'una');
  const anon = client(server, null);
  let event;

  await t.test('a verified person makes an event, and hosts it', async () => {
    const r = await ana.post('/api/v1/events', eventBody({
      title: '  Rooftop\n dinner ', endsAt: new Date(Date.now() + 8 * 24 * 3600e3).toISOString(), guestListVisibility: 'responded'
    }));
    assert.equal(r.status, 201, r.text);
    event = r.data.event;
    assert.match(event.id, /^[0-9A-Za-z]{12}$/);
    assert.equal(event.url, `${server.base}/e/${event.id}`);
    assert.equal(event.title, 'Rooftop dinner');
    assert.equal(event.status, 'active');
    assert.equal(event.guestListVisibility, 'responded');
    assert.equal(event.timeZone, 'America/Los_Angeles');
    assert.match(event.startsAt, /Z$/);
    assert.deepEqual(event.hosts.map((h) => [h.person.id, h.role]), [[server.people.ana.id, 'creator']]);
    assert.deepEqual(event.viewer, { role: 'creator', rsvp: null, canEdit: true, canSeeGuestList: true, canPost: true });
    assert.deepEqual(event.counts, counts());
    assert.equal(event.guestsAllowed, 0);
  });

  await t.test('an unverified person can not make one, and is told where to verify', async () => {
    const r = await una.post('/api/v1/events', eventBody());
    assert.equal(r.status, 403);
    assert.equal(r.data.reason, 'email_unverified');
    assert.ok(r.data.verify.startsWith(`${server.fake.base}/profile?verify=1&return=`), r.data.verify);
  });

  await t.test('signed out: a 401 with where to sign in or quick-sign-up', async () => {
    const r = await anon.post('/api/v1/events', eventBody());
    assert.equal(r.status, 401);
    assert.equal(r.data.reason, 'sign_in_required');
    assert.ok(r.data.signIn.startsWith(`${server.fake.base}/?return=`));
    assert.ok(r.data.quickSignUp.startsWith(`${server.fake.base}/?quick=1&return=`));
  });

  await t.test('signed out, anyone with the link sees the public details', async () => {
    const r = await anon.get(`/api/v1/events/${event.id}`);
    assert.equal(r.status, 200);
    const e = r.data.event;
    assert.equal(e.title, 'Rooftop dinner');
    assert.equal(e.locationName, "Ana's place");
    assert.equal(e.locationAddress, null, 'no street address for a link preview');
    assert.equal(e.locationAddressHidden, true);
    assert.equal(e.viewer, null);
    assert.equal(e.friendsGoing, undefined);
    assert.equal(e.hosts[0].person.firstName, 'Ana');
    assert.ok(e.counts);
  });

  await t.test('signed in, anyone sees the address and their own part', async () => {
    const e = (await ben.get(`/api/v1/events/${event.id}`)).data.event;
    assert.equal(e.locationAddress, '1 Market St, San Francisco');
    assert.equal(e.locationAddressHidden, false);
    assert.deepEqual(e.viewer, { role: null, rsvp: null, canEdit: false, canSeeGuestList: false, canPost: false });
    assert.deepEqual(e.friendsGoing, { count: 0, people: [] });
    // Unverified people see the same.
    assert.equal((await una.get(`/api/v1/events/${event.id}`)).data.event.locationAddress, '1 Market St, San Francisco');
  });

  await t.test('an unknown or malformed id is a 404', async () => {
    for (const id of ['AAAAAAAAAAAA', 'short', 'has-a-dash-1']) {
      const r = await ben.get(`/api/v1/events/${id}`);
      assert.equal(r.status, 404, id);
      assert.equal(r.data.reason, 'event_not_found');
    }
  });

  await t.test('what a new event needs, and what it refuses', async () => {
    const cases = [
      [{ title: '' }, 'bad_title'],
      [{ title: 42 }, 'bad_title'],
      [{ startsAt: '2026-10-31T20:00' }, 'bad_starts_at'],
      [{ startsAt: 'tomorrow' }, 'bad_starts_at'],
      [{ startsAt: undefined }, 'bad_starts_at'],
      [{ timeZone: 'Mars/Olympus_Mons' }, 'bad_time_zone'],
      [{ timeZone: undefined }, 'bad_time_zone'],
      [{ endsAt: '2000-01-01T00:00:00Z' }, 'ends_before_start'],
      [{ guestListVisibility: 'friends' }, 'bad_guest_list_visibility'],
      [{ description: ['x'] }, 'bad_description']
    ];
    for (const [overrides, reason] of cases) {
      const r = await ana.post('/api/v1/events', eventBody(overrides));
      assert.equal(r.status, 400, JSON.stringify(overrides));
      assert.equal(r.data.reason, reason, JSON.stringify(overrides));
      assert.ok(r.data.error);
    }
    // Optional fields can be left out entirely, and unknown ones are ignored.
    const bare = await ana.post('/api/v1/events', {
      title: 'Bare', startsAt: '2030-05-01T19:00:00-07:00', timeZone: 'UTC', status: 'cancelled', somethingNew: 1
    });
    assert.equal(bare.status, 201, bare.text);
    assert.equal(bare.data.event.startsAt, '2030-05-02T02:00:00.000Z');
    assert.equal(bare.data.event.status, 'active');
    assert.equal(bare.data.event.description, null);
    assert.equal(bare.data.event.guestListVisibility, 'everyone');
  });

  await t.test('a host edits; nobody else can', async () => {
    const no = await ben.patch(`/api/v1/events/${event.id}`, { title: 'Mine now' });
    assert.equal(no.status, 403);
    assert.equal(no.data.reason, 'hosts_only');
    assert.equal((await anon.patch(`/api/v1/events/${event.id}`, { title: 'x' })).status, 401);

    const r = await ana.patch(`/api/v1/events/${event.id}`, { title: 'Rooftop dinner, moved', endsAt: null, locationAddress: '' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.event.title, 'Rooftop dinner, moved');
    assert.equal(r.data.event.endsAt, null);
    assert.equal(r.data.event.locationAddress, null);
    // Left out is left alone.
    assert.equal(r.data.event.description, 'Bring a jacket.');
    assert.equal(r.data.event.guestListVisibility, 'responded');
    // The end still has to come after the start, counting what's stored.
    const bad = await ana.patch(`/api/v1/events/${event.id}`, { endsAt: '2001-01-01T00:00:00Z' });
    assert.equal(bad.data.reason, 'ends_before_start');
  });

  await t.test('cancelling is an edit, and so is taking it back', async () => {
    const r = await ana.patch(`/api/v1/events/${event.id}`, { status: 'cancelled' });
    assert.equal(r.data.event.status, 'cancelled');
    assert.ok(r.data.event.cancelledAt);
    assert.equal((await ben.get(`/api/v1/events/${event.id}`)).data.event.status, 'cancelled');
    const back = await ana.patch(`/api/v1/events/${event.id}`, { status: 'active' });
    assert.equal(back.data.event.status, 'active');
    assert.equal(back.data.event.cancelledAt, null);
    assert.equal((await ana.patch(`/api/v1/events/${event.id}`, { status: 'deleted' })).data.reason, 'bad_status');
  });

  await t.test('a body that is not JSON is a 400, and an unknown endpoint a 404', async () => {
    const r = await ana.post('/api/v1/events', '{"title": ');
    assert.equal(r.status, 400);
    assert.equal(r.data.reason, 'bad_json');
    const missing = await ana.get('/api/v1/nothing-here');
    assert.equal(missing.status, 404);
    assert.equal(missing.data.reason, 'not_found');
  });

  await t.test('headers: no framing, no sniffing, no full Referer, and no caching of API answers', async () => {
    const r = await ben.get(`/api/v1/events/${event.id}`);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('referrer-policy'), 'same-origin');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('x-powered-by'), null);
    const health = await fetch(server.base + '/healthz');
    assert.deepEqual(await health.json(), { ok: true });
    assert.equal(health.headers.get('x-frame-options'), 'DENY');
    assert.equal((await fetch(server.base + '/favicon.ico')).status, 204);
  });

  await t.test('20 new events per person a day', async () => {
    const fay = client(server, 'fay');
    for (let i = 0; i < 20; i++) await makeEvent(fay, { title: `Party ${i}` });
    const r = await fay.post('/api/v1/events', eventBody());
    assert.equal(r.status, 429);
    assert.equal(r.data.reason, 'rate_limited');
    // Someone else isn't affected.
    assert.equal((await ben.post('/api/v1/events', eventBody())).status, 201);
  });
});

// Its own server, since answers are cached by token for a minute.
test('on a site key without quick accounts: verified people as before, unverified sent to verify', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  // The account service then says nothing about emailVerified, and
  // answers {person: null, unverified: true} for a quick account.
  server.fake.allowsUnverified = false;
  const cy = client(server, 'cy');
  assert.equal((await cy.get('/api/v1/me')).data.person.emailVerified, true);
  assert.equal((await cy.post('/api/v1/events', eventBody())).status, 201);
  const quick = client(server, 'una', { mode: 'bearer' });
  const r = await quick.get('/api/v1/me');
  assert.equal(r.status, 403);
  assert.equal(r.data.reason, 'email_unverified');
  assert.ok(r.data.verify.startsWith(`${server.fake.base}/profile?verify=1&return=`));
});
