// You: /me (your own details and emailVerified), and your four lists of
// events, with what goes in each and paging through them.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, makeEvent } = require('./harness');

const HOUR = 3600e3;
const DAY = 24 * HOUR;

test('me', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const P = server.people;
  const [ana, ben, una] = ['ana', 'ben', 'una'].map((n) => client(server, n));
  const anon = client(server, null);
  const rsvp = (who, id, status) => who.put(`/api/v1/events/${id}/rsvp`, { status });
  const list = async (who, name, query = '') => (await who.get(`/api/v1/me/events/${name}${query}`)).data;
  const ids = (d) => d.events.map((e) => e.id);
  const inDays = (n) => new Date(Date.now() + n * DAY).toISOString();

  await t.test('/me: your own details, all of them', async () => {
    const r = await ana.get('/api/v1/me');
    assert.equal(r.status, 200);
    assert.deepEqual(r.data, {
      person: {
        id: P.ana.id, email: P.ana.email, firstName: 'Ana', lastName: 'Lima', shortName: 'Ana L',
        photoUrl: `${server.fake.base}/photo/${P.ana.id}?v=1`,
        phone: P.ana.phone, instagram: P.ana.instagram, venmo: P.ana.venmo, cashapp: P.ana.cashapp, emailVerified: true, findable: true
      },
      verifyUrl: null,
      hasHosted: false
    });
  });

  await t.test('/me: an unverified account says so, with where to verify', async () => {
    const r = await una.get('/api/v1/me');
    assert.equal(r.data.person.emailVerified, false);
    assert.ok(r.data.verifyUrl.startsWith(`${server.fake.base}/profile?verify=1&return=`));
    assert.equal((await anon.get('/api/v1/me')).status, 401);
  });

  await t.test('the four lists', async () => {
    const soon = await makeEvent(ana, { title: 'Soon', startsAt: inDays(1) });
    const later = await makeEvent(ana, { title: 'Later', startsAt: inDays(5) });
    const cancelled = await makeEvent(ana, { title: 'Off', startsAt: inDays(3) });
    const done = await makeEvent(ana, { title: 'Done', startsAt: inDays(2) });
    const longAgo = await makeEvent(ana, { title: 'Long ago', startsAt: inDays(2) });
    const bensInvite = await makeEvent(ana, { title: 'Invite', startsAt: inDays(4) });
    const bensOwn = await makeEvent(ben, { title: "Ben's", startsAt: inDays(6) });

    await rsvp(ben, soon.id, 'going');
    await rsvp(ben, later.id, 'maybe');
    await rsvp(ben, cancelled.id, 'going');
    await rsvp(ben, done.id, 'going');
    await rsvp(ben, longAgo.id, 'not_going');
    await ana.post(`/api/v1/events/${bensInvite.id}/invites`, { personIds: [P.ben.id] });
    await ana.post(`/api/v1/events/${cancelled.id}/invites`, { personIds: [P.una.id] });
    await ana.patch(`/api/v1/events/${cancelled.id}`, { status: 'cancelled' });
    server.setTimes(done.id, { startedAgoMs: 2 * DAY, overInMs: -DAY });
    server.setTimes(longAgo.id, { startedAgoMs: 9 * DAY, overInMs: -8 * DAY });

    // Hosting: not over, soonest first, cancelled ones included.
    assert.deepEqual(ids(await list(ana, 'hosting')), [soon.id, cancelled.id, bensInvite.id, later.id]);
    assert.deepEqual(ids(await list(ben, 'hosting')), [bensOwn.id]);
    // Upcoming: going or maybe, not over; a cancelled one stays so it shows as off.
    const up = await list(ben, 'upcoming');
    assert.deepEqual(ids(up), [soon.id, cancelled.id, later.id]);
    assert.equal(up.events[1].status, 'cancelled');
    // Invitations: no answer yet, not cancelled.
    assert.deepEqual(ids(await list(ben, 'invitations')), [bensInvite.id]);
    assert.deepEqual(ids(await list(una, 'invitations')), [], "a cancelled event's invitation isn't one");
    // Declined: can't go, not over, not cancelled.
    const declinedToo = await makeEvent(ana, { title: 'Nope', startsAt: inDays(7) });
    await rsvp(ben, declinedToo.id, 'not_going');
    assert.deepEqual(ids(await list(ben, 'declined')), [declinedToo.id], "can't go only; the done one is over");
    // Past: hosted, or going/maybe; most recent first.
    assert.deepEqual(ids(await list(ana, 'past')), [done.id, longAgo.id]);
    assert.deepEqual(ids(await list(ben, 'past')), [done.id], "can't go isn't having been");
    // Every list item is a whole event, as the caller sees it.
    const item = (await list(ben, 'upcoming')).events[0];
    assert.equal(item.viewer.rsvp.status, 'going');
    assert.equal(item.hosts[0].person.id, P.ana.id);
    assert.equal(item.friendsGoing, undefined);
    assert.equal((await anon.get('/api/v1/me/events/hosting')).status, 401);
  });

  await t.test('hasHosted: once you host or co-host anything, cancelled and past included', async () => {
    const eve = client(server, 'eve');
    const fay = client(server, 'fay');
    const hasHosted = async (who) => (await who.get('/api/v1/me')).data.hasHosted;
    assert.equal(await hasHosted(eve), false);
    assert.equal(await hasHosted(una), false, 'answering is not hosting');
    const e = await makeEvent(eve, { title: 'Eve hosts' });
    await eve.patch(`/api/v1/events/${e.id}`, { status: 'cancelled' });
    server.setTimes(e.id, { startedAgoMs: 9 * DAY, overInMs: -8 * DAY });
    assert.equal(await hasHosted(eve), true, 'cancelled and over still counts');
    // A co-host has hosted; stepping down from their only one takes it back.
    await fay.get('/api/v1/me');
    const party = await makeEvent(ana, { title: 'Co-hosted' });
    await ana.post(`/api/v1/events/${party.id}/cohosts`, { personId: P.fay.id });
    assert.equal(await hasHosted(fay), true);
    await fay.del(`/api/v1/events/${party.id}/cohosts/${P.fay.id}`);
    assert.equal(await hasHosted(fay), false);
  });

  await t.test('a page at a time, without repeats, however many there are', async () => {
    const dee = client(server, 'dee');
    const made = [];
    for (let i = 0; i < 13; i++) made.push((await makeEvent(dee, { title: `Night ${i}`, startsAt: inDays(10 + (i % 4)) })).id);
    const seen = [];
    let cursor = '';
    let pages = 0;
    do {
      const d = await list(dee, 'hosting', `?limit=5&cursor=${encodeURIComponent(cursor)}`);
      assert.ok(d.events.length <= 5);
      seen.push(...d.events);
      cursor = d.nextCursor;
      pages++;
    } while (cursor);
    assert.equal(pages, 3);
    assert.deepEqual(seen.map((e) => e.id).sort(), made.slice().sort());
    // In start order, ties by id.
    const keys = seen.map((e) => `${e.startsAt}|${e.id}`);
    assert.deepEqual(keys, keys.slice().sort());
    // The default page is 20; a bad cursor or limit is a 400.
    assert.equal((await list(dee, 'hosting')).events.length, 13);
    assert.equal((await dee.get('/api/v1/me/events/hosting?cursor=bm9wZQ')).data.reason, 'bad_cursor');
    assert.equal((await dee.get('/api/v1/me/friends?limit=abc')).data.reason, 'bad_limit');
  });
});
