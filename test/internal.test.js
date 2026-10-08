// /api/internal (routes/internal.js): the account service's test people
// tools. Only its signed requests get in (the shared client's signer,
// bound to purpose, method, path and body, a minute, once); the admin and
// the test people become friends both ways, and again changes nothing;
// past test events give the admin history (Suggested) without a word to
// anyone; and all of it comes off again, leaving real events alone.
// Every answer also goes through the harness's leak walker.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { startServer, client, makeEvent, asAccountService, internalAuth, calendarAuth } = require('./harness');

const DAY = 86400e3;
const uuid = () => crypto.randomUUID();

// The fixtures, plus a crowd of "test people" the fake account service
// knows (so they show up in friends lists).
function crowd(server, n) {
  return Array.from({ length: n }, (_, i) => server.fake.addPerson(300 + i, `test${i}`, `Test${i}`, 'Person'));
}

test('only the account service, signed for exactly this, gets in', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const P = server.people;
  const url = '/api/internal/test-friends';
  const body = { personId: P.ana.id, friendIds: [P.ben.id] };
  const send = (opts) => asAccountService(server, 'POST', url, body, { purpose: 'test-friends', ...opts });

  const refused = {
    'no signature': { auth: null },
    'the wrong secret': { secret: 'cnc_not-it' },
    'two minutes old': { at: Date.now() - 2 * 60e3 },
    'two minutes ahead': { at: Date.now() + 2 * 60e3 },
    'signed for test events': { purpose: 'test-events' },
    'a calendar signature': { auth: calendarAuth(P.ana.id) },
    'a calendar signature, as an internal one': { auth: calendarAuth(P.ana.id).replace('Canopy-Calendar', 'Canopy-Internal') },
    "the site's own key": { auth: 'Bearer cnp_test-site-key' },
    "a person's token": { auth: `Bearer ${P.ana.token}` },
    'malformed': { auth: 'Canopy-Internal t=now, sig=nope' },
    'with no n': { auth: internalAuth(server, { purpose: 'test-friends', method: 'POST', url, body }).replace(/n=[0-9a-f]+, /, '') }
  };
  // Refused: a 401 from the route, or for a request that has no
  // Canopy-Internal or Bearer header and no Origin, the Origin check's 403
  // before it.
  for (const [what, opts] of Object.entries(refused)) {
    const r = await send(opts);
    assert.ok([401, 403].includes(r.status), `${what}: ${r.status}`);
    assert.ok(['unauthorized', 'bad_origin'].includes(r.data.reason), what);
  }
  // Signed for another body, another path or another method.
  const other = internalAuth(server, { purpose: 'test-friends', method: 'POST', url, body: { personId: P.ana.id, friendIds: [P.cy.id] } });
  assert.equal((await send({ auth: other })).status, 401, 'another body');
  const removeSig = internalAuth(server, { purpose: 'test-friends', method: 'POST', url: '/api/internal/test-friends/remove', body });
  assert.equal((await send({ auth: removeSig })).status, 401, 'another path');
  const deleteSig = internalAuth(server, { purpose: 'test-events', method: 'DELETE', url: '/api/internal/test-events' });
  assert.equal((await asAccountService(server, 'POST', '/api/internal/test-events', undefined, { auth: deleteSig })).status, 401, 'another method');
  // An internal signature is no use on the calendar either.
  const asCal = await client(server, null).get(`/api/calendar/${P.ana.id}`, {
    headers: { Authorization: internalAuth(server, { purpose: 'test-friends', method: 'GET', url: `/api/calendar/${P.ana.id}` }) }
  });
  assert.equal(asCal.status, 401);
  // Signed in as Ana, with her cookie or her app's token, is no.
  for (const mode of ['cookie', 'bearer']) assert.equal((await client(server, 'ana', { mode }).post(url, body)).status, 401, mode);
  assert.equal(server.db().prepare('SELECT COUNT(*) AS n FROM friend_edges').get().n, 0, 'nothing was made');

  // The real thing works, with no Origin, 50 seconds either way of now.
  const good = internalAuth(server, { purpose: 'test-friends', method: 'POST', url, body, at: Date.now() - 50e3 });
  const ok = await send({ auth: good });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  // Once.
  const replayed = await send({ auth: good });
  assert.equal(replayed.status, 401, 'a replay');
  // The same request signed again (a double click) is a new one.
  assert.equal((await send({})).status, 200);
  assert.equal((await send({})).status, 200);
  assert.equal((await send({ at: Date.now() + 50e3 })).status, 200);

  // Anything else under /api/internal is a JSON 404, which the account
  // service takes as "this site doesn't do that".
  const missing = await asAccountService(server, 'POST', '/api/internal/nothing', {}, { purpose: 'test-friends' });
  assert.equal(missing.status, 404);
  assert.equal(missing.data.reason, 'not_found');
});

