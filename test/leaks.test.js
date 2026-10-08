// Contact details never leak. The leak walker in harness.js already runs
// on every JSON answer in every test; this file checks the walker itself
// catches what it should, then calls every endpoint as a host, a guest,
// an unverified guest and someone signed out, with every kind of person
// on the event, and holds each person in each answer to exactly the five
// public fields.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, makeEvent, findLeaks, calendarAuth } = require('./harness');
const { makePeople } = require('./fakeAccount');

const PUBLIC_FIELDS = ['firstName', 'id', 'lastName', 'photoUrl', 'shortName'];

test('the leak walker finds contact details, anyone\'s, the caller\'s own included', () => {
  const people = makePeople();
  const { ana, ben } = people;
  // A contact field on someone else, by name.
  assert.deepEqual(findLeaks({ guests: [{ person: { id: ben.id, email: 'x' } }] }, ana.id, people), ['$.guests[0].person.email']);
  // Someone's actual details anywhere, under any name, in any case.
  assert.equal(findLeaks({ note: `call ${ben.phone}` }, ana.id, people).length, 1);
  assert.equal(findLeaks({ a: { b: [ben.instagram.toUpperCase()] } }, ana.id, people).length, 1);
  assert.equal(findLeaks({ handle: ben.cashapp }, ana.id, people).length, 1);
  // Signed out, everyone is someone else.
  assert.equal(findLeaks({ id: ana.id, venmo: ana.venmo }, null, people).length, 2);
  // Your own aren't fine either: events never answers with any.
  assert.equal(findLeaks({ person: { id: ana.id, email: ana.email, phone: ana.phone } }, ana.id, people).length, 4);
  // A null field isn't a leak; the public shape isn't either.
  assert.deepEqual(findLeaks({ id: ben.id, phone: null, firstName: 'Ben', shortName: 'Ben O' }, ana.id, people), []);
  // An event's phone detail is a number the host typed for their guests,
  // under `value`, not a contact field: one that's nobody's account
  // number is fine; anyone's account number, in any detail, is caught.
  const detail = (value) => ({ details: [{ type: 'phone', label: null, value, href: 'tel:' + value.replace(/[^0-9+]/g, '') }] });
  assert.deepEqual(findLeaks(detail('(415) 555-0199'), ana.id, people), []);
  assert.ok(findLeaks(detail(ben.phone), ana.id, people).length >= 1);
  assert.ok(findLeaks({ details: [{ type: 'info', label: null, value: `DM ${ana.instagram}`, href: null }] }, ana.id, people).length === 1);
});

