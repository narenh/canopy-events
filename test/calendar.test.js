// Events' part of everyone's Canopy calendar: GET /api/calendar/<personId>,
// which only the account service may ask (signed with the calendar
// secret), and which entries go in it for every kind of part someone can
// have in an event. Every answer also goes through the harness's checks:
// the spec, and the leak walker (nobody's contact details, since nobody is
// the caller here).

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, makeEvent, calendarAuth } = require('./harness');

const DAY = 86400e3;

// The account service asking about `who` (a fixture person or an id).
function asAccountService(server, opts = {}) {
  return (who, auth) => {
    const id = typeof who === 'string' ? who : who.id;
    return client(server, null).get(`/api/calendar/${id}`, { headers: { Authorization: auth !== undefined ? auth : calendarAuth(id, opts) } });
  };
}

// Every string anywhere in a JSON value.
function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => strings(v, out));
  return out;
}

test('only the account service, signed, may ask', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const P = server.people;
  const ask = asAccountService(server);
  const ana = client(server, 'ana');
  await makeEvent(ana);
  assert.equal((await ask(P.ana)).status, 200);

  const refused = {
    'no Authorization': '',
    "the site's own key": 'Bearer cnp_test-site-key',
    "a person's token": `Bearer ${P.ana.token}`,
    'the wrong secret': calendarAuth(P.ana.id, { secret: 'cnc_not-it' }),
    "someone else's signature": calendarAuth(P.ben.id),
    'six minutes old': calendarAuth(P.ana.id, { at: Date.now() - 6 * 60e3 }),
    'six minutes ahead': calendarAuth(P.ana.id, { at: Date.now() + 6 * 60e3 }),
    'malformed': 'Canopy-Calendar t=now, sig=nope'
  };
  for (const [what, auth] of Object.entries(refused)) {
    const r = await ask(P.ana, auth);
    assert.equal(r.status, 401, what);
    assert.equal(r.data.reason, 'unauthorized', what);
    assert.ok(!('entries' in r.data), what);
  }
  // Signed in as Ana, with her cookie or her app's token, is still no.
  for (const mode of ['cookie', 'bearer']) {
    const r = await client(server, 'ana', { mode }).get(`/api/calendar/${P.ana.id}`);
    assert.equal(r.status, 401, mode);
  }
  // Four minutes off is within the five allowed.
  assert.equal((await ask(P.ana, calendarAuth(P.ana.id, { at: Date.now() - 4 * 60e3 }))).status, 200);
  // A properly signed request for something that isn't a person id.
  assert.equal((await ask('not-a-person')).data.reason, 'bad_person_id');
  // Someone events has never seen: nothing, not a 404.
  assert.deepEqual((await ask('00000000-0000-4000-8000-000000000999')).data, { entries: [] });
  assert.equal((await ask(P.ana)).headers.get('cache-control'), 'no-store');
});

test('with no calendar secret set, nobody may ask', async (t) => {
  const server = await startServer({ CANOPY_CALENDAR_SECRET: '' });
  t.after(() => server.stop());
  assert.ok(server.output().includes('CANOPY_CALENDAR_SECRET not set'));
  const r = await asAccountService(server)(server.people.ana);
  assert.equal(r.status, 401);
  // Signed with the empty secret doesn't get in either.
  assert.equal((await asAccountService(server, { secret: '' })(server.people.ana)).status, 401);
});