test('without the calendar secret, nothing gets in', async (t) => {
  const server = await startServer({ CANOPY_CALENDAR_SECRET: '' });
  t.after(() => server.stop());
  const P = server.people;
  const r = await asAccountService(server, 'POST', '/api/internal/test-friends', { personId: P.ana.id, friendIds: [P.ben.id] }, { purpose: 'test-friends' });
  assert.equal(r.status, 401);
});

test('test friends: both ways, idempotent, capped, and gone again', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const P = server.people;
  const testers = crowd(server, 6);
  const ids = testers.map((p) => p.id);
  const befriend = (friendIds, personId = P.ana.id) => asAccountService(server, 'POST', '/api/internal/test-friends', { personId, friendIds }, { purpose: 'test-friends' });
  const ana = client(server, 'ana');
  const listOf = async (who) => (await client(server, who).get('/api/v1/me/friends?limit=100')).data.friends.map((f) => f.person.id);

  const first = await befriend(ids);
  assert.equal(first.status, 200, first.text);
  assert.deepEqual(first.data, { added: 6, alreadyFriends: 0 });
  // Ana has every one of them, as a friend link would ('link')...
  const mine = (await ana.get('/api/v1/me/friends?limit=100')).data.friends;
  assert.deepEqual(mine.map((f) => f.person.id).sort(), ids.slice().sort());
  assert.ok(mine.every((f) => f.source === 'link' && f.eventsInCommon === 0), JSON.stringify(mine[0]));
  // ...and every one of them has Ana.
  for (const p of testers) assert.deepEqual(await listOf(p.name), [P.ana.id], p.name);
  // Ben, a real person, is in nobody's list.
  assert.deepEqual(await listOf('ben'), []);

  // Again: nothing new. Her own id, and the same id twice, count once or not at all.
  assert.deepEqual((await befriend([...ids, ids[0], P.ana.id])).data, { added: 0, alreadyFriends: 6 });
  // Someone she took out comes back (she asked for all of them), and so
  // does she, for one who'd taken her out.
  assert.equal((await ana.del(`/api/v1/me/friends/${ids[0]}`)).status, 200);
  assert.equal((await client(server, testers[1].name).del(`/api/v1/me/friends/${P.ana.id}`)).status, 200);
  assert.deepEqual((await befriend(ids)).data, { added: 2, alreadyFriends: 4 });
  assert.equal((await listOf('ana')).length, 6);
  assert.deepEqual(await listOf(testers[1].name), [P.ana.id]);

  // 200 at most; anything that isn't a list of ids is refused.
  const many = Array.from({ length: 200 }, uuid);
  assert.deepEqual((await befriend(many, P.ben.id)).data, { added: 200, alreadyFriends: 0 });
  const tooMany = await befriend([...many, uuid()], P.ben.id);
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.data.reason, 'too_many_ids');
  for (const bad of [[], 'x', [42], ['not-an-id'], null]) {
    const r = await befriend(bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal(r.data.reason, 'bad_ids');
  }
  assert.equal((await befriend(ids, 'nope')).data.reason, 'bad_person_id');

  // Taking them away before they're deleted: every edge either way, and
  // any hiding, of those ids only.
  const removed = await asAccountService(server, 'POST', '/api/internal/test-friends/remove', { personIds: ids }, { purpose: 'test-friends' });
  assert.equal(removed.status, 200, removed.text);
  assert.equal(removed.data.removed, 12);
  assert.deepEqual(await listOf('ana'), []);
  for (const p of testers) assert.deepEqual(await listOf(p.name), []);
  assert.equal(server.db().prepare('SELECT COUNT(*) AS n FROM friend_edges').get().n, 400, "Ben's 200 both ways stay");
});

