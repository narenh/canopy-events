// Explicit friends (lib/store/friends.js): adding someone by id, one way;
// friend links, both ways once someone says yes; invitations making a host
// and a guest friends both ways; taking anyone out (hiding an implicit
// friend), and only your own adding bringing them back. Every answer here
// also goes through the leak walker and the spec check (harness.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, makeEvent } = require('./harness');

const PUBLIC_FIELDS = ['firstName', 'id', 'lastName', 'photoUrl', 'shortName'];

test('explicit friends', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const P = server.people;
  const [ana, ben, cy, dee, eve, fay, una] = ['ana', 'ben', 'cy', 'dee', 'eve', 'fay', 'una'].map((n) => client(server, n));
  const anon = client(server, null);
  const fayApp = client(server, 'fay', { mode: 'bearer' });
  const list = async (who) => (await who.get('/api/v1/me/friends?limit=100')).data.friends;
  const ids = async (who) => (await list(who)).map((f) => f.person.id).sort();
  const one = async (who, id) => (await list(who)).find((f) => f.person.id === id);
  const started = (id) => server.setTimes(id, { startedAgoMs: 2 * 3600e3, overInMs: 4 * 3600e3 });

  await t.test('adding by id is one way, and nobody else sees it', async () => {
    const r = await cy.post('/api/v1/me/friends', { personId: P.dee.id });
    assert.equal(r.status, 200);
    assert.equal(r.data.friend.person.id, P.dee.id);
    assert.deepEqual(Object.keys(r.data.friend.person).sort(), PUBLIC_FIELDS);
    assert.deepEqual([r.data.friend.source, r.data.friend.eventsInCommon, r.data.friend.lastTogetherAt], ['added', 0, null]);
    assert.deepEqual(await ids(cy), [P.dee.id]);
    assert.deepEqual(await ids(dee), [], "Dee's list is untouched");
    // Again: nothing changes.
    assert.equal((await cy.post('/api/v1/me/friends', { personId: P.dee.id })).data.friend.source, 'added');
    assert.deepEqual(await ids(cy), [P.dee.id]);
  });

  await t.test('adding by id: verified only, a real person, not yourself', async () => {
    const quick = await una.post('/api/v1/me/friends', { personId: P.ana.id });
    assert.equal(quick.status, 403);
    assert.equal(quick.data.reason, 'email_unverified');
    assert.ok(quick.data.verify);
    assert.equal((await cy.post('/api/v1/me/friends', { personId: 'nope' })).data.reason, 'bad_person_id');
    assert.equal((await cy.post('/api/v1/me/friends', { personId: 42 })).data.reason, 'bad_person_id');
    assert.equal((await cy.post('/api/v1/me/friends', {})).status, 400);
    const self = await cy.post('/api/v1/me/friends', { personId: P.cy.id });
    assert.deepEqual([self.status, self.data.reason], [409, 'is_you']);
    const nobody = await cy.post('/api/v1/me/friends', { personId: '00000000-0000-4000-8000-000000000999' });
    assert.deepEqual([nobody.status, nobody.data.reason], [404, 'person_not_found']);
    assert.equal((await anon.post('/api/v1/me/friends', { personId: P.ana.id })).status, 401);
    // From another site with the cookie: refused before anything happens.
    const forged = await client(server, 'cy', { origin: 'https://evil.example' }).post('/api/v1/me/friends', { personId: P.eve.id });
    assert.deepEqual([forged.status, forged.data.reason], [403, 'bad_origin']);
    assert.deepEqual(await ids(una), []);
  });

  await t.test('taking out someone you added deletes them; taking out someone not there is a 404', async () => {
    assert.equal((await cy.del(`/api/v1/me/friends/${P.dee.id}`)).status, 200);
    assert.deepEqual(await ids(cy), []);
    const again = await cy.del(`/api/v1/me/friends/${P.dee.id}`);
    assert.deepEqual([again.status, again.data.reason], [404, 'not_a_friend']);
    assert.equal((await cy.del('/api/v1/me/friends/nope')).data.reason, 'bad_person_id');
    // And adding again brings them back.
    await cy.post('/api/v1/me/friends', { personId: P.dee.id });
    assert.deepEqual(await ids(cy), [P.dee.id]);
  });

  await t.test('an implicit friend taken out is hidden, stays hidden after another event, and comes back when you add them', async () => {
    const dinner = await makeEvent(ana, { title: 'Dinner' });
    await ben.put(`/api/v1/events/${dinner.id}/rsvp`, { status: 'going' });
    started(dinner.id);
    let b = await one(ana, P.ben.id);
    assert.deepEqual([b.source, b.eventsInCommon], ['shared_events', 1]);
    assert.ok(b.lastTogetherAt);

    assert.equal((await ana.del(`/api/v1/me/friends/${P.ben.id}`)).status, 200);
    assert.ok(!(await ids(ana)).includes(P.ben.id));
    assert.ok((await ids(ben)).includes(P.ana.id), "Ben's list is untouched: he isn't told");

    // Another event together doesn't bring him back, and he isn't a
    // "friend going" either.
    const games = await makeEvent(ben, { title: 'Games' });
    await ana.put(`/api/v1/events/${games.id}/rsvp`, { status: 'going' });
    started(games.id);
    assert.ok(!(await ids(ana)).includes(P.ben.id));
    const later = await makeEvent(eve, { title: 'Later' });
    await ben.put(`/api/v1/events/${later.id}/rsvp`, { status: 'going' });
    assert.equal((await ana.get(`/api/v1/events/${later.id}`)).data.event.friendsGoing.count, 0);

    // Ana adds him again herself: back, with both events in common.
    await ana.post('/api/v1/me/friends', { personId: P.ben.id });
    b = await one(ana, P.ben.id);
    assert.deepEqual([b.source, b.eventsInCommon], ['added', 2]);
    assert.equal((await ana.get(`/api/v1/events/${later.id}`)).data.event.friendsGoing.count, 1);
    // An added friend is a friend going too.
    const brunch = await makeEvent(eve, { title: 'Brunch' });
    await dee.put(`/api/v1/events/${brunch.id}/rsvp`, { status: 'going' });
    assert.deepEqual((await cy.get(`/api/v1/events/${brunch.id}`)).data.event.friendsGoing.people.map((p) => p.id), [P.dee.id]);
    assert.equal((await dee.get(`/api/v1/events/${brunch.id}`)).data.event.friendsGoing.count, 0, 'one way');
  });

  await t.test('your friend link: made once, the same each time; unverified people have one', async () => {
    const r = await fay.get('/api/v1/me/friend-link');
    assert.equal(r.status, 200);
    assert.match(r.data.code, /^[0-9A-Za-z]{12}$/);
    assert.equal(r.data.url, `${server.base}/f/${r.data.code}`);
    assert.deepEqual((await fayApp.get('/api/v1/me/friend-link')).data, r.data);
    const quick = await una.get('/api/v1/me/friend-link');
    assert.equal(quick.status, 200);
    assert.notEqual(quick.data.code, r.data.code);
    assert.equal((await anon.get('/api/v1/me/friend-link')).status, 401);
  });

  await t.test('opening a link shows its owner and adds nobody', async () => {
    const { code } = (await fay.get('/api/v1/me/friend-link')).data;
    const out = await anon.get(`/api/v1/friend-links/${code}`);
    assert.equal(out.status, 200);
    assert.deepEqual(Object.keys(out.data.person).sort(), PUBLIC_FIELDS);
    assert.equal(out.data.person.id, P.fay.id);
    assert.equal(out.data.viewer, null);
    const seen = await eve.get(`/api/v1/friend-links/${code}`);
    assert.deepEqual(seen.data.viewer, { isYou: false, isFriend: false });
    assert.deepEqual((await fay.get(`/api/v1/friend-links/${code}`)).data.viewer, { isYou: true, isFriend: false });
    assert.ok(!(await ids(eve)).includes(P.fay.id));
    assert.ok(!(await ids(fay)).includes(P.eve.id));
    for (const bad of ['AAAAAAAAAAAA', 'short', 'x'.repeat(40)]) {
      const miss = await anon.get(`/api/v1/friend-links/${bad}`);
      assert.deepEqual([miss.status, miss.data.reason], [404, 'friend_link_not_found'], bad);
    }
  });

  await t.test('saying yes is both ways; your own link is a 409; unverified people can say yes', async () => {
    const { code } = (await fay.get('/api/v1/me/friend-link')).data;
    const r = await eve.post(`/api/v1/friend-links/${code}/accept`);
    assert.equal(r.status, 200);
    assert.deepEqual([r.data.friend.person.id, r.data.friend.source], [P.fay.id, 'link']);
    assert.equal((await one(eve, P.fay.id)).source, 'link');
    assert.equal((await one(fay, P.eve.id)).source, 'link');
    assert.deepEqual((await eve.get(`/api/v1/friend-links/${code}`)).data.viewer, { isYou: false, isFriend: true });
    // Again: nothing changes.
    assert.equal((await eve.post(`/api/v1/friend-links/${code}/accept`)).status, 200);

    const own = await fay.post(`/api/v1/friend-links/${code}/accept`);
    assert.deepEqual([own.status, own.data.reason], [409, 'own_link']);
    const quick = await una.post(`/api/v1/friend-links/${code}/accept`);
    assert.equal(quick.status, 200);
    assert.ok((await ids(una)).includes(P.fay.id));
    assert.ok((await ids(fay)).includes(P.una.id));
    // Signed out: where to sign in, coming back to the link's page.
    const anonAccept = await anon.post(`/api/v1/friend-links/${code}/accept`);
    assert.equal(anonAccept.status, 401);
    assert.ok(anonAccept.data.quickSignUp.includes(encodeURIComponent(`${server.base}/f/${code}`)));
  });

  await t.test("the owner's hiding someone isn't undone by them opening the link again", async () => {
    const { code } = (await fay.get('/api/v1/me/friend-link')).data;
    await fay.del(`/api/v1/me/friends/${P.una.id}`);
    await una.post(`/api/v1/friend-links/${code}/accept`);
    assert.ok(!(await ids(fay)).includes(P.una.id));
    assert.ok((await ids(una)).includes(P.fay.id));
  });

  await t.test('a reset link stops the old one at once; friends made with it stay', async () => {
    const old = (await fay.get('/api/v1/me/friend-link')).data;
    const r = await fay.post('/api/v1/me/friend-link/reset');
    assert.equal(r.status, 200);
    assert.notEqual(r.data.code, old.code);
    assert.deepEqual((await fay.get('/api/v1/me/friend-link')).data, r.data);
    assert.equal((await anon.get(`/api/v1/friend-links/${old.code}`)).status, 404);
    const stale = await dee.post(`/api/v1/friend-links/${old.code}/accept`);
    assert.deepEqual([stale.status, stale.data.reason], [404, 'friend_link_not_found']);
    assert.equal((await anon.get(`/api/v1/friend-links/${r.data.code}`)).data.person.id, P.fay.id);
    assert.ok((await ids(fay)).includes(P.eve.id));
  });

  await t.test('inviting makes host and guest friends both ways; co-hosts too; uninviting keeps it', async () => {
    const gus = server.fake.addPerson(101, 'hal', 'Hal', 'Hart');
    const hal = client(server, gus);
    const ivy = client(server, server.fake.addPerson(102, 'ivy', 'Ivy', 'Ito'));
    const jo = client(server, server.fake.addPerson(103, 'jo', 'Jo', 'Jung'));
    await hal.get('/api/v1/me');
    await ivy.get('/api/v1/me');
    const party = await makeEvent(hal, { title: 'Party' });
    const r = await hal.post(`/api/v1/events/${party.id}/invites`, { personIds: [ivy.person.id] });
    assert.equal(r.data.invited.length, 1);
    assert.equal((await one(hal, ivy.person.id)).source, 'invite');
    assert.equal((await one(ivy, hal.person.id)).source, 'invite');
    // A co-host's invitation counts the same.
    await hal.post(`/api/v1/events/${party.id}/cohosts`, { personId: ivy.person.id });
    await ivy.post(`/api/v1/events/${party.id}/invites`, { personIds: [jo.person.id] });
    assert.deepEqual(await ids(jo), [ivy.person.id]);
    assert.ok((await ids(ivy)).includes(jo.person.id));
    // Taking the invitation back leaves the friendship.
    assert.equal((await ivy.del(`/api/v1/events/${party.id}/invites/${jo.person.id}`)).status, 200);
    assert.deepEqual(await ids(jo), [ivy.person.id]);
    // Jo takes Ivy out; Ivy inviting Jo again doesn't put her back in
    // Jo's list (only Jo can), though Jo is in Ivy's.
    await jo.del(`/api/v1/me/friends/${ivy.person.id}`);
    await ivy.post(`/api/v1/events/${party.id}/invites`, { personIds: [jo.person.id] });
    assert.deepEqual(await ids(jo), []);
    assert.ok((await ids(ivy)).includes(jo.person.id));
    // A host who took someone out and invites them again has them back.
    await hal.del(`/api/v1/me/friends/${ivy.person.id}`);
    assert.ok(!(await ids(hal)).includes(ivy.person.id));
    const other = await makeEvent(hal, { title: 'Other' });
    await hal.post(`/api/v1/events/${other.id}/invites`, { personIds: [ivy.person.id] });
    assert.ok((await ids(hal)).includes(ivy.person.id));
    // Inviting someone already on the list (they answered on their own)
    // counts too.
    const open = await makeEvent(dee, { title: 'Open house' });
    await cy.put(`/api/v1/events/${open.id}/rsvp`, { status: 'maybe' });
    const already = await dee.post(`/api/v1/events/${open.id}/invites`, { personIds: [P.cy.id] });
    assert.equal(already.data.skipped[0].reason, 'already_on_list');
    assert.ok((await ids(dee)).includes(P.cy.id));
  });

  await t.test('friends come a page at a time, people you only added last', async () => {
    const seen = [];
    let cursor = '';
    do {
      const r = (await ana.get(`/api/v1/me/friends?limit=1&cursor=${encodeURIComponent(cursor)}`)).data;
      seen.push(...r.friends.map((f) => [f.person.id, f.eventsInCommon]));
      cursor = r.nextCursor;
    } while (cursor);
    assert.deepEqual(seen, (await list(ana)).map((f) => [f.person.id, f.eventsInCommon]));
    const counts = seen.map((x) => x[1]);
    assert.deepEqual(counts, counts.slice().sort((a, b) => b - a));
  });

  await t.test('limits: friend links that find nobody, per address', async () => {
    const other = { headers: { 'CF-Connecting-IP': '203.0.113.9' } };
    let r;
    for (let i = 0; i < 60; i++) r = await anon.get('/api/v1/friend-links/AAAAAAAAAAAA', other);
    assert.equal(r.status, 404);
    r = await anon.get('/api/v1/friend-links/AAAAAAAAAAAA', other);
    assert.deepEqual([r.status, r.data.reason], [429, 'rate_limited']);
    // Another address is fine.
    assert.equal((await anon.get('/api/v1/friend-links/AAAAAAAAAAAA')).status, 404);
  });

  await t.test('limits: adding friends, per person a day (every try counts)', async () => {
    const kay = client(server, server.fake.addPerson(104, 'kay', 'Kay', 'Kim'));
    let r;
    for (let i = 0; i < 200; i++) {
      r = await kay.post('/api/v1/me/friends', { personId: '00000000-0000-4000-8000-000000000999' }, { headers: { 'CF-Connecting-IP': `198.51.100.${i % 2}` } });
      assert.equal(r.status, 404, `try ${i + 1}`);
    }
    r = await kay.post('/api/v1/me/friends', { personId: P.ana.id });
    assert.deepEqual([r.status, r.data.reason], [429, 'rate_limited']);
    const { code } = (await ana.get('/api/v1/me/friend-link')).data;
    assert.equal((await kay.post(`/api/v1/friend-links/${code}/accept`)).status, 429);
    assert.equal((await dee.post('/api/v1/me/friends', { personId: P.ana.id })).status, 200, 'others are fine');
  });
});