test('what goes in someone\'s calendar, for every part they can have in an event', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const P = server.people;
  const ask = asAccountService(server);
  const [ana, ben, cy, dee, eve, fay, una] = ['ana', 'ben', 'cy', 'dee', 'eve', 'fay', 'una'].map((n) => client(server, n));
  // Places without anyone's name in them, so the name check below means
  // something.
  const place = { locationName: 'The roof', locationAddress: '1 Market St, San Francisco' };

  // Ana hosts; Cy co-hosts. Ben is going with a guest; Dee is maybe; Una
  // (an unverified quick account) is going; Eve can't go; Fay was invited
  // and hasn't answered; Gus answered then was removed.
  await cy.get('/api/v1/me');
  const party = await makeEvent(ana, { title: 'Party', guestsAllowed: 2, description: 'Bring a jacket, and snacks; please.', ...place });
  await ana.post(`/api/v1/events/${party.id}/cohosts`, { personId: P.cy.id });
  await ben.put(`/api/v1/events/${party.id}/rsvp`, { status: 'going', guests: 1 });
  await dee.put(`/api/v1/events/${party.id}/rsvp`, { status: 'maybe' });
  await una.put(`/api/v1/events/${party.id}/rsvp`, { status: 'going' });
  await eve.put(`/api/v1/events/${party.id}/rsvp`, { status: 'not_going' });
  await ana.post(`/api/v1/events/${party.id}/invites`, { personIds: [P.fay.id] });
  const gus = client(server, 'gus');
  await gus.put(`/api/v1/events/${party.id}/rsvp`, { status: 'going' });
  await ana.put(`/api/v1/events/${party.id}/removed/${P.gus.id}`);

  // A full one: Eve's "going" puts her on the waitlist.
  const small = await makeEvent(ben, { title: 'Small dinner', capacity: 1, ...place });
  await dee.put(`/api/v1/events/${small.id}/rsvp`, { status: 'going' });
  await eve.put(`/api/v1/events/${small.id}/rsvp`, { status: 'going' });
  // Invited and then uninvited.
  await ben.post(`/api/v1/events/${small.id}/invites`, { personIds: [P.fay.id] });
  await ben.del(`/api/v1/events/${small.id}/invites/${P.fay.id}`);

  // Cancelled, coming up: Dee was going.
  const off = await makeEvent(ben, { title: 'Picnic', ...place });
  await dee.put(`/api/v1/events/${off.id}/rsvp`, { status: 'going' });
  await ben.patch(`/api/v1/events/${off.id}`, { status: 'cancelled' });
  // Cancelled 40 days ago: gone from calendars by now.
  const oldOff = await makeEvent(ben, { title: 'Old picnic', ...place });
  await dee.put(`/api/v1/events/${oldOff.id}/rsvp`, { status: 'going' });
  await ben.patch(`/api/v1/events/${oldOff.id}`, { status: 'cancelled' });
  server.setTimes(oldOff.id, { startedAgoMs: 40 * DAY, overInMs: -40 * DAY + 3600e3 });
  // Over: 60 days ago is in the window; 100 days ago isn't.
  const recent = await makeEvent(ben, { title: 'Recent', ...place });
  await dee.put(`/api/v1/events/${recent.id}/rsvp`, { status: 'going' });
  server.setTimes(recent.id, { startedAgoMs: 60 * DAY, overInMs: -60 * DAY + 3600e3 });
  const ancient = await makeEvent(ben, { title: 'Ancient', ...place });
  await dee.put(`/api/v1/events/${ancient.id}/rsvp`, { status: 'going' });
  server.setTimes(ancient.id, { startedAgoMs: 100 * DAY, overInMs: -100 * DAY + 3600e3 });
  // Deleted: gone.
  const deleted = await makeEvent(ben, { title: 'Deleted', ...place });
  await dee.put(`/api/v1/events/${deleted.id}/rsvp`, { status: 'going' });
  await ben.del(`/api/v1/events/${deleted.id}`);

  const entriesOf = async (who) => {
    const r = await ask(P[who]);
    assert.equal(r.status, 200, r.text);
    return r.data.entries;
  };
  const byTitle = (entries) => Object.fromEntries(entries.map((e) => [e.title, e]));

  // Ana hosts the party.
  const anaE = byTitle(await entriesOf('ana'));
  assert.deepEqual(Object.keys(anaE), ['Party']);
  const p = anaE.Party;
  assert.equal(p.status, 'confirmed');
  assert.equal(p.uid, `${party.id}@events.canopysf.com`);
  assert.equal(p.url, `${server.base}/e/${party.id}`);
  assert.equal(p.start, party.startsAt);
  assert.equal(p.end, null);
  assert.equal(p.allDay, false);
  assert.equal(p.timeZone, 'America/Los_Angeles');
  assert.equal(p.location, 'The roof, 1 Market St, San Francisco');
  assert.equal(p.description, `You're hosting.\n\nBring a jacket, and snacks; please.\n\n${server.base}/e/${party.id}`);
  assert.equal((byTitle(await entriesOf('cy'))).Party.description.split('\n')[0], "You're co-hosting.");
  assert.equal(byTitle(await entriesOf('cy')).Party.status, 'confirmed');

  // Ben: going (with his guest) to the party; hosting the rest, including
  // the cancelled picnic (hosts keep cancelled ones too) and the recent
  // one, but not the 40-days-cancelled one, the 100-days-old one or the
  // deleted one.
  const benE = byTitle(await entriesOf('ben'));
  assert.deepEqual(Object.keys(benE).sort(), ['Party', 'Picnic', 'Recent', 'Small dinner']);
  assert.equal(benE.Party.status, 'confirmed');
  assert.match(benE.Party.description, /^You're going \(plus 1 guest\)\./);
  assert.equal(benE.Picnic.status, 'cancelled');

  // Dee: maybe (tentative), going to the small dinner, the cancelled
  // picnic, the recent one.
  const deeE = byTitle(await entriesOf('dee'));
  assert.deepEqual(Object.keys(deeE).sort(), ['Party', 'Picnic', 'Recent', 'Small dinner']);
  assert.equal(deeE.Party.status, 'tentative');
  assert.match(deeE.Party.description, /^You said maybe\./);
  assert.equal(deeE['Small dinner'].status, 'confirmed');
  assert.equal(deeE.Picnic.status, 'cancelled');
  assert.match(deeE.Picnic.description, /^This event was cancelled\./);
  assert.equal(deeE.Recent.status, 'confirmed');
  // Soonest first.
  const deeList = await entriesOf('dee');
  assert.deepEqual(deeList.map((e) => e.start), deeList.map((e) => e.start).slice().sort());

  // Eve: can't go to the party (left out); waitlisted for the small dinner.
  const eveE = byTitle(await entriesOf('eve'));
  assert.deepEqual(Object.keys(eveE), ['Small dinner']);
  assert.equal(eveE['Small dinner'].status, 'tentative');
  assert.match(eveE['Small dinner'].description, /^On the waitlist\./);

  // Una (unverified) is going: she's in. Fay only invited, and uninvited:
  // nothing. Gus was removed: nothing.
  assert.deepEqual(Object.keys(byTitle(await entriesOf('una'))), ['Party']);
  assert.deepEqual(await entriesOf('fay'), []);
  assert.deepEqual(await entriesOf('gus'), []);

  // Nobody's name, id or contact details, anywhere in anyone's answer
  // (the harness already walked each for contact details). Names as whole
  // words: "Eve" is in "events".
  const escape = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const who of ['ana', 'ben', 'cy', 'dee', 'eve', 'una']) {
    const text = strings((await ask(P[who])).data).join('\n');
    for (const other of Object.values(P)) {
      for (const v of [other.firstName, other.lastName, other.id, other.email, other.phone, other.instagram, other.venmo, other.cashapp]) {
        assert.ok(!new RegExp(`\\b${escape(v)}\\b`, 'i').test(text), `${who}'s calendar mentions ${other.name}: ${v}`);
      }
    }
  }
});

