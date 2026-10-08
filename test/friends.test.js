// Implicit friends: two people who were both at an event (hosting it, or
// "going") that has started and wasn't cancelled. "maybe" isn't being
// there, and neither is an event that hasn't happened yet.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, makeEvent } = require('./harness');

test('friends', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const P = server.people;
  const [ana, ben, cy, dee, eve, fay, una, gus] = ['ana', 'ben', 'cy', 'dee', 'eve', 'fay', 'una', 'gus'].map((n) => client(server, n));
  const rsvp = (who, id, status) => who.put(`/api/v1/events/${id}/rsvp`, { status });
  const friendsOf = async (who, query = '') => (await who.get(`/api/v1/me/friends${query}`)).data;
  const started = (id) => server.setTimes(id, { startedAgoMs: 2 * 3600e3, overInMs: 4 * 3600e3 });
  const over = (id) => server.setTimes(id, { startedAgoMs: 30 * 24 * 3600e3, overInMs: -29 * 24 * 3600e3 });

  // A dinner Ana hosted, last month: Ben and Eve went, Cy was a maybe,
  // Dee couldn't go.
  const dinner = await makeEvent(ana, { title: 'Dinner' });
  await rsvp(ben, dinner.id, 'going');
  await rsvp(eve, dinner.id, 'going');
  await rsvp(cy, dinner.id, 'maybe');
  await rsvp(dee, dinner.id, 'not_going');
  over(dinner.id);

  // Ana's party next week: Fay's going, but it hasn't happened.
  const party = await makeEvent(ana, { title: 'Party' });
  await rsvp(fay, party.id, 'going');

  // A picnic that started, but was cancelled: Dee was going.
  const picnic = await makeEvent(ana, { title: 'Picnic' });
  await rsvp(dee, picnic.id, 'going');
  await ana.patch(`/api/v1/events/${picnic.id}`, { status: 'cancelled' });
  started(picnic.id);

  // Ben's game night, on now: Ana and Una (unverified) are going.
  const games = await makeEvent(ben, { title: 'Games' });
  await rsvp(ana, games.id, 'going');
  await rsvp(una, games.id, 'going');
  started(games.id);

  await t.test('going and hosting count; maybe, not going, the future and the cancelled do not', async () => {
    const f = await friendsOf(ana);
    assert.deepEqual(f.friends.map((x) => [x.person.id, x.eventsInCommon]), [
      [P.ben.id, 2], // the dinner and game night
      [P.eve.id, 1],
      [P.una.id, 1]
    ].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
    assert.equal(f.nextCursor, null);
    assert.ok(f.friends.every((x) => x.lastTogetherAt));
    assert.ok(f.friends.every((x) => x.source === 'shared_events'));
    const ids = f.friends.map((x) => x.person.id);
    for (const not of [P.cy.id, P.dee.id, P.fay.id]) assert.ok(!ids.includes(not), not);
  });

  await t.test('it goes both ways, and guests at the same event are friends too', async () => {
    assert.deepEqual((await friendsOf(eve)).friends.map((x) => x.person.id).sort(), [P.ana.id, P.ben.id].sort());
    assert.deepEqual((await friendsOf(una)).friends.map((x) => x.person.id).sort(), [P.ana.id, P.ben.id].sort());
    assert.deepEqual((await friendsOf(cy)).friends, []);
    assert.deepEqual((await friendsOf(fay)).friends, []);
  });

  await t.test('once the party starts, Fay and Ana are friends', async () => {
    started(party.id);
    assert.ok((await friendsOf(fay)).friends.some((x) => x.person.id === P.ana.id));
    // And taking back the going takes it back.
    server.db().prepare("UPDATE rsvps SET status = 'maybe' WHERE event_id = ? AND person_id = ?").run(party.id, P.fay.id);
    assert.deepEqual((await friendsOf(fay)).friends, []);
  });

  await t.test('friends come a page at a time, most in common first', async () => {
    const seen = [];
    let cursor = '';
    do {
      const f = await friendsOf(ana, `?limit=1&cursor=${encodeURIComponent(cursor)}`);
      assert.ok(f.friends.length <= 1);
      seen.push(...f.friends.map((x) => x.person.id));
      cursor = f.nextCursor;
    } while (cursor);
    assert.equal(seen[0], P.ben.id);
    assert.deepEqual(seen.slice().sort(), [P.ben.id, P.eve.id, P.una.id].sort());
  });

  await t.test('a former member is left out', async () => {
    const wake = await makeEvent(dee, { title: 'Wake' });
    await rsvp(gus, wake.id, 'going');
    started(wake.id);
    assert.deepEqual((await friendsOf(dee)).friends.map((x) => x.person.id), [P.gus.id]);
    server.fake.deleted.add(P.gus.id);
    try {
      assert.deepEqual((await friendsOf(dee)).friends, []);
    } finally {
      server.fake.deleted.delete(P.gus.id);
    }
  });

  await t.test('friends going, on an event', async () => {
    const brunch = await makeEvent(fay, { title: 'Brunch', guestListVisibility: 'responded' });
    await rsvp(ben, brunch.id, 'going');
    await rsvp(eve, brunch.id, 'going');
    await rsvp(cy, brunch.id, 'going');
    // Ana's friends Ben and Eve are going (Cy isn't her friend). She hasn't
    // answered, and the list is 'responded': the count, not the names.
    let e = (await ana.get(`/api/v1/events/${brunch.id}`)).data.event;
    assert.deepEqual(e.friendsGoing, { count: 2, people: [] });
    await rsvp(ana, brunch.id, 'maybe');
    e = (await ana.get(`/api/v1/events/${brunch.id}`)).data.event;
    assert.equal(e.friendsGoing.count, 2);
    assert.deepEqual(e.friendsGoing.people.map((p) => p.id), [P.ben.id, P.eve.id]);
  });
});
