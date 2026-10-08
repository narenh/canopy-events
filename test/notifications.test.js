// Notifications: every trigger in docs/decisions.md section 5 lands in the
// right inboxes (and never the actor's), RSVPs to hosts fold together,
// the inbox pages and counts and marks read, and devices register, move
// between people, and get pushed to (the default sender logs, which is
// what these watch).

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, makeEvent } = require('./harness');

const token = (tag) => `${'f'.repeat(58)}${tag}`; // 64 characters, like APNs

test('notifications', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const P = server.people;
  const [ana, ben, cy, dee, eve, fay, una] = ['ana', 'ben', 'cy', 'dee', 'eve', 'fay', 'una'].map((n) => client(server, n));
  const rsvp = (who, id, status, guests = 0) => who.put(`/api/v1/events/${id}/rsvp`, { status, guests });
  const inbox = async (who, query = '') => (await who.get(`/api/v1/me/notifications${query}`)).data;
  const about = async (who, eventId) => (await inbox(who, '?limit=100')).notifications.filter((n) => n.event && n.event.id === eventId);
  const kinds = (list) => list.map((n) => n.type);
  // The default sender logs each push; wait for (or rule out) a line.
  const pushed = (line) => server.output().includes(line);
  async function waitForPush(line) {
    for (let i = 0; i < 50 && !pushed(line); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(pushed(line), `expected a push: ${line}\n${server.output().split('\n').filter((l) => l.includes('[push]')).join('\n')}`);
  }
  const settle = () => new Promise((r) => setTimeout(r, 150));

  for (const who of [ana, ben, cy, dee, eve, fay, una]) await who.get('/api/v1/me');

  await t.test('invited: the invitee hears, the host who invited does not', async () => {
    const e = await makeEvent(ana, { title: 'Invite test' });
    await ana.post(`/api/v1/events/${e.id}/invites`, { personIds: [P.ben.id, P.una.id] });
    const [n] = await about(ben, e.id);
    assert.equal(n.type, 'invited');
    assert.equal(n.actor.id, P.ana.id);
    assert.equal(n.read, false);
    assert.equal(n.count, 1);
    assert.deepEqual(n.event, { id: e.id, url: e.url, title: 'Invite test', startsAt: e.startsAt, timeZone: e.timeZone, status: 'active', coverImageUrl: null, themeHue: null, themeGrayscale: false });
    assert.equal((await about(una, e.id)).length, 1);
    assert.equal((await about(ana, e.id)).length, 0);
    // Inviting again (already on the list) says nothing new.
    await ana.post(`/api/v1/events/${e.id}/invites`, { personIds: [P.ben.id] });
    assert.equal((await about(ben, e.id)).length, 1);
  });

  await t.test("answers reach the hosts, folded together while unread", async () => {
    const e = await makeEvent(ana);
    await ana.post(`/api/v1/events/${e.id}/cohosts`, { personId: P.fay.id });
    await rsvp(ben, e.id, 'going');
    await rsvp(cy, e.id, 'maybe');
    await rsvp(dee, e.id, 'not_going');
    let [n] = await about(ana, e.id);
    assert.equal(n.type, 'rsvp');
    assert.equal(n.count, 3);
    assert.equal(n.actor.id, P.dee.id, 'the latest to answer');
    assert.deepEqual(n.details, { status: 'not_going' });
    // The co-host too, but not the creator about co-hosting (that was Fay's).
    assert.deepEqual(kinds(await about(fay, e.id)), ['rsvp', 'cohost_added']);
    // Nobody hears about their own answer.
    assert.equal((await about(ben, e.id)).length, 0);
    // A change of plus-ones alone isn't news.
    await ana.patch(`/api/v1/events/${e.id}`, { guestsAllowed: 2 });
    await rsvp(ben, e.id, 'going', 1);
    assert.equal((await about(ana, e.id))[0].count, 3);
    // Once read, the next answer starts a new one.
    await ana.post('/api/v1/me/notifications/read', { ids: [n.id] });
    await rsvp(eve, e.id, 'going');
    const list = await about(ana, e.id);
    assert.deepEqual(list.map((x) => [x.type, x.count, x.read]), [['rsvp', 1, false], ['rsvp', 3, true]]);
    [n] = list;
    assert.equal(n.actor.id, P.eve.id);
  });

  await t.test('time, place, cancelling: everyone coming and the other hosts, not the rest', async () => {
    const e = await makeEvent(ana, { capacity: 1 });
    await ana.post(`/api/v1/events/${e.id}/cohosts`, { personId: P.fay.id });
    await rsvp(ben, e.id, 'going');
    await rsvp(cy, e.id, 'going'); // waitlisted
    await rsvp(dee, e.id, 'maybe');
    await rsvp(eve, e.id, 'not_going');
    await ana.post(`/api/v1/events/${e.id}/invites`, { personIds: [P.una.id] });
    await fay.patch(`/api/v1/events/${e.id}`, { startsAt: '2031-05-01T19:00:00Z', locationName: 'Elsewhere' });
    for (const who of [ana, ben, cy, dee]) {
      const changed = (await about(who, e.id)).filter((n) => n.type === 'event_changed');
      assert.equal(changed.length, 1, who.person.name);
      assert.deepEqual(changed[0].details, { changed: ['time', 'place'] });
      assert.equal(changed[0].actor.id, P.fay.id);
    }
    for (const who of [eve, una, fay]) {
      assert.ok(!(await about(who, e.id)).some((n) => n.type === 'event_changed'), who.person.name);
    }
    // An edit that moves nothing says nothing.
    await ana.patch(`/api/v1/events/${e.id}`, { title: 'New name' });
    assert.equal((await about(ben, e.id)).filter((n) => n.type === 'event_changed').length, 1);
    await ana.patch(`/api/v1/events/${e.id}`, { status: 'cancelled' });
    await ana.patch(`/api/v1/events/${e.id}`, { status: 'active' });
    assert.deepEqual(kinds(await about(ben, e.id)).slice(0, 2), ['event_uncancelled', 'event_cancelled']);
    assert.deepEqual(kinds(await about(fay, e.id)).slice(0, 2), ['event_uncancelled', 'event_cancelled']);
    assert.ok(!kinds(await about(ana, e.id)).includes('event_cancelled'));
  });

  await t.test('made a co-host, and off the waitlist', async () => {
    const e = await makeEvent(ana, { capacity: 1 });
    await rsvp(ben, e.id, 'going');
    await rsvp(cy, e.id, 'going');
    await ana.post(`/api/v1/events/${e.id}/cohosts`, { personId: P.ben.id });
    const [made] = await about(ben, e.id);
    assert.equal(made.type, 'cohost_added');
    assert.equal(made.actor.id, P.ana.id);
    // Ben's spot went to Cy.
    const promoted = (await about(cy, e.id)).find((n) => n.type === 'waitlist_promoted');
    assert.equal(promoted.actor, null);
    assert.equal(promoted.details, null);
  });

  await t.test("a host's post reaches everyone coming; a guest's doesn't notify", async () => {
    const e = await makeEvent(ana);
    await rsvp(ben, e.id, 'going');
    await rsvp(cy, e.id, 'maybe');
    await rsvp(dee, e.id, 'not_going');
    await ben.post(`/api/v1/events/${e.id}/wall`, { text: 'Guest chatter' });
    assert.ok(!kinds(await about(cy, e.id)).includes('wall_post'));
    const entry = (await ana.post(`/api/v1/events/${e.id}/wall`, { text: `Parking is round the back. ${'x'.repeat(300)}` })).data.entry;
    for (const who of [ben, cy]) {
      const n = (await about(who, e.id)).find((x) => x.type === 'wall_post');
      assert.equal(n.details.entryId, entry.id);
      assert.equal(n.details.text.length, 200);
      assert.ok(n.details.text.startsWith('Parking is round the back.'));
    }
    assert.ok(!kinds(await about(dee, e.id)).includes('wall_post'));
    assert.ok(!kinds(await about(ana, e.id)).includes('wall_post'));
  });

  await t.test('the inbox: pages, unread count, mark read, mark all read', async () => {
    const host = client(server, server.fake.addPerson(300, 'hostess', 'Hostess', 'Withmany'));
    await host.get('/api/v1/me');
    for (let i = 0; i < 5; i++) {
      const e = await makeEvent(ben, { title: `Ben's ${i}` });
      await ben.post(`/api/v1/events/${e.id}/invites`, { personIds: [host.person.id] });
    }
    let page = await inbox(host, '?limit=2');
    assert.equal(page.unreadCount, 5);
    assert.deepEqual(page.notifications.map((n) => n.event.title), ["Ben's 4", "Ben's 3"]);
    const seen = [...page.notifications];
    while (page.nextCursor) {
      page = await inbox(host, `?limit=2&cursor=${encodeURIComponent(page.nextCursor)}`);
      seen.push(...page.notifications);
    }
    assert.equal(seen.length, 5);
    assert.equal(new Set(seen.map((n) => n.id)).size, 5);
    let r = await host.post('/api/v1/me/notifications/read', { ids: [seen[0].id, seen[1].id] });
    assert.deepEqual(r.data, { unreadCount: 3 });
    // Someone else's ids are ignored.
    const bens = (await inbox(ana)).notifications[0];
    r = await host.post('/api/v1/me/notifications/read', { ids: [bens.id] });
    assert.equal(r.data.unreadCount, 3);
    assert.deepEqual((await host.get('/api/v1/me/notifications/unread')).data, { unreadCount: 3 });
    for (const body of [{}, { ids: [] }, { ids: [1] }, { ids: ['abc'] }, { ids: Array.from({ length: 101 }, (_, i) => String(i + 1)) }]) {
      r = await host.post('/api/v1/me/notifications/read', body);
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 40));
      assert.equal(r.data.reason, 'bad_ids');
    }
    assert.deepEqual((await host.post('/api/v1/me/notifications/read-all')).data, { unreadCount: 0 });
    assert.ok((await inbox(host)).notifications.every((n) => n.read));
    assert.equal((await client(server, null).get('/api/v1/me/notifications')).status, 401);
  });

  await t.test('devices: registered, pushed to, deduplicated, moved, removed', async () => {
    const app = client(server, 'eve', { mode: 'bearer' });
    let r = await app.post('/api/v1/me/devices', { platform: 'ios', token: token('EVE001') });
    assert.deepEqual(r.data, { ok: true });
    // Again is fine.
    assert.equal((await app.post('/api/v1/me/devices', { platform: 'ios', token: token('EVE001') })).status, 200);
    await app.post('/api/v1/me/devices', { platform: 'android', token: 'fcm:APA91b-x_y.zEVE002' });
    const e = await makeEvent(ana, { title: 'Pushy' });
    await ana.post(`/api/v1/events/${e.id}/invites`, { personIds: [P.eve.id] });
    const [n] = await about(eve, e.id);
    await waitForPush(`[push] ios …EVE001 invited #${n.id}`);
    await waitForPush(`[push] android …EVE002 invited #${n.id}`);
    assert.equal(server.output().split(`invited #${n.id}`).length - 1, 2, 'once per phone, not per registration');
    assert.ok(!server.output().includes(token('EVE001')), 'tokens are never logged whole');

    // Fay signs in on Eve's iPhone: its pushes are Fay's now.
    await fay.post('/api/v1/me/devices', { platform: 'ios', token: token('EVE001') });
    await ana.post(`/api/v1/events/${e.id}/invites`, { personIds: [P.fay.id] });
    const [forFay] = await about(fay, e.id);
    await waitForPush(`[push] ios …EVE001 invited #${forFay.id}`);
    const e2 = await makeEvent(ana);
    await ana.post(`/api/v1/events/${e2.id}/invites`, { personIds: [P.eve.id] });
    const [eveAgain] = await about(eve, e2.id);
    await waitForPush(`[push] android …EVE002 invited #${eveAgain.id}`);
    assert.ok(!pushed(`[push] ios …EVE001 invited #${eveAgain.id}`));

    // Eve signs out on her Android phone; Eve can't remove Fay's iPhone.
    assert.deepEqual((await app.del('/api/v1/me/devices', { body: { token: 'fcm:APA91b-x_y.zEVE002' } })).data, { ok: true });
    assert.equal((await app.del('/api/v1/me/devices', { body: { token: token('EVE001') } })).status, 200);
    const e3 = await makeEvent(ana);
    await ana.post(`/api/v1/events/${e3.id}/invites`, { personIds: [P.eve.id, P.fay.id] });
    const [toFay] = await about(fay, e3.id);
    await waitForPush(`[push] ios …EVE001 invited #${toFay.id}`);
    const [toEve] = await about(eve, e3.id);
    await settle();
    assert.ok(!pushed(`invited #${toEve.id}`), 'Eve has no phones left');

    for (const [body, reason] of [[{ platform: 'windows', token: token('X00001') }, 'bad_platform'], [{ platform: 'ios', token: 'short' }, 'bad_token'],
      [{ platform: 'ios', token: 'has spaces in it, not a token' }, 'bad_token'], [{ platform: 'ios' }, 'bad_token']]) {
      r = await app.post('/api/v1/me/devices', body);
      assert.equal(r.status, 400);
      assert.equal(r.data.reason, reason);
    }
  });

  await t.test('at most 10 phones each: the oldest goes', async () => {
    const dev = client(server, 'dee', { mode: 'bearer' });
    for (let i = 0; i < 11; i++) await dev.post('/api/v1/me/devices', { platform: 'ios', token: token(`DEE${String(i).padStart(3, '0')}`) });
    const e = await makeEvent(ana);
    await ana.post(`/api/v1/events/${e.id}/invites`, { personIds: [P.dee.id] });
    const [n] = await about(dee, e.id);
    await waitForPush(`[push] ios …DEE010 invited #${n.id}`);
    await waitForPush(`[push] ios …DEE001 invited #${n.id}`);
    assert.ok(!pushed(`…DEE000 invited #${n.id}`));
  });
});