test('a new link keeps the UID and moves the URL; a change moves updatedAt', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const P = server.people;
  const ask = asAccountService(server);
  const ana = client(server, 'ana');
  const ben = client(server, 'ben');
  const e = await makeEvent(ana, { endsAt: new Date(Date.now() + 8 * DAY).toISOString() });
  await ben.put(`/api/v1/events/${e.id}/rsvp`, { status: 'maybe' });
  const [first] = (await ask(P.ben)).data.entries;
  assert.equal(first.uid, `${e.id}@events.canopysf.com`);
  assert.equal(first.end, e.endsAt);

  await new Promise((r) => setTimeout(r, 5));
  const fresh = await ana.post(`/api/v1/events/${e.id}/new-link`);
  assert.equal(fresh.status, 200, fresh.text);
  const newId = fresh.data.event.id;
  assert.notEqual(newId, e.id);
  const [second] = (await ask(P.ben)).data.entries;
  assert.equal(second.uid, first.uid, 'the same event to a calendar app');
  assert.equal(second.url, `${server.base}/e/${newId}`);
  assert.ok(!second.description.includes(`/e/${e.id}`));
  assert.ok(second.updatedAt > first.updatedAt);

  // Ben's own answer changing is a change to his entry.
  await new Promise((r) => setTimeout(r, 5));
  await ben.put(`/api/v1/events/${newId}/rsvp`, { status: 'going' });
  const [third] = (await ask(P.ben)).data.entries;
  assert.equal(third.status, 'confirmed');
  assert.ok(third.updatedAt > second.updatedAt);
  // Ana's entry didn't change with it.
  assert.equal((await ask(P.ana)).data.entries[0].updatedAt, second.updatedAt);
  // Taking the answer back takes it out.
  await ben.del(`/api/v1/events/${newId}/rsvp`);
  assert.deepEqual((await ask(P.ben)).data.entries, []);
});
