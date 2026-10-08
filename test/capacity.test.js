// Capacity and the waitlist: going plus plus-ones never past the cap; a
// "going" that doesn't fit is waitlisted (and the answer says so); a freed
// spot goes to the earliest waitlisted answer that fits, with a wall
// entry; lowering the cap bumps nobody. Then the edges: many answers at
// once, and a promotion that fails taking its whole change back with it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer, client, makeEvent } = require('./harness');
const { init } = require('../lib/db');

test('capacity and the waitlist', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const P = server.people;
  const [ana, ben, cy, dee, eve, fay, una] = ['ana', 'ben', 'cy', 'dee', 'eve', 'fay', 'una'].map((n) => client(server, n));
  const rsvp = (who, id, status, guests = 0) => who.put(`/api/v1/events/${id}/rsvp`, { status, guests });
  const event = async (id) => (await ana.get(`/api/v1/events/${id}`)).data.event;
  const statusOf = async (who, id) => (await who.get(`/api/v1/events/${id}`)).data.event.viewer.rsvp.status;

  await t.test('capacity is 1 to 10,000, or null', async () => {
    const e = await makeEvent(ana, { capacity: 10 });
    assert.equal(e.capacity, 10);
    assert.equal(e.spotsLeft, 10);
    for (const bad of [0, -1, 10001, 2.5, '5']) {
      assert.equal((await ana.patch(`/api/v1/events/${e.id}`, { capacity: bad })).data.reason, 'bad_capacity', String(bad));
    }
    const r = await ana.patch(`/api/v1/events/${e.id}`, { capacity: null });
    assert.equal(r.data.event.capacity, null);
    assert.equal(r.data.event.spotsLeft, null);
  });

  await t.test('past the cap, going becomes waitlisted; freed spots go to the earliest that fits', async () => {
    const e = await makeEvent(ana, { capacity: 4, guestsAllowed: 2 });
    assert.equal((await rsvp(ben, e.id, 'going', 1)).data.waitlisted, false);
    await rsvp(cy, e.id, 'going', 1);
    let ev = await event(e.id);
    assert.equal(ev.counts.total.going, 4);
    assert.equal(ev.spotsLeft, 0);
    // Full: Dee is waitlisted, and the answer says so.
    let r = await rsvp(dee, e.id, 'going');
    assert.equal(r.status, 200);
    assert.equal(r.data.waitlisted, true);
    assert.equal(r.data.event.viewer.rsvp.status, 'waitlisted');
    // Eve, with two guests, behind her.
    assert.equal((await rsvp(eve, e.id, 'going', 2)).data.waitlisted, true);
    // Maybe isn't capped.
    assert.equal((await rsvp(fay, e.id, 'maybe', 2)).data.waitlisted, false);
    // Ben asks for one more guest than there's room for: refused, keeps his spot.
    r = await rsvp(ben, e.id, 'going', 2);
    assert.equal(r.status, 409);
    assert.equal(r.data.reason, 'no_room');
    assert.equal((await ben.get(`/api/v1/events/${e.id}`)).data.event.viewer.rsvp.guests, 1);

    // Cy can't go after all (2 spots): Dee fits (1), Eve (3) doesn't.
    await rsvp(cy, e.id, 'not_going');
    assert.equal(await statusOf(cy, e.id), 'not_going');
    assert.equal(await statusOf(dee, e.id), 'going');
    assert.equal(await statusOf(eve, e.id), 'waitlisted');
    const wall = (await ana.get(`/api/v1/events/${e.id}/wall`)).data.entries;
    assert.deepEqual([wall[0].type, wall[0].person.id], ['off_waitlist', P.dee.id]);
    // Ben brings fewer guests (1 more spot, 2 free): still not enough for Eve.
    await rsvp(ben, e.id, 'going', 0);
    assert.equal(await statusOf(eve, e.id), 'waitlisted');
    // A higher cap makes room for her.
    await ana.patch(`/api/v1/events/${e.id}`, { capacity: 5 });
    assert.equal(await statusOf(eve, e.id), 'going');
    ev = await event(e.id);
    assert.equal(ev.counts.total.going, 5);
    assert.equal(ev.counts.waitlisted, 0);
  });

  await t.test('lowering the cap bumps nobody; new answers wait', async () => {
    const e = await makeEvent(ana, { capacity: 10 });
    for (const who of [ben, cy, dee]) await rsvp(who, e.id, 'going');
    let r = await ana.patch(`/api/v1/events/${e.id}`, { capacity: 1 });
    assert.equal(r.data.event.counts.going, 3, 'nobody bumped');
    assert.equal(r.data.event.spotsLeft, 0);
    assert.equal((await rsvp(eve, e.id, 'going')).data.waitlisted, true);
    // One leaving isn't enough to get under the cap again.
    await rsvp(dee, e.id, 'maybe');
    assert.equal(await statusOf(eve, e.id), 'waitlisted');
    // No cap: everyone waiting gets in.
    await ana.patch(`/api/v1/events/${e.id}`, { capacity: null });
    assert.equal(await statusOf(eve, e.id), 'going');
  });

  await t.test('a waitlisted answer keeps its place when it changes plus-ones', async () => {
    const e = await makeEvent(ana, { capacity: 1, guestsAllowed: 3 });
    await rsvp(ben, e.id, 'going');
    await rsvp(cy, e.id, 'going', 1);
    await rsvp(dee, e.id, 'going');
    await rsvp(cy, e.id, 'going', 0); // Cy, still first in line
    await rsvp(ben, e.id, 'not_going');
    assert.equal(await statusOf(cy, e.id), 'going');
    assert.equal(await statusOf(dee, e.id), 'waitlisted');
  });

  await t.test('a big party is passed over for a smaller one that fits, and stays first for the next spot', async () => {
    const e = await makeEvent(ana, { capacity: 3, guestsAllowed: 3 });
    await rsvp(ben, e.id, 'going', 2);
    await rsvp(cy, e.id, 'going', 2); // needs 3: waitlisted
    await rsvp(dee, e.id, 'going'); // needs 1: waitlisted
    await rsvp(ben, e.id, 'going', 1); // frees 1: Dee fits, Cy doesn't
    assert.equal(await statusOf(dee, e.id), 'going');
    assert.equal(await statusOf(cy, e.id), 'waitlisted');
    await rsvp(ben, e.id, 'not_going'); // 2 free: still not Cy
    assert.equal(await statusOf(cy, e.id), 'waitlisted');
    await rsvp(dee, e.id, 'not_going'); // 3 free: Cy, first in line all along
    assert.equal(await statusOf(cy, e.id), 'going');
  });

  await t.test('a cancelled event promotes nobody until it is back on', async () => {
    const e = await makeEvent(ana, { capacity: 1 });
    await rsvp(ben, e.id, 'going');
    await rsvp(cy, e.id, 'going');
    await ana.patch(`/api/v1/events/${e.id}`, { status: 'cancelled' });
    await ana.patch(`/api/v1/events/${e.id}`, { capacity: 5 });
    assert.equal(await statusOf(cy, e.id), 'waitlisted');
    await ana.patch(`/api/v1/events/${e.id}`, { status: 'active' });
    assert.equal(await statusOf(cy, e.id), 'going');
  });

  await t.test('making a going guest a co-host frees their spot', async () => {
    await fay.get('/api/v1/me');
    const e = await makeEvent(ana, { capacity: 1 });
    await rsvp(fay, e.id, 'going');
    await rsvp(una, e.id, 'going');
    await ana.post(`/api/v1/events/${e.id}/cohosts`, { personId: P.fay.id });
    assert.equal(await statusOf(una, e.id), 'going');
  });

  await t.test('many answers at once never pass the cap', async () => {
    const crowd = Array.from({ length: 12 }, (_, i) => server.fake.addPerson(200 + i, `crowd${i}`, `Crowd${i}`, 'Member'));
    const callers = crowd.map((p) => client(server, p.name, { mode: 'bearer' }));
    const e = await makeEvent(ana, { capacity: 7, guestsAllowed: 1 });
    const answers = await Promise.all(callers.map((c, i) => rsvp(c, e.id, 'going', i % 2)));
    assert.ok(answers.every((r) => r.status === 200));
    let ev = await event(e.id);
    assert.ok(ev.counts.total.going <= 7, JSON.stringify(ev.counts));
    assert.equal(ev.counts.going + ev.counts.waitlisted, 12);
    assert.equal(answers.filter((r) => r.data.waitlisted).length, ev.counts.waitlisted);
    // Everyone going says they can't go at once, while the waitlist
    // changes its mind.
    const going = callers.filter((c, i) => !answers[i].data.waitlisted);
    const waiting = callers.filter((c, i) => answers[i].data.waitlisted);
    await Promise.all([
      ...going.map((c) => rsvp(c, e.id, 'not_going')),
      ...waiting.map((c, i) => rsvp(c, e.id, 'going', (i + 1) % 2))
    ]);
    ev = await event(e.id);
    assert.ok(ev.counts.total.going <= 7, JSON.stringify(ev.counts));
    // They're still on the list, as can't go.
    assert.equal(ev.counts.notGoing, going.length, JSON.stringify(ev.counts));
    assert.equal(ev.counts.going + ev.counts.waitlisted, waiting.length, JSON.stringify(ev.counts));
    // And nobody still waiting would fit.
    const list = (await ana.get(`/api/v1/events/${e.id}/guests?status=waitlisted`)).data.guests;
    assert.ok(list.every((g) => 1 + g.guests > ev.spotsLeft), JSON.stringify({ spotsLeft: ev.spotsLeft, list }));
  });
});

