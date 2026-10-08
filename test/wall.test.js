// The activity wall: who reads it (the guest list's rule), who posts
// (hosts, going, maybe, waitlisted), who deletes (authors their own, hosts
// anything), the server's own typed entries, newest-first paging, and the
// posting limit.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, makeEvent } = require('./harness');

const PUBLIC_FIELDS = ['firstName', 'id', 'lastName', 'photoUrl', 'shortName'];

test('the activity wall', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const P = server.people;
  const [ana, ben, cy, dee, eve, fay, una] = ['ana', 'ben', 'cy', 'dee', 'eve', 'fay', 'una'].map((n) => client(server, n));
  const anon = client(server, null);
  const rsvp = (who, id, status) => who.put(`/api/v1/events/${id}/rsvp`, { status });
  const post = (who, id, text) => who.post(`/api/v1/events/${id}/wall`, { text });
  const wall = async (who, id, query = '') => (await who.get(`/api/v1/events/${id}/wall${query}`)).data;
  const types = (w) => w.entries.map((x) => [x.type, x.person && x.person.firstName]);

  await t.test("reading follows the guest list's rule", async () => {
    const e = await makeEvent(ana, { guestListVisibility: 'responded' });
    await rsvp(ben, e.id, 'going');
    // Cy hasn't answered: nothing, but told so.
    let w = await wall(cy, e.id);
    assert.deepEqual(w, { wallVisible: false, entries: [], canPost: false, nextCursor: null });
    // Once he's answered, even can't go, he reads it.
    await rsvp(cy, e.id, 'not_going');
    w = await wall(cy, e.id);
    assert.equal(w.wallVisible, true);
    assert.deepEqual(types(w), [['going', 'Ben']]);
    assert.equal(w.canPost, false, "can't go reads but doesn't post");
    // Hosts always; signed out never.
    assert.equal((await wall(ana, e.id)).wallVisible, true);
    assert.equal((await anon.get(`/api/v1/events/${e.id}/wall`)).status, 401);
    // An 'everyone' event: anyone signed in reads it.
    const open = await makeEvent(ana);
    assert.equal((await wall(fay, open.id)).wallVisible, true);
  });

  await t.test('who posts: hosts, going, maybe and waitlisted; not invited or can\'t go', async () => {
    const e = await makeEvent(ana);
    await ana.post(`/api/v1/events/${e.id}/invites`, { personIds: [P.dee.id] });
    await rsvp(ben, e.id, 'going');
    await rsvp(una, e.id, 'maybe');
    await rsvp(cy, e.id, 'not_going');
    let r = await post(ana, e.id, 'Welcome!');
    assert.equal(r.status, 201, r.text);
    assert.equal(r.data.entry.type, 'post');
    assert.equal(r.data.entry.text, 'Welcome!');
    assert.equal(r.data.entry.person.id, P.ana.id);
    assert.deepEqual(Object.keys(r.data.entry.person).sort(), PUBLIC_FIELDS);
    assert.equal(r.data.entry.canDelete, true);
    assert.equal((await post(ben, e.id, 'Bringing cake')).status, 201);
    assert.equal((await post(una, e.id, 'Maybe!')).status, 201, 'unverified people post too');
    for (const who of [cy, dee, eve]) {
      r = await post(who, e.id, 'hi');
      assert.equal(r.status, 403, who.person.name);
      assert.equal(r.data.reason, 'answer_first');
    }
    assert.equal((await post(anon, e.id, 'hi')).status, 401);
    // The event says so in advance.
    assert.equal((await ben.get(`/api/v1/events/${e.id}`)).data.event.viewer.canPost, true);
    assert.equal((await cy.get(`/api/v1/events/${e.id}`)).data.event.viewer.canPost, false);
    // A cancelled event still takes posts.
    await ana.patch(`/api/v1/events/${e.id}`, { status: 'cancelled' });
    assert.equal((await post(ben, e.id, 'Next time!')).status, 201);
  });

  await t.test('what a post has to be', async () => {
    const e = await makeEvent(ana);
    for (const text of ['', '   ', 42, null, 'x'.repeat(1001)]) {
      const r = await ana.post(`/api/v1/events/${e.id}/wall`, { text });
      assert.equal(r.status, 400, String(text).slice(0, 10));
      assert.equal(r.data.reason, 'bad_text');
    }
    const r = await post(ana, e.id, '  line one\r\nline two <b>not html</b>  ');
    assert.equal(r.data.entry.text, 'line one\nline two <b>not html</b>');
    assert.equal((await post(ana, e.id, 'y'.repeat(1000))).status, 201);
  });

  await t.test("the server's own entries: going, time, place, cancelled, co-host", async () => {
    await fay.get('/api/v1/me');
    const e = await makeEvent(ana);
    await rsvp(ben, e.id, 'going');
    await rsvp(cy, e.id, 'going');
    await rsvp(dee, e.id, 'maybe');
    // Ben changes his mind and back: still one going entry, the newest.
    await rsvp(ben, e.id, 'maybe');
    await rsvp(ben, e.id, 'going');
    // Cy takes his answer back: his entry goes.
    await cy.del(`/api/v1/events/${e.id}/rsvp`);
    await ana.patch(`/api/v1/events/${e.id}`, { startsAt: '2031-03-01T20:00:00-08:00', endsAt: '2031-03-01T23:00:00-08:00' });
    await ana.patch(`/api/v1/events/${e.id}`, { locationName: 'The park', locationAddress: 'Dolores Park' });
    // An edit that doesn't move it, or change the place, says nothing.
    await ana.patch(`/api/v1/events/${e.id}`, { title: 'Renamed', startsAt: '2031-03-01T20:00:00-08:00' });
    await ana.post(`/api/v1/events/${e.id}/cohosts`, { personId: P.fay.id });
    await ana.patch(`/api/v1/events/${e.id}`, { status: 'cancelled' });
    await ana.patch(`/api/v1/events/${e.id}`, { status: 'active' });
    const w = await wall(dee, e.id);
    assert.deepEqual(types(w), [
      ['uncancelled', 'Ana'],
      ['cancelled', 'Ana'],
      ['cohost_added', 'Fay'],
      ['place_changed', 'Ana'],
      ['time_changed', 'Ana'],
      ['going', 'Ben']
    ]);
    const byType = Object.fromEntries(w.entries.map((x) => [x.type, x]));
    assert.deepEqual(byType.time_changed.details, { startsAt: '2031-03-02T04:00:00.000Z', endsAt: '2031-03-02T07:00:00.000Z', timeZone: 'America/Los_Angeles' });
    assert.deepEqual(byType.place_changed.details, { locationName: 'The park', locationAddress: 'Dolores Park' });
    assert.equal(byType.going.text, null);
    assert.equal(byType.going.details, null);
    assert.ok(w.entries.every((x) => x.canDelete === false), "a guest can't delete the server's entries");
    // A co-host who was going loses their going entry.
    const e2 = await makeEvent(ana);
    await rsvp(fay, e2.id, 'going');
    await ana.post(`/api/v1/events/${e2.id}/cohosts`, { personId: P.fay.id });
    assert.deepEqual(types(await wall(ana, e2.id)), [['cohost_added', 'Fay']]);
  });

  await t.test('deleting: authors their own posts, hosts anything', async () => {
    const e = await makeEvent(ana);
    await ana.post(`/api/v1/events/${e.id}/cohosts`, { personId: P.fay.id });
    await rsvp(ben, e.id, 'going');
    await rsvp(cy, e.id, 'going');
    const bens = (await post(ben, e.id, "Ben's")).data.entry;
    const cys = (await post(cy, e.id, "Cy's")).data.entry;
    const cyGoing = (await wall(ana, e.id)).entries.find((x) => x.type === 'going' && x.person.id === P.cy.id);
    // How Cy sees Ben's: not his to delete.
    assert.equal((await wall(cy, e.id)).entries.find((x) => x.id === bens.id).canDelete, false);
    let r = await cy.del(`/api/v1/events/${e.id}/wall/${bens.id}`);
    assert.equal(r.status, 403);
    assert.equal(r.data.reason, 'not_yours');
    // Nor his own going entry: only posts are anyone's own.
    assert.equal((await cy.del(`/api/v1/events/${e.id}/wall/${cyGoing.id}`)).data.reason, 'not_yours');
    assert.deepEqual((await ben.del(`/api/v1/events/${e.id}/wall/${bens.id}`)).data, { ok: true });
    r = await ben.del(`/api/v1/events/${e.id}/wall/${bens.id}`);
    assert.equal(r.status, 404);
    assert.equal(r.data.reason, 'entry_not_found');
    // A co-host deletes anyone's post, and the server's entries.
    assert.equal((await fay.del(`/api/v1/events/${e.id}/wall/${cys.id}`)).status, 200);
    assert.equal((await ana.del(`/api/v1/events/${e.id}/wall/${cyGoing.id}`)).status, 200);
    // An id from another event, or not an id, is not on this wall.
    const other = await makeEvent(ana);
    const elsewhere = (await post(ana, other.id, 'elsewhere')).data.entry;
    assert.equal((await ana.del(`/api/v1/events/${e.id}/wall/${elsewhere.id}`)).data.reason, 'entry_not_found');
    assert.equal((await ana.del(`/api/v1/events/${e.id}/wall/abc`)).data.reason, 'entry_not_found');
  });

  await t.test('newest first, a page at a time', async () => {
    const e = await makeEvent(eve);
    const texts = Array.from({ length: 5 }, (_, i) => `post ${i}`);
    for (const text of texts) await post(eve, e.id, text);
    const seen = [];
    let cursor = '';
    let pages = 0;
    do {
      const w = await wall(eve, e.id, `?limit=2&cursor=${encodeURIComponent(cursor)}`);
      assert.ok(w.entries.length <= 2);
      seen.push(...w.entries.map((x) => x.text));
      cursor = w.nextCursor;
      pages++;
    } while (cursor);
    assert.equal(pages, 3);
    assert.deepEqual(seen, texts.slice().reverse());
    assert.equal((await eve.get(`/api/v1/events/${e.id}/wall?cursor=zzz`)).data.reason, 'bad_cursor');
  });

  await t.test('5 posts a minute per person', async () => {
    const e = await makeEvent(dee);
    // Dee has posted none yet in this file.
    for (let i = 0; i < 5; i++) assert.equal((await post(dee, e.id, `${i}`)).status, 201);
    const r = await post(dee, e.id, 'one too many');
    assert.equal(r.status, 429);
    assert.equal(r.data.reason, 'rate_limited');
  });
});