test('test events: past, marked, with the admin on each; Suggested has scores; nobody is told; and they all come off', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const P = server.people;
  const testers = crowd(server, 20);
  const ids = testers.map((p) => p.id);
  const ana = client(server, 'ana');
  const db = server.db();
  // A real event, before and after, which nothing here touches.
  const real = await makeEvent(ana, { title: 'Real one' });
  await client(server, 'ben').put(`/api/v1/events/${real.id}/rsvp`, { status: 'going' });
  const realRow = () => db.prepare('SELECT * FROM events WHERE id = ?').get(real.id);
  const realBefore = realRow();
  const counts = () => ({
    notifications: db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n,
    wall: db.prepare('SELECT COUNT(*) AS n FROM wall').get().n,
    hosted: db.prepare('SELECT COUNT(*) AS n FROM hosted_people').get().n
  });
  const before = counts();
  const make = (body) => asAccountService(server, 'POST', '/api/internal/test-events', body, { purpose: 'test-events' });

  for (const [body, reason] of [
    [{ personId: P.ana.id, testPeopleIds: ids, count: 0 }, 'bad_count'],
    [{ personId: P.ana.id, testPeopleIds: ids, count: 21 }, 'bad_count'],
    [{ personId: P.ana.id, testPeopleIds: ids, count: '6' }, 'bad_count'],
    [{ personId: P.ana.id, testPeopleIds: [], count: 6 }, 'bad_ids'],
    [{ personId: P.ana.id, testPeopleIds: [P.ana.id], count: 6 }, 'bad_ids'],
    [{ personId: 'x', testPeopleIds: ids, count: 6 }, 'bad_person_id']
  ]) {
    const r = await make(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.data.reason, reason);
  }

  const made = await make({ personId: P.ana.id, testPeopleIds: ids, count: 6 });
  assert.equal(made.status, 200, made.text);
  assert.deepEqual(made.data, { created: 6 });

  const now = Date.now();
  const rows = db.prepare('SELECT * FROM events WHERE is_test = 1 ORDER BY starts_at').all();
  assert.equal(rows.length, 6);
  const hostedByAna = rows.filter((e) => db.prepare('SELECT 1 FROM hosts WHERE event_id = ? AND person_id = ?').get(e.id, P.ana.id));
  assert.equal(hostedByAna.length, 3, 'every other one is hers');
  for (const e of rows) {
    assert.ok(e.over_at <= now && e.ends_at <= now, 'over');
    assert.ok(e.starts_at > now - 181 * DAY, 'in the last six months');
    assert.equal(e.theme_grayscale, 1);
    assert.equal(e.cover_key, null);
    assert.match(e.description, /made-up event with test people/);
    const hosts = db.prepare('SELECT person_id FROM hosts WHERE event_id = ?').all(e.id).map((h) => h.person_id);
    assert.equal(hosts.length, 1);
    const answers = db.prepare('SELECT person_id, status FROM rsvps WHERE event_id = ?').all(e.id);
    const anaThere = hosts.includes(P.ana.id) || answers.some((a) => a.person_id === P.ana.id && ['going', 'maybe'].includes(a.status));
    assert.ok(anaThere, 'Ana is on each');
    assert.ok(answers.length >= 2);
    assert.ok(answers.every((a) => a.person_id === P.ana.id || ids.includes(a.person_id)), 'only Ana and test people');
  }
  const spread = rows[rows.length - 1].starts_at - rows[0].starts_at;
  assert.ok(spread > 60 * DAY, 'spread over months');
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM rsvps r JOIN events e ON e.id = r.event_id WHERE e.is_test = 1 AND r.status = 'maybe'").get().n > 0, 'some maybes');

  // In her Past tab, after nothing else (they're older than the real one,
  // which hasn't happened).
  const past = (await ana.get('/api/v1/me/events/past?limit=50')).data.events;
  assert.deepEqual(past.map((e) => e.id).sort(), rows.map((e) => e.public_id).sort());
  // Suggested: scores, best first, not all the same.
  const suggested = (await ana.get('/api/v1/me/friends/suggested?limit=50')).data.friends;
  assert.ok(suggested.length >= 5, `${suggested.length} suggested`);
  assert.ok(suggested.every((f) => f.score > 0));
  assert.ok(suggested.every((f, i) => i === 0 || suggested[i - 1].score >= f.score), 'best first');
  assert.ok(new Set(suggested.map((f) => f.score)).size >= 3, `varied: ${suggested.map((f) => f.score)}`);
  assert.ok(suggested.every((f) => ids.includes(f.person.id)));
  // Nobody was told, nothing went on any Updates, and nobody "has hosted".
  assert.deepEqual(counts(), before);
  assert.deepEqual((await client(server, testers[0].name).get('/api/v1/me/notifications')).data.notifications, []);
  // And none of it is in her calendar: only the real event.
  const cal = await client(server, null).get(`/api/calendar/${P.ana.id}`, { headers: { Authorization: calendarAuth(P.ana.id) } });
  assert.deepEqual(cal.data.entries.map((e) => e.title), ['Real one']);

  // At most 100 at once.
  for (let i = 0; i < 4; i++) assert.equal((await make({ personId: P.ana.id, testPeopleIds: ids, count: 20 })).status, 200);
  assert.equal((await make({ personId: P.ana.id, testPeopleIds: ids, count: 15 })).status, 409);
  assert.equal((await make({ personId: P.ana.id, testPeopleIds: ids, count: 14 })).status, 200);

  // All of them go, with their answers, and the real event stays as it was.
  const gone = await asAccountService(server, 'DELETE', '/api/internal/test-events', undefined, { purpose: 'test-events' });
  assert.equal(gone.status, 200, gone.text);
  assert.deepEqual(gone.data, { deleted: 100 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events WHERE is_test = 1').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rsvps WHERE event_id NOT IN (SELECT id FROM events)').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM hosts WHERE event_id NOT IN (SELECT id FROM events)').get().n, 0);
  assert.deepEqual(realRow(), realBefore);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rsvps WHERE event_id = ?').get(real.id).n, 1);
  assert.deepEqual((await ana.get('/api/v1/me/events/past')).data.events, []);
  assert.deepEqual((await ana.get('/api/v1/me/friends/suggested')).data.friends, []);
  // Again: nothing to delete.
  assert.deepEqual((await asAccountService(server, 'DELETE', '/api/internal/test-events', undefined, { purpose: 'test-events' })).data, { deleted: 0 });
});
