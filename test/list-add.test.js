// Adding people to your own list (POST /api/v1/me/lists/{listId}/members,
// routes/lists.js; lib/store/lists.js addMembers): owner only; the same
// people the owner could invite (not yourself, not an account that's
// gone or never was, not anyone who opted out of your invitations, each
// skipped as the invite call would); idempotent; the limits; being added
// is the same as joining (invited to the list's events still to come, in
// the same step, opt-outs, cancelled and past events skipped); the added
// see the list in "Lists you're on" and can leave; members still never
// see each other. Every answer also goes through the leak walker and the
// spec check (harness.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, makeEvent } = require('./harness');

const PUBLIC_FIELDS = ['firstName', 'id', 'lastName', 'photoUrl', 'shortName'];
const NOBODY = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

test('adding people to a list', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const P = server.people;
  const [ana, ben, cy, dee, eve, fay, una] = ['ana', 'ben', 'cy', 'dee', 'eve', 'fay', 'una'].map((n) => client(server, n));
  const anon = client(server, null);
  for (const who of [ana, ben, cy, dee, eve, fay, una]) await who.get('/api/v1/me');
  const statusOn = async (eventId, id) => {
    const r = await ana.get(`/api/v1/events/${eventId}/guests?limit=100`);
    const g = r.data.guests.find((x) => x.person.id === id);
    if (g) return g.status;
    const removed = await ana.get(`/api/v1/events/${eventId}/guests?status=removed&limit=100`);
    return removed.data.guests.some((x) => x.person.id === id) ? 'removed' : null;
  };
  const invitedNotes = async (who, eventId) => (await who.get('/api/v1/me/notifications?limit=100')).data.notifications
    .filter((n) => n.event && n.event.id === eventId && n.type === 'invited');
  const friendIds = async (who) => (await who.get('/api/v1/me/friends?limit=100')).data.friends.map((f) => f.person.id);
  const memberIds = async (listId) => (await ana.get(`/api/v1/me/lists/${listId}/members?limit=100`)).data.members.map((m) => m.person.id);

  const drag = (await ana.post('/api/v1/me/lists', { name: 'Drag Race' })).data.list;
  // On the list's events: one coming up, one over, one cancelled.
  const next = await makeEvent(ana, { title: 'Drag Race night 5' });
  const past = await makeEvent(ana, { title: 'Drag Race night 4' });
  const off = await makeEvent(ana, { title: 'Drag Race night 6' });
  for (const e of [next, past, off]) assert.equal((await ana.put(`/api/v1/events/${e.id}/lists/${drag.id}`)).status, 200);
  server.setTimes(past.id, { startedAgoMs: 9 * 86400e3, overInMs: -8 * 86400e3 });
  assert.equal((await ana.patch(`/api/v1/events/${off.id}`, { status: 'cancelled' })).status, 200);
  // Dee opted out of Ana's invitations; Gus's account is gone; Fay was
  // removed from the next one.
  await dee.put(`/api/v1/me/invite-optouts/${P.ana.id}`);
  await ana.put(`/api/v1/events/${next.id}/removed/${P.fay.id}`);
  server.fake.deleted.add(P.gus.id);

  await t.test('only the owner, verified, with a list of 1 to 100 person ids', async () => {
    assert.equal((await anon.post(`/api/v1/me/lists/${drag.id}/members`, { personIds: [P.ben.id] })).status, 401);
    for (const [who, list] of [[ben, drag.id], [ben, 'AAAAAAAAAAAA'], [ana, 'AAAAAAAAAAAA'], [ana, 'nope']]) {
      const r = await who.post(`/api/v1/me/lists/${list}/members`, { personIds: [P.cy.id] });
      assert.deepEqual([r.status, r.data.reason], [404, 'list_not_found'], `${who.person.name} ${list}`);
    }
    const quick = await una.post(`/api/v1/me/lists/${drag.id}/members`, { personIds: [P.cy.id] });
    assert.deepEqual([quick.status, quick.data.reason], [403, 'email_unverified']);
    for (const personIds of [undefined, [], 'x', [42], ['not-an-id'], Array.from({ length: 101 }, () => P.ben.id)]) {
      const r = await ana.post(`/api/v1/me/lists/${drag.id}/members`, { personIds });
      assert.deepEqual([r.status, r.data.reason], [400, 'bad_person_ids'], String(JSON.stringify(personIds)).slice(0, 40));
    }
    const forged = await client(server, 'ana', { origin: 'https://evil.example' }).post(`/api/v1/me/lists/${drag.id}/members`, { personIds: [P.ben.id] });
    assert.equal(forged.data.reason, 'bad_origin');
    assert.deepEqual(await memberIds(drag.id), [], 'nobody was added by any of that');
  });

  await t.test('who can be added: anyone you could invite; not you, the gone, the unknown or anyone opted out', async () => {
    const r = await ana.post(`/api/v1/me/lists/${drag.id}/members`, { personIds: [P.ben.id, P.cy.id, P.ben.id, P.ana.id, P.dee.id, P.gus.id, NOBODY] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.added.map((p) => p.id), [P.ben.id, P.cy.id]);
    r.data.added.forEach((p) => assert.deepEqual(Object.keys(p).sort(), PUBLIC_FIELDS));
    assert.deepEqual(r.data.alreadyOn, []);
    // Opted out is `not_found`, like no account at all: the answer doesn't tell.
    assert.deepEqual(r.data.skipped, [
      { personId: P.ana.id, reason: 'is_you' },
      { personId: P.dee.id, reason: 'not_found' },
      { personId: P.gus.id, reason: 'not_found' },
      { personId: NOBODY, reason: 'not_found' }
    ]);
    assert.equal(r.data.list.id, drag.id);
    assert.equal(r.data.list.memberCount, 2);
    assert.deepEqual(Object.keys(r.data.list).sort(), ['code', 'createdAt', 'id', 'memberCount', 'name', 'url']);
    assert.deepEqual((await memberIds(drag.id)).sort(), [P.ben.id, P.cy.id].sort());
  });

  await t.test('being added is joining: invited to what is still to come, in the same step; not the past or cancelled ones', async () => {
    assert.equal(await statusOn(next.id, P.ben.id), 'invited');
    assert.equal(await statusOn(next.id, P.cy.id), 'invited');
    for (const e of [past, off]) {
      assert.equal(await statusOn(e.id, P.ben.id), null, `${e.title}: nobody invited`);
      assert.equal(await statusOn(e.id, P.cy.id), null);
    }
    // The invitation notifies as usual, from Ana; there's nothing about
    // the list itself.
    const notes = await invitedNotes(ben, next.id);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].actor.id, P.ana.id);
    const all = (await ben.get('/api/v1/me/notifications?limit=100')).data.notifications;
    assert.ok(all.every((n) => n.type === 'invited'), JSON.stringify(all.map((n) => n.type)));
    // The invitation makes them friends, both ways, as every invitation does.
    assert.ok((await friendIds(ana)).includes(P.ben.id) && (await friendIds(ben)).includes(P.ana.id));
    // Fay was removed from the next one: on the list, still removed there.
    const f = await ana.post(`/api/v1/me/lists/${drag.id}/members`, { personIds: [P.fay.id] });
    assert.deepEqual(f.data.added.map((p) => p.id), [P.fay.id]);
    assert.equal(f.data.invitedTo, 0, 'nothing to invite her to');
    assert.equal(await statusOn(next.id, P.fay.id), 'removed');
    // An answer Eve gave stays her answer.
    await eve.put(`/api/v1/events/${next.id}/rsvp`, { status: 'maybe' });
    const e2 = await ana.post(`/api/v1/me/lists/${drag.id}/members`, { personIds: [P.eve.id] });
    assert.equal(e2.data.invitedTo, 0);
    assert.equal(await statusOn(next.id, P.eve.id), 'maybe');
  });

  await t.test('invitedTo counts the events; a list on nothing invites nobody and makes no friends', async () => {
    const book = (await ana.post('/api/v1/me/lists', { name: 'Book club' })).data.list;
    const r = await ana.post(`/api/v1/me/lists/${book.id}/members`, { personIds: [P.ben.id] });
    assert.equal(r.data.invitedTo, 0);
    const later = await makeEvent(ana, { title: 'Book club 1' });
    const later2 = await makeEvent(ana, { title: 'Book club 2' });
    await ana.put(`/api/v1/events/${later.id}/lists/${book.id}`);
    await ana.put(`/api/v1/events/${later2.id}/lists/${book.id}`);
    // Cy hadn't been invited to anything of Ana's before the Drag Race add;
    // here both Book club nights.
    const c = await ana.post(`/api/v1/me/lists/${book.id}/members`, { personIds: [P.cy.id] });
    assert.equal(c.data.invitedTo, 2);
    assert.equal(await statusOn(later.id, P.cy.id), 'invited');
    assert.equal(await statusOn(later2.id, P.cy.id), 'invited');
    // A list on nothing, someone who's never been invited by Ana: no
    // friendship from being added alone.
    const solo = (await fay.post('/api/v1/me/lists', { name: 'Fay list' })).data.list;
    await fay.post(`/api/v1/me/lists/${solo.id}/members`, { personIds: [P.dee.id] });
    assert.ok(!(await friendIds(fay)).includes(P.dee.id));
    assert.ok(!(await friendIds(dee)).includes(P.fay.id));
  });

  await t.test('idempotent: someone already on it is alreadyOn, and nothing changes', async () => {
    const before = await memberIds(drag.id);
    const r = await ana.post(`/api/v1/me/lists/${drag.id}/members`, { personIds: [P.ben.id, P.cy.id] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.added, []);
    assert.deepEqual(r.data.alreadyOn.sort(), [P.ben.id, P.cy.id].sort());
    assert.equal(r.data.invitedTo, 0);
    assert.deepEqual(await memberIds(drag.id), before);
    assert.equal(r.data.list.memberCount, before.length);
    assert.equal((await invitedNotes(ben, next.id)).length, 1, 'no second notification');
  });

  await t.test('the owner sees how each came to be on it: added, or joined by the link', async () => {
    const link = (await ana.get('/api/v1/me/lists')).data.lists.find((l) => l.id === drag.id);
    // Una joins by the link.
    await una.post(`/api/v1/list-links/${link.code}/join`);
    const members = (await ana.get(`/api/v1/me/lists/${drag.id}/members?limit=100`)).data.members;
    const by = Object.fromEntries(members.map((m) => [m.person.id, m.source]));
    assert.equal(by[P.una.id], 'link');
    assert.equal(by[P.ben.id], 'added');
    assert.equal(members[0].person.id, P.una.id, 'newest first');
    // Someone on it already by the link stays "joined" when added again.
    const again = await ana.post(`/api/v1/me/lists/${drag.id}/members`, { personIds: [P.una.id] });
    assert.deepEqual(again.data.alreadyOn, [P.una.id]);
  });

  await t.test('the added see the list in "Lists you\'re on", nobody else on it, and can leave', async () => {
    const mine = (await ben.get('/api/v1/me/list-memberships')).data.lists;
    const m = mine.find((l) => l.id === drag.id);
    assert.ok(m);
    assert.deepEqual(Object.keys(m).sort(), ['id', 'joinedAt', 'name', 'owner']);
    assert.equal(m.owner.id, P.ana.id);
    // Members never see each other: not in their own answers, and the
    // owner's calls are 404 to them.
    const seen = JSON.stringify((await ben.get('/api/v1/me/list-memberships')).data);
    for (const other of [P.cy.id, P.fay.id, P.una.id]) assert.ok(!seen.includes(other));
    for (const [method, url, body] of [
      ['get', `/api/v1/me/lists/${drag.id}/members`],
      ['post', `/api/v1/me/lists/${drag.id}/members`, { personIds: [P.dee.id] }]
    ]) {
      const r = await ben[method](url, body);
      assert.deepEqual([r.status, r.data.reason], [404, 'list_not_found']);
    }
    assert.equal((await ben.del(`/api/v1/me/list-memberships/${drag.id}`)).status, 200);
    assert.ok(!(await memberIds(drag.id)).includes(P.ben.id));
    assert.equal(await statusOn(next.id, P.ben.id), 'invited', 'leaving keeps the invitation');
    // Added again: back on it.
    const back = await ana.post(`/api/v1/me/lists/${drag.id}/members`, { personIds: [P.ben.id] });
    assert.deepEqual(back.data.added.map((p) => p.id), [P.ben.id]);
  });

  await t.test('limits: a full list adds nobody; 300 people added a day', async () => {
    // At 999, two more is too many: neither is added. One fits.
    const big = (await eve.post('/api/v1/me/lists', { name: 'Big' })).data.list;
    const db = server.db();
    const add = db.prepare('INSERT INTO list_members (list_id, person_id, joined_at) VALUES (?, ?, ?)');
    db.transaction(() => { for (let i = 0; i < 999; i++) add.run(big.id, `ffffffff-0000-4000-8000-${String(i).padStart(12, '0')}`, i); })();
    const full = await eve.post(`/api/v1/me/lists/${big.id}/members`, { personIds: [P.ben.id, P.cy.id] });
    assert.deepEqual([full.status, full.data.reason], [409, 'list_full']);
    assert.equal((await eve.get('/api/v1/me/lists')).data.lists.find((l) => l.id === big.id).memberCount, 999);
    const one = await eve.post(`/api/v1/me/lists/${big.id}/members`, { personIds: [P.ben.id] });
    assert.equal(one.data.list.memberCount, 1000);
    // Already on it is fine at 1,000.
    assert.equal((await eve.post(`/api/v1/me/lists/${big.id}/members`, { personIds: [P.ben.id] })).status, 200);
    // 100 people, onto three lists: 300 in a day. The next one is a 429.
    const crowd = [];
    for (let i = 0; i < 100; i++) crowd.push(server.fake.addPerson(100 + i, `p${i}`, `P${i}`, 'Crowd').id);
    const lists = [];
    for (let i = 0; i < 4; i++) lists.push((await cy.post('/api/v1/me/lists', { name: `Crowd ${i}` })).data.list);
    const addAll = async (i) => {
      const r = await cy.post(`/api/v1/me/lists/${lists[i].id}/members`, { personIds: crowd });
      assert.equal(r.data.added.length, 100, `list ${i}`);
    };
    await addAll(0);
    await addAll(1);
    // Only people actually added count: adding them again costs nothing.
    const again = await cy.post(`/api/v1/me/lists/${lists[0].id}/members`, { personIds: crowd });
    assert.equal(again.data.alreadyOn.length, 100);
    await addAll(2);
    const over = await cy.post(`/api/v1/me/lists/${lists[3].id}/members`, { personIds: [P.ben.id] });
    assert.deepEqual([over.status, over.data.reason], [429, 'rate_limited']);
    // Inviting is counted apart.
    const e = await makeEvent(cy, { title: 'Still inviting' });
    assert.equal((await cy.post(`/api/v1/events/${e.id}/invites`, { personIds: [P.ben.id] })).status, 200);
  });
});