test('every endpoint, every caller: other people are the five public fields and nothing else', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const P = server.people;
  const [ana, ben, cy, una, gus] = ['ana', 'ben', 'cy', 'una', 'gus'].map((n) => client(server, n));
  const benApp = client(server, 'ben', { mode: 'bearer' });
  const anon = client(server, null);

  // An event with everyone on it: going, maybe, can't go, invited,
  // unverified, and a former member; and an earlier one, so there are
  // friends.
  const before = await makeEvent(ana, { title: 'Before' });
  await ben.put(`/api/v1/events/${before.id}/rsvp`, { status: 'going' });
  await una.put(`/api/v1/events/${before.id}/rsvp`, { status: 'going' });
  server.setTimes(before.id, { startedAgoMs: 9 * 86400e3, overInMs: -8 * 86400e3 });
  // With every kind of detail, a host-typed phone number among them
  // (nobody's account number), so every answer about it carries them.
  const e = await makeEvent(ana, {
    guestListVisibility: 'responded',
    details: [
      { type: 'link', label: 'Tickets', value: 'https://tickets.example.com/x' },
      { type: 'info', value: 'Doors at 7' },
      { type: 'dress_code', value: 'Warm layers' },
      { type: 'food', value: 'Tacos' },
      { type: 'parking', value: 'Garage code 4512' },
      { type: 'accommodation', value: 'Spare room' },
      { type: 'phone', value: '(415) 555-0199' }
    ]
  });
  assert.deepEqual(e.details.map((d) => d.value).slice(-1), ['(415) 555-0199'], "the host's own words, never their account's number");
  await ben.put(`/api/v1/events/${e.id}/rsvp`, { status: 'going' });
  await cy.put(`/api/v1/events/${e.id}/rsvp`, { status: 'maybe' });
  await una.put(`/api/v1/events/${e.id}/rsvp`, { status: 'not_going' });
  await gus.put(`/api/v1/events/${e.id}/rsvp`, { status: 'going' });
  await ana.post(`/api/v1/events/${e.id}/invites`, { personIds: [P.dee.id, P.eve.id] });
  // A co-host, the wall and notifications, so those answers have people
  // in them too.
  await cy.get('/api/v1/me');
  await ana.post(`/api/v1/events/${e.id}/cohosts`, { personId: P.cy.id });
  await ben.post(`/api/v1/events/${e.id}/wall`, { text: 'See you all there' });
  await gus.post(`/api/v1/events/${e.id}/wall`, { text: 'Gone soon' });
  await ana.patch(`/api/v1/events/${e.id}`, { locationName: 'Upstairs' });
  server.fake.deleted.add(P.gus.id);

  const answers = [];
  const call = async (who, method, url, body) => {
    const r = await who[method](url, body);
    answers.push({ who: who.person ? who.person.name : 'nobody', url, r });
    return r;
  };
  // Friends of every kind: added by id, through a friend link, and an
  // invitation (above), so the friends answers have each kind in them.
  await ben.post('/api/v1/me/friends', { personId: P.eve.id });
  const anaLink = (await ana.get('/api/v1/me/friend-link')).data;
  await una.post(`/api/v1/friend-links/${anaLink.code}/accept`);
  for (const who of [ana, ben, benApp, una, cy, anon]) {
    await call(who, 'get', `/api/v1/friend-links/${anaLink.code}`);
    await call(who, 'get', '/api/v1/me/friend-link');
    await call(who, 'get', '/api/v1/me/settings');
    await call(who, 'get', `/api/v1/events/${e.id}`);
    await call(who, 'get', `/api/v1/events/${e.id}/guests`);
    await call(who, 'get', '/api/v1/me');
    await call(who, 'get', '/api/v1/me/friends');
    await call(who, 'get', `/api/v1/events/${e.id}/wall`);
    await call(who, 'get', '/api/v1/me/notifications');
    await call(who, 'post', '/api/v1/people/lookup', { phone: P.eve.phone });
    await call(who, 'post', '/api/v1/people/lookup', { instagram: P.una.instagram });
    for (const list of ['hosting', 'upcoming', 'invitations', 'declined', 'all', 'past']) await call(who, 'get', `/api/v1/me/events/${list}`);
  }
  await call(ana, 'get', `/api/v1/events/${e.id}/guests?status=invited`);
  await call(ana, 'patch', `/api/v1/events/${e.id}`, { description: 'Updated' });
  await call(ana, 'post', `/api/v1/events/${e.id}/invites`, { personIds: [P.fay.id, P.ben.id] });
  await call(ana, 'del', `/api/v1/events/${e.id}/invites/${P.fay.id}`);
  await call(ben, 'put', `/api/v1/events/${e.id}/rsvp`, { status: 'maybe' });
  await call(benApp, 'put', `/api/v1/events/${e.id}/rsvp`, { status: 'not_going' });
  await call(ana, 'post', '/api/v1/events', { title: 'New', startsAt: '2030-01-01T20:00:00Z', timeZone: 'UTC' });
  await call(ben, 'post', `/api/v1/events/${e.id}/wall`, { text: 'Again' });
  await call(ana, 'del', `/api/v1/events/${e.id}/cohosts/${P.cy.id}`);
  await call(ana, 'post', `/api/v1/events/${e.id}/cohosts`, { personId: P.cy.id });
  await call(ana, 'post', `/api/v1/events/${e.id}/new-link`);
  await call(cy, 'post', '/api/v1/me/friends', { personId: P.fay.id });
  await call(cy, 'post', `/api/v1/friend-links/${anaLink.code}/accept`);
  await call(cy, 'del', `/api/v1/me/friends/${P.fay.id}`);
  await call(cy, 'post', '/api/v1/me/friend-link/reset');
  // The account service asking for each person's calendar (site to site):
  // no caller, so nobody's contact details at all, and no people in it.
  for (const p of Object.values(P)) {
    const r = await anon.get(`/api/calendar/${p.id}`, { headers: { Authorization: calendarAuth(p.id) } });
    assert.equal(r.status, 200);
    answers.push({ who: 'the account service', url: `/api/calendar/${p.id}`, r });
    assert.ok(!JSON.stringify(r.data).includes('firstName'), `${p.name}'s calendar has nobody in it`);
  }
  assert.ok(answers.some((a) => a.url.startsWith('/api/calendar/') && a.r.data.entries.length >= 2), 'there were entries to walk');

  // Every person-shaped object in every answer: anything with a firstName.
  let checked = 0;
  for (const { who, url, r } of answers) {
    const self = P[who];
    const walk = (v, isMe) => {
      if (Array.isArray(v)) return v.forEach((x) => walk(x));
      if (!v || typeof v !== 'object') return;
      if ('firstName' in v) {
        checked++;
        if (isMe && self && v.id === self.id) return;
        assert.deepEqual(Object.keys(v).sort(), PUBLIC_FIELDS, `${who} ${url}: ${JSON.stringify(v)}`);
      }
      for (const [k, x] of Object.entries(v)) walk(x, url === '/api/v1/me' && k === 'person');
    };
    walk(r.data);
  }
  assert.ok(checked > 100, `checked ${checked} people`);
  // The lookups found people, as the five fields.
  const found = answers.filter((a) => a.who === 'ana' && a.url.includes('/people/lookup')).map((a) => a.r.data.person);
  assert.deepEqual(found.map((p) => p && p.id), [P.eve.id, P.una.id]);
  // And the former member really was in there, as one.
  const hostView = answers.find((a) => a.who === 'ana' && a.url === `/api/v1/events/${e.id}/guests`).r.data;
  assert.equal(hostView.guests.find((g) => g.person.id === P.gus.id).person.shortName, 'Former member');
  assert.equal(hostView.guests.length, 5, 'everyone but Cy, who co-hosts now');
});