test('a promotion that fails takes the whole change back with it', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-events-waitlist-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = init({ file: path.join(dir, 'events.db'), snapshots: false });
  t.after(() => store.db.close());
  const [a, b, c] = ['a', 'b', 'c'].map((x) => `00000000-0000-4000-8000-${x.repeat(12)}`);
  const host = '00000000-0000-4000-8000-000000000001';
  store.createEvent('CAPCAPCAPCAP', host, {
    title: 'Tight', description: null, startsAt: Date.now() + 86400e3, endsAt: null, overAt: Date.now() + 2 * 86400e3,
    timeZone: 'UTC', locationName: null, locationAddress: null, guestListVisibility: 'everyone', guestsAllowed: 0, capacity: 1
  });
  assert.equal(store.setAnswer('CAPCAPCAPCAP', a, 'going').outcome, 'saved');
  assert.equal(store.setAnswer('CAPCAPCAPCAP', b, 'going').outcome, 'waitlisted');
  // The wall refuses the "got a spot" entry, so promoting B fails...
  store.db.exec(`CREATE TRIGGER no_promotions BEFORE INSERT ON wall WHEN NEW.type = 'off_waitlist'
                 BEGIN SELECT RAISE(ABORT, 'refused'); END`);
  assert.throws(() => store.setAnswer('CAPCAPCAPCAP', a, 'not_going'), /refused/);
  // ...and A's "can't go" is undone with it: nobody lost a spot or got one
  // without it being on the wall.
  assert.equal(store.getRsvp('CAPCAPCAPCAP', a).status, 'going');
  assert.equal(store.getRsvp('CAPCAPCAPCAP', b).status, 'waitlisted');
  assert.equal(store.listWall('CAPCAPCAPCAP', { limit: 10 }).filter((w) => w.type === 'going').length, 1);
  store.db.exec('DROP TRIGGER no_promotions');
  assert.deepEqual(store.setAnswer('CAPCAPCAPCAP', a, 'not_going').promoted, [b]);
  // A third answer, with one spot and B in it: waitlisted.
  assert.equal(store.setAnswer('CAPCAPCAPCAP', c, 'going').outcome, 'waitlisted');
});
