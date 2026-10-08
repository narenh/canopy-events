// Lists (lib/store/lists.js, routes/lists.js): making and keeping your
// own, joining by link, privacy (only the owner sees who's on one; a
// member sees the name and the owner, nothing else), attaching to events
// (everyone invited, opt-outs and the removed skipped), joining later
// (invited to what's still to come, in the same step), the guest's
// joinableList and the hosts' hostLists, who may take a list off, limits,
// and the suggested order for inviting. Every answer here also goes
// through the leak walker and the spec check (harness.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, makeEvent } = require('./harness');

const PUBLIC_FIELDS = ['firstName', 'id', 'lastName', 'photoUrl', 'shortName'];
const DAY = 86400e3;

test('lists', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const P = server.people;
  const [ana, ben, cy, dee, eve, fay, una] = ['ana', 'ben', 'cy', 'dee', 'eve', 'fay', 'una'].map((n) => client(server, n));
  const anon = client(server, null);
  const benApp = client(server, 'ben', { mode: 'bearer' });
  for (const who of [ana, ben, cy, dee, eve, fay, una]) await who.get('/api/v1/me');
  const notificationsAbout = async (who, eventId) => (await who.get('/api/v1/me/notifications?limit=100')).data.notifications.filter((n) => n.event && n.event.id === eventId);
  const guestStatus = async (eventId, id) => {
    const r = await ana.get(`/api/v1/events/${eventId}/guests?limit=100`);
    const g = r.data.guests.find((x) => x.person.id === id);
    return g ? g.status : null;
  };
  const friendIds = async (who) => (await who.get('/api/v1/me/friends?limit=100')).data.friends.map((f) => f.person.id);

  let drag;
  await t.test('making a list: verified only, a name of 1 to 60 characters', async () => {
    const quick = await una.post('/api/v1/me/lists', { name: 'Mine' });
    assert.deepEqual([quick.status, quick.data.reason], [403, 'email_unverified']);
    assert.equal((await anon.post('/api/v1/me/lists', { name: 'x' })).status, 401);
    for (const name of ['', '   ', 'x'.repeat(61), 42, null, 'a\u0007b']) {
      const r = await ana.post('/api/v1/me/lists', { name });
      assert.deepEqual([r.status, r.data.reason], [400, 'bad_name'], JSON.stringify(name));
    }
    const r = await ana.post('/api/v1/me/lists', { name: '  Drag   Race ' });
    assert.equal(r.status, 201);
    drag = r.data.list;
    assert.equal(drag.name, 'Drag Race');
    assert.equal(drag.memberCount, 0);
    assert.match(drag.code, /^[0-9A-Za-z]{12}$/);
    assert.notEqual(drag.code, drag.id);
    assert.equal(drag.url, `${server.base}/l/${drag.code}`);
    assert.deepEqual((await ana.get('/api/v1/me/lists')).data.lists.map((l) => l.id), [drag.id]);
    assert.deepEqual((await ben.get('/api/v1/me/lists')).data.lists, [], "Ben has none: lists are each person's own");
    // From another site with the cookie: refused.
    const forged = await client(server, 'ana', { origin: 'https://evil.example' }).post('/api/v1/me/lists', { name: 'x' });
    assert.equal(forged.data.reason, 'bad_origin');
  });

  await t.test('the link: name and owner for anyone, signed in or not; opening it joins nobody', async () => {
    const out = await anon.get(`/api/v1/list-links/${drag.code}`);
    assert.equal(out.status, 200);
    assert.deepEqual(out.data.list, { name: 'Drag Race' });
    assert.deepEqual(Object.keys(out.data.owner).sort(), PUBLIC_FIELDS);
    assert.equal(out.data.owner.id, P.ana.id);
    assert.equal(out.data.viewer, null);
    assert.deepEqual((await ben.get(`/api/v1/list-links/${drag.code}`)).data.viewer, { isOwner: false, isMember: false });
    assert.deepEqual((await ana.get(`/api/v1/list-links/${drag.code}`)).data.viewer, { isOwner: true, isMember: false });
    assert.equal((await ana.get('/api/v1/me/lists')).data.lists[0].memberCount, 0);
    for (const bad of ['AAAAAAAAAAAA', 'nope']) {
      const r = await anon.get(`/api/v1/list-links/${bad}`);
      assert.deepEqual([r.status, r.data.reason], [404, 'list_link_not_found']);
    }
  });

  await t.test('joining: anyone signed in; your own is a 409; twice changes nothing; no friendship by itself', async () => {
    const signedOut = await anon.post(`/api/v1/list-links/${drag.code}/join`);
    assert.equal(signedOut.status, 401);
    assert.ok(signedOut.data.signIn.includes(encodeURIComponent(`/l/${drag.code}`)), 'sign in and come back to the list link');
    const own = await ana.post(`/api/v1/list-links/${drag.code}/join`);
    assert.deepEqual([own.status, own.data.reason], [409, 'own_list']);
    const r = await ben.post(`/api/v1/list-links/${drag.code}/join`);
    assert.equal(r.status, 200);
    assert.equal(r.data.list.name, 'Drag Race');
    assert.equal(r.data.list.owner.id, P.ana.id);
    assert.equal(r.data.invitedTo, 0);
    assert.equal((await ben.post(`/api/v1/list-links/${drag.code}/join`)).data.invitedTo, 0, 'again: fine, nothing new');
    assert.equal((await una.post(`/api/v1/list-links/${drag.code}/join`)).status, 200, 'quick accounts too');
    assert.equal((await benApp.get(`/api/v1/list-links/${drag.code}`)).data.viewer.isMember, true);
    assert.ok(!(await friendIds(ana)).includes(P.ben.id), 'joining makes no friends');
    assert.ok(!(await friendIds(ben)).includes(P.ana.id));
  });

  await t.test('privacy: a member sees the name and the owner; only the owner sees who and how many', async () => {
    const mine = (await ben.get('/api/v1/me/list-memberships')).data.lists;
    assert.equal(mine.length, 1);
    assert.deepEqual(Object.keys(mine[0]).sort(), ['id', 'joinedAt', 'name', 'owner']);
    assert.deepEqual([mine[0].id, mine[0].name, mine[0].owner.id], [drag.id, 'Drag Race', P.ana.id]);
    // Not the members, not the count, not even with the list's id.
    for (const [m, url, body] of [
      ['get', `/api/v1/me/lists/${drag.id}/members`],
      ['patch', `/api/v1/me/lists/${drag.id}`, { name: 'Mine now' }],
      ['del', `/api/v1/me/lists/${drag.id}`],
      ['post', `/api/v1/me/lists/${drag.id}/reset-link`],
      ['del', `/api/v1/me/lists/${drag.id}/members/${P.una.id}`]
    ]) {
      const r = await ben[m](url, body);
      assert.deepEqual([r.status, r.data.reason], [404, 'list_not_found'], `${m} ${url}`);
    }
    assert.ok(!JSON.stringify((await ben.get(`/api/v1/list-links/${drag.code}`)).data).includes(P.una.id));
    // The owner: everyone, newest first, as the five public fields.
    const members = (await ana.get(`/api/v1/me/lists/${drag.id}/members`)).data;
    assert.deepEqual(members.members.map((m) => m.person.id), [P.una.id, P.ben.id]);
    members.members.forEach((m) => assert.deepEqual(Object.keys(m.person).sort(), PUBLIC_FIELDS));
    assert.ok(members.members.every((m) => !Number.isNaN(Date.parse(m.joinedAt))));
    const page1 = (await ana.get(`/api/v1/me/lists/${drag.id}/members?limit=1`)).data;
    assert.equal(page1.members.length, 1);
    const page2 = (await ana.get(`/api/v1/me/lists/${drag.id}/members?limit=1&cursor=${page1.nextCursor}`)).data;
    assert.deepEqual([page1.members[0].person.id, page2.members[0].person.id], [P.una.id, P.ben.id]);
    assert.equal(page2.nextCursor, null);
    assert.equal((await ana.get('/api/v1/me/lists')).data.lists[0].memberCount, 2);
  });

  await t.test('rename, remove a member, leave, reset the link', async () => {
    assert.equal((await ana.patch(`/api/v1/me/lists/${drag.id}`, { name: 'Drag Race Night' })).data.list.name, 'Drag Race Night');
    assert.equal((await ben.get('/api/v1/me/list-memberships')).data.lists[0].name, 'Drag Race Night');
    assert.equal((await ana.del(`/api/v1/me/lists/${drag.id}/members/${P.una.id}`)).status, 200);
    const again = await ana.del(`/api/v1/me/lists/${drag.id}/members/${P.una.id}`);
    assert.deepEqual([again.status, again.data.reason], [404, 'not_a_member']);
    assert.equal((await ana.del(`/api/v1/me/lists/${drag.id}/members/nope`)).data.reason, 'bad_person_id');
    assert.deepEqual((await una.get('/api/v1/me/list-memberships')).data.lists, []);
    // Leaving.
    await cy.post(`/api/v1/list-links/${drag.code}/join`);
    assert.equal((await cy.del(`/api/v1/me/list-memberships/${drag.id}`)).status, 200);
    assert.equal((await cy.del(`/api/v1/me/list-memberships/${drag.id}`)).data.reason, 'not_a_member');
    // Reset: the old link finds nothing; members stay.
    const old = drag.code;
    const reset = (await ana.post(`/api/v1/me/lists/${drag.id}/reset-link`)).data.list;
    assert.notEqual(reset.code, old);
    assert.equal(reset.id, drag.id);
    assert.equal((await anon.get(`/api/v1/list-links/${old}`)).status, 404);
    assert.equal((await anon.get(`/api/v1/list-links/${reset.code}`)).status, 200);
    assert.deepEqual((await ana.get(`/api/v1/me/lists/${drag.id}/members`)).data.members.map((m) => m.person.id), [P.ben.id]);
    drag = reset;
  });

  let week1;
  let past;
  let cancelled;
  await t.test('attaching invites everyone on it, skipping opt-outs, hosts and the removed', async () => {
    // On the list: Ben (already), Cy (made a co-host below), Dee (opted
    // out of Ana's invitations), Fay (removed from the event), Una.
    for (const who of [cy, dee, fay, una]) await who.post(`/api/v1/list-links/${drag.code}/join`);
    await dee.put(`/api/v1/me/invite-optouts/${P.ana.id}`);
    week1 = await makeEvent(ana, { title: 'Drag Race week 1' });
    await ana.post(`/api/v1/events/${week1.id}/cohosts`, { personId: P.cy.id });
    await ana.put(`/api/v1/events/${week1.id}/removed/${P.fay.id}`);

    // Guests can't; nobody can attach someone else's list.
    assert.equal((await ben.put(`/api/v1/events/${week1.id}/lists/${drag.id}`)).data.reason, 'hosts_only');
    const notYours = await cy.put(`/api/v1/events/${week1.id}/lists/${drag.id}`);
    assert.deepEqual([notYours.status, notYours.data.reason], [404, 'list_not_found']);

    const r = await ana.put(`/api/v1/events/${week1.id}/lists/${drag.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.data.invitedCount, 2, 'Ben and Una');
    assert.equal(await guestStatus(week1.id, P.ben.id), 'invited');
    assert.equal(await guestStatus(week1.id, P.una.id), 'invited');
    assert.equal(await guestStatus(week1.id, P.dee.id), null, 'opted out: skipped, without a word');
    assert.equal(await guestStatus(week1.id, P.cy.id), null, 'a host');
    const removed = (await ana.get(`/api/v1/events/${week1.id}/guests?status=removed`)).data.guests.map((g) => g.person.id);
    assert.deepEqual(removed, [P.fay.id], 'still removed');
    // A normal invitation: the notification, and friends both ways.
    const [n] = await notificationsAbout(ben, week1.id);
    assert.deepEqual([n.type, n.actor.id], ['invited', P.ana.id]);
    assert.ok((await friendIds(ana)).includes(P.ben.id));
    assert.ok((await friendIds(ben)).includes(P.ana.id));
    // The hosts see the list on the event; the count only on their own.
    const hl = r.data.event.hostLists;
    assert.equal(hl.length, 1);
    assert.deepEqual([hl[0].id, hl[0].name, hl[0].code, hl[0].isYours, hl[0].memberCount, hl[0].owner.id], [drag.id, drag.name, drag.code, true, 5, P.ana.id]);
    assert.equal(hl[0].url, `${server.base}/l/${drag.code}`);
    const cyView = (await cy.get(`/api/v1/events/${week1.id}`)).data.event;
    assert.deepEqual([cyView.hostLists[0].isYours, cyView.hostLists[0].memberCount], [false, null]);
    assert.equal(cyView.joinableList, null);
    // Guests don't see hostLists.
    assert.equal((await ben.get(`/api/v1/events/${week1.id}`)).data.event.hostLists, null);
    // Again: nobody new to invite.
    assert.equal((await ana.put(`/api/v1/events/${week1.id}/lists/${drag.id}`)).data.invitedCount, 0);
    // Over or cancelled: nothing to invite to.
    past = await makeEvent(ana, { title: 'Last week' });
    cancelled = await makeEvent(ana, { title: 'Called off' });
    await ana.put(`/api/v1/events/${past.id}/lists/${drag.id}`);
    await ana.put(`/api/v1/events/${cancelled.id}/lists/${drag.id}`);
    server.setTimes(past.id, { startedAgoMs: 8 * DAY, overInMs: -7 * DAY });
    await ana.patch(`/api/v1/events/${cancelled.id}`, { status: 'cancelled' });
    const over = await ana.put(`/api/v1/events/${past.id}/lists/${drag.id}`);
    assert.deepEqual([over.status, over.data.reason], [409, 'event_over']);
    assert.equal((await ana.put(`/api/v1/events/${cancelled.id}/lists/${drag.id}`)).data.reason, 'event_cancelled');
  });

  await t.test('joining later: invited to the attached events still to come, in the same step', async () => {
    const r = await eve.post(`/api/v1/list-links/${drag.code}/join`);
    assert.equal(r.data.invitedTo, 1, 'week 1 only: not the past one, not the cancelled one');
    assert.equal(await guestStatus(week1.id, P.eve.id), 'invited');
    assert.equal(await guestStatus(past.id, P.eve.id), null);
    assert.equal(await guestStatus(cancelled.id, P.eve.id), null);
    const [n] = await notificationsAbout(eve, week1.id);
    assert.deepEqual([n.type, n.actor.id], ['invited', P.ana.id]);
    assert.ok((await friendIds(eve)).includes(P.ana.id), 'the invitation made them friends');
    const inv = (await eve.get('/api/v1/me/events/invitations')).data.events.map((e) => e.id);
    assert.deepEqual(inv, [week1.id]);
    // Someone who opted out of the owner's invitations joins, and nothing
    // else happens.
    await dee.del(`/api/v1/me/list-memberships/${drag.id}`);
    const d = await dee.post(`/api/v1/list-links/${drag.code}/join`);
    assert.deepEqual([d.status, d.data.invitedTo], [200, 0]);
    assert.equal(await guestStatus(week1.id, P.dee.id), null);
    assert.deepEqual(await notificationsAbout(dee, week1.id), []);
  });

  let cyList;
  await t.test('joinableList: one list a guest is not on, for guests and signed out; never hosts or the removed', async () => {
    const outside = await makeEvent(ana, { title: 'Open night' });
    await ana.put(`/api/v1/events/${outside.id}/lists/${drag.id}`);
    // A co-host's own list, attached first; the creator's still comes first.
    await ana.post(`/api/v1/events/${outside.id}/cohosts`, { personId: P.cy.id });
    cyList = (await cy.post('/api/v1/me/lists', { name: "Cy's crew" })).data.list;
    await ana.del(`/api/v1/events/${outside.id}/lists/${drag.id}`);
    await cy.put(`/api/v1/events/${outside.id}/lists/${cyList.id}`);
    await ana.put(`/api/v1/events/${outside.id}/lists/${drag.id}`);
    const gus = client(server, 'gus');
    await gus.put(`/api/v1/events/${outside.id}/rsvp`, { status: 'going' });
    const g = (await gus.get(`/api/v1/events/${outside.id}`)).data.event;
    assert.deepEqual(g.joinableList, { code: drag.code, name: drag.name, url: `${server.base}/l/${drag.code}`, owner: g.joinableList.owner });
    assert.equal(g.joinableList.owner.id, P.ana.id);
    assert.equal(g.hostLists, null);
    // On Ana's list: Cy's is next.
    assert.equal((await ben.get(`/api/v1/events/${outside.id}`)).data.event.joinableList.code, cyList.code);
    // Signed out: the same, for the /l/ page.
    assert.equal((await anon.get(`/api/v1/events/${outside.id}`)).data.event.joinableList.code, drag.code);
    // Hosts: hostLists, and nothing to join.
    const host = (await ana.get(`/api/v1/events/${outside.id}`)).data.event;
    assert.equal(host.joinableList, null);
    assert.deepEqual(host.hostLists.map((l) => [l.name, l.isYours, l.memberCount === null]), [["Cy's crew", false, true], [drag.name, true, false]]);
    // On both: nothing.
    await ben.post(`/api/v1/list-links/${cyList.code}/join`);
    assert.equal((await ben.get(`/api/v1/events/${outside.id}`)).data.event.joinableList, null);
    // Removed: nothing.
    await ana.put(`/api/v1/events/${outside.id}/removed/${P.fay.id}`);
    assert.equal((await fay.get(`/api/v1/events/${outside.id}`)).data.event.joinableList, null);
    // Lists of events don't carry it.
    const listed = (await gus.get('/api/v1/me/events/all')).data.events.find((e) => e.id === outside.id);
    assert.ok(listed && !('joinableList' in listed) && !('hostLists' in listed));

    // Taking lists off: a co-host can't take the creator's off; the
    // creator can take a co-host's; the owner their own (twice is fine).
    const no = await cy.del(`/api/v1/events/${outside.id}/lists/${drag.id}`);
    assert.deepEqual([no.status, no.data.reason], [403, 'not_your_list']);
    assert.equal((await ana.del(`/api/v1/events/${outside.id}/lists/${cyList.id}`)).status, 200);
    assert.equal((await cy.put(`/api/v1/events/${outside.id}/lists/${cyList.id}`)).status, 200);
    assert.equal((await cy.del(`/api/v1/events/${outside.id}/lists/${cyList.id}`)).status, 200);
    assert.equal((await cy.del(`/api/v1/events/${outside.id}/lists/${cyList.id}`)).status, 200, 'twice is fine');
    assert.equal((await ben.del(`/api/v1/events/${outside.id}/lists/${drag.id}`)).data.reason, 'hosts_only');
    // Detaching changes nobody's invitation, and later joiners aren't invited.
    assert.equal(await guestStatus(outside.id, P.ben.id), 'invited');
    // A co-host who stops hosting takes their lists off with them.
    await cy.put(`/api/v1/events/${outside.id}/lists/${cyList.id}`);
    await ana.del(`/api/v1/events/${outside.id}/cohosts/${P.cy.id}`);
    assert.deepEqual((await ana.get(`/api/v1/events/${outside.id}`)).data.event.hostLists.map((l) => l.id), [drag.id]);
    await ana.post(`/api/v1/events/${outside.id}/cohosts`, { personId: P.cy.id });
    assert.deepEqual((await ana.get(`/api/v1/events/${outside.id}`)).data.event.hostLists.map((l) => l.id), [drag.id], "and they don't come back");
    await dee.post(`/api/v1/list-links/${cyList.code}/join`);
    assert.equal(await guestStatus(outside.id, P.dee.id), null);
  });

  await t.test('deleting a list: gone for members and from events; its invitations stay', async () => {
    const temp = (await ana.post('/api/v1/me/lists', { name: 'Temp' })).data.list;
    await fay.post(`/api/v1/list-links/${temp.code}/join`);
    const e = await makeEvent(ana, { title: 'Temp party' });
    await ana.put(`/api/v1/events/${e.id}/lists/${temp.id}`);
    assert.equal((await ana.del(`/api/v1/me/lists/${temp.id}`)).status, 200);
    assert.equal((await ana.del(`/api/v1/me/lists/${temp.id}`)).data.reason, 'list_not_found');
    assert.ok(!(await fay.get('/api/v1/me/list-memberships')).data.lists.some((l) => l.id === temp.id));
    assert.equal((await anon.get(`/api/v1/list-links/${temp.code}`)).status, 404);
    assert.deepEqual((await ana.get(`/api/v1/events/${e.id}`)).data.event.hostLists, []);
    assert.equal(await guestStatus(e.id, P.fay.id), 'invited');
  });

  await t.test('limits: full lists, ten lists on an event, making lists, links that find nothing', async () => {
    // A list at 1,000 people turns the next away.
    const big = (await eve.post('/api/v1/me/lists', { name: 'Big' })).data.list;
    const db = server.db();
    const add = db.prepare('INSERT INTO list_members (list_id, person_id, joined_at) VALUES (?, ?, ?)');
    db.transaction(() => { for (let i = 0; i < 1000; i++) add.run(big.id, `ffffffff-0000-4000-8000-${String(i).padStart(12, '0')}`, i); })();
    const full = await ana.post(`/api/v1/list-links/${big.code}/join`);
    assert.deepEqual([full.status, full.data.reason], [409, 'list_full']);
    // Ten lists on an event.
    const e = await makeEvent(fay, { title: 'Lots of lists' });
    for (let i = 0; i < 11; i++) {
      const l = (await fay.post('/api/v1/me/lists', { name: `List ${i}` })).data.list;
      const r = await fay.put(`/api/v1/events/${e.id}/lists/${l.id}`);
      assert.equal(r.status, i < 10 ? 200 : 409);
      if (i === 10) assert.equal(r.data.reason, 'too_many_lists');
    }
    // Twenty new lists a person a day (Fay has made 11).
    let made = 11;
    let last;
    while (made < 20) { last = await fay.post('/api/v1/me/lists', { name: `More ${made}` }); made++; }
    assert.equal(last.status, 201);
    const over = await fay.post('/api/v1/me/lists', { name: 'One too many' });
    assert.deepEqual([over.status, over.data.reason], [429, 'rate_limited']);
    // List links that find nothing: 60 an hour an address, then even good
    // ones wait.
    const ip = { headers: { 'CF-Connecting-IP': '203.0.113.9' } };
    for (let i = 0; i < 60; i++) assert.equal((await anon.get(`/api/v1/list-links/ZZZZZZZZZZ${String(i).padStart(2, '0')}`, ip)).status, 404);
    const blocked = await anon.get(`/api/v1/list-links/${drag.code}`, ip);
    assert.deepEqual([blocked.status, blocked.data.reason], [429, 'rate_limited']);
    assert.equal((await anon.get(`/api/v1/list-links/${drag.code}`)).status, 200, 'other addresses are fine');
  });
});

test('suggested friends: most and most recent first, your own events counting double', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const P = server.people;
  const [ana, ben, cy, dee, eve] = ['ana', 'ben', 'cy', 'dee', 'eve'].map((n) => client(server, n));
  const at = (e, daysAgo) => server.setTimes(e.id, { startedAgoMs: daysAgo * DAY, overInMs: -(daysAgo * DAY - 3600e3) });

  // Ben: two of Ana's events, recent. Cy: one of Ana's, long ago. Dee: one
  // recent event of Eve's that Ana went to (not Ana's own). Eve: hosted
  // that one. Fay: only added.
  const a1 = await makeEvent(ana, { title: 'A1' });
  const a2 = await makeEvent(ana, { title: 'A2' });
  const a3 = await makeEvent(ana, { title: 'A3' });
  const e1 = await makeEvent(eve, { title: 'E1' });
  await ben.put(`/api/v1/events/${a1.id}/rsvp`, { status: 'going' });
  await ben.put(`/api/v1/events/${a2.id}/rsvp`, { status: 'going' });
  await cy.put(`/api/v1/events/${a3.id}/rsvp`, { status: 'going' });
  await ana.put(`/api/v1/events/${e1.id}/rsvp`, { status: 'going' });
  await dee.put(`/api/v1/events/${e1.id}/rsvp`, { status: 'going' });
  at(a1, 10); at(a2, 3); at(a3, 360); at(e1, 2);
  await ana.post('/api/v1/me/friends', { personId: P.fay.id });

  const r = await ana.get('/api/v1/me/friends/suggested');
  assert.equal(r.status, 200);
  const order = r.data.friends.map((f) => f.person.id);
  assert.deepEqual(order, [P.ben.id, P.dee.id, P.eve.id, P.fay.id, P.cy.id]);
  const score = Object.fromEntries(r.data.friends.map((f) => [f.person.id, f.score]));
  const fade = (days) => Math.pow(2, -days / 90);
  // Hosted by Ana: double. Not hers: single.
  assert.ok(Math.abs(score[P.ben.id] - 2 * (fade(10) + fade(3))) < 0.01, `ben ${score[P.ben.id]}`);
  assert.ok(Math.abs(score[P.dee.id] - fade(2)) < 0.01);
  assert.ok(Math.abs(score[P.cy.id] - 2 * fade(360)) < 0.01);
  assert.ok(Math.abs(score[P.fay.id] - 0.25) < 0.01, 'added just now: 0.25');
  assert.deepEqual(Object.keys(r.data.friends[0]).sort(), ['eventsInCommon', 'lastTogetherAt', 'person', 'score', 'source']);
  assert.deepEqual((await ana.get('/api/v1/me/friends/suggested?limit=2')).data.friends.map((f) => f.person.id), [P.ben.id, P.dee.id]);
  for (const bad of ['0', '51', 'x']) assert.equal((await ana.get(`/api/v1/me/friends/suggested?limit=${bad}`)).data.reason, 'bad_limit');
  // Someone taken out isn't suggested.
  await ana.del(`/api/v1/me/friends/${P.ben.id}`);
  assert.ok(!(await ana.get('/api/v1/me/friends/suggested')).data.friends.some((f) => f.person.id === P.ben.id));
  assert.equal((await client(server, null).get('/api/v1/me/friends/suggested')).status, 401);
});
