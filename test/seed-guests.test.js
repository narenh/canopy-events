// scripts/seed-guests.js against the real server: the fake account
// service's people stand in for test people (a tokens file made from
// theirs), and Ana is the owner whose events and friend link they fill.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { startServer, client, makeEvent } = require('./harness');
const { answerMix, parseEvent, parseFriendLink } = require('../scripts/seed-guests');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'seed-guests.js');
const TINY_JPEG = Buffer.from('ffd8ffdb0004aaaaffda0004bbbb0102ffd9', 'hex');

function runScript(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('exit', (code) => resolve({ code, out }));
  });
}

// A stand-in for the account service's photo upload, and an avatar service.
async function startStub() {
  const uploads = [];
  const srv = http.createServer((req, res) => {
    let body = [];
    req.on('data', (c) => body.push(c));
    req.on('end', () => {
      body = Buffer.concat(body);
      if (req.method === 'GET' && req.url.startsWith('/avatar/')) {
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        return res.end(TINY_JPEG);
      }
      const auth = String(req.headers.authorization || '');
      if (!/^Bearer \S{43}$/.test(auth)) { res.writeHead(401); return res.end('{}'); }
      if (req.method === 'GET' && req.url === '/api/native/v1/me') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ person: { photoUrl: null } }));
      }
      if (req.method === 'POST' && req.url === '/api/native/v1/me/photo') {
        uploads.push({ auth, type: req.headers['content-type'], hasJpeg: body.includes(TINY_JPEG) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end('{"person":{}}');
      }
      res.writeHead(404);
      res.end('{}');
    });
  });
  await new Promise((resolve) => srv.listen(0, resolve));
  return { base: `http://127.0.0.1:${srv.address().port}`, uploads, close: () => new Promise((r) => srv.close(r)) };
}

test('the answer mix: mostly going, some maybe, a few who can\'t', () => {
  for (const n of [0, 1, 3, 5, 8, 20, 40]) {
    for (let i = 0; i < 50; i++) {
      const m = answerMix(n);
      assert.equal(m.going + m.maybe + m.notGoing, n);
      assert.ok(m.going >= 0 && m.maybe >= 0 && m.notGoing >= 0);
      if (n >= 5) {
        assert.ok(m.going > m.maybe && m.going > m.notGoing, JSON.stringify(m));
        assert.ok(m.notGoing >= 1, 'someone can\'t go');
      }
    }
  }
  assert.deepEqual(parseEvent('https://events.canopysf.com/e/4fQ9xKpL2mZa'), { id: '4fQ9xKpL2mZa', origin: 'https://events.canopysf.com' });
  assert.deepEqual(parseEvent('4fQ9xKpL2mZa'), { id: '4fQ9xKpL2mZa', origin: null });
  assert.equal(parseFriendLink('http://localhost:3001/f/7Hq2mXc9LpRt').code, '7Hq2mXc9LpRt');
  assert.throws(() => parseEvent('https://example.com/nope'));
});

test('seeding test guests, and cleaning them up', async (t) => {
  const server = await startServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-seed-test-'));
  const stub = await startStub();
  t.after(async () => {
    await stub.close();
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  // 25 test people: five of the fixtures and twenty more.
  const testers = ['ben', 'cy', 'dee', 'eve', 'fay'].map((n) => server.people[n]);
  for (let i = 0; i < 20; i++) testers.push(server.fake.addPerson(100 + i, `t${i}`, `Test${i}`, `Person${i}`));
  const tokens = path.join(dir, 'canopy-test-tokens.json');
  fs.writeFileSync(tokens, JSON.stringify({ people: testers.map((p) => ({ id: p.id, firstName: p.firstName, lastName: p.lastName, token: p.token })) }));
  const as = (p) => client(server, p, { mode: 'bearer' });
  const ana = client(server, 'ana', { mode: 'bearer' });
  const capped = await makeEvent(ana, { title: 'Capped party', capacity: 8, guestsAllowed: 2 });
  const open = await makeEvent(ana, { title: 'Open house' });
  const friendLink = (await ana.get('/api/v1/me/friend-link')).data.url;
  const common = ['--tokens', tokens, '--base', server.base, '--delay', '0'];
  const testerIds = new Set(testers.map((p) => p.id));
  const testPosts = async (ev) => (await ana.get(`/api/v1/events/${ev.id}/wall?limit=100`)).data.entries
    .filter((w) => w.type === 'post' && testerIds.has(w.person.id));
  const answered = (c) => c.going + c.maybe + c.notGoing + c.waitlisted;

  await t.test('a dry run changes nothing', async () => {
    const r = await runScript(['seed', ...common, '--event', capped.url, '--friend-link', friendLink, '--updates', '--dry-run']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /\[dry run\] PUT/);
    assert.equal(answered((await ana.get(`/api/v1/events/${capped.id}`)).data.event.counts), 0);
    assert.equal((await ana.get('/api/v1/me/friends')).data.friends.length, 0);
  });

  await t.test('seed: answers, the waitlist, plus-ones, updates and the friend link', async () => {
    const r = await runScript(['seed', ...common, '--event', capped.url, '--event', open.id, '--friend-link', friendLink, '--updates', '--answers', '20']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Summary: 2 event\(s\) seeded/);
    const c = (await ana.get(`/api/v1/events/${capped.id}`)).data.event.counts;
    assert.equal(answered(c), 20);
    assert.ok(c.going + c.waitlisted > c.maybe && c.going + c.waitlisted > c.notGoing, JSON.stringify(c));
    assert.ok(c.notGoing >= 1);
    assert.ok(c.total.going <= 8, 'the capacity holds');
    assert.ok(c.waitlisted >= 1, 'the rest of those going wait');
    assert.ok(c.guests.going + c.guests.maybe + c.guests.waitlisted >= 1, 'someone brings a plus-one');
    const o = (await ana.get(`/api/v1/events/${open.id}`)).data.event.counts;
    assert.equal(answered(o), 20);
    assert.equal(o.waitlisted, 0);
    assert.equal(o.guests.going + o.guests.maybe, 0, 'no plus-ones where none are allowed');
    for (const ev of [capped, open]) {
      const posts = await testPosts(ev);
      assert.ok(posts.length >= 2 && posts.length <= 4, `${posts.length} updates`);
      assert.equal(new Set(posts.map((w) => w.person.id)).size, posts.length, 'one each');
    }
    // Every test person is in Ana's list, and she's in theirs.
    const friends = (await ana.get('/api/v1/me/friends?limit=100')).data.friends;
    assert.equal(friends.length, 25);
    assert.ok(friends.every((f) => f.source === 'link'));
    assert.ok((await as(testers[0]).get('/api/v1/me/friends')).data.friends.some((f) => f.person.id === server.people.ana.id));
  });

  await t.test('running it again tops up rather than piling on', async () => {
    const r = await runScript(['seed', ...common, '--event', capped.url, '--event', open.id, '--friend-link', friendLink, '--updates', '--answers', '20']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /0 answered/);
    assert.equal(answered((await ana.get(`/api/v1/events/${capped.id}`)).data.event.counts), 20);
    for (const ev of [capped, open]) assert.ok((await testPosts(ev)).length <= 4);
    assert.equal((await ana.get('/api/v1/me/friends?limit=100')).data.friends.length, 25);
  });

  let history;
  await t.test('friends: photos and past events among the test people', async () => {
    const r = await runScript(['friends', ...common, '--friend-link', friendLink, '--photos', '--account-url', stub.base,
      '--avatar-url', `${stub.base}/avatar/{id}`, '--history', '2']);
    assert.equal(r.code, 0, r.out);
    assert.equal(stub.uploads.length, 25);
    assert.ok(stub.uploads.every((u) => /^multipart\/form-data/.test(u.type) && u.hasJpeg));
    assert.equal(new Set(stub.uploads.map((u) => u.auth)).size, 25, 'each as themself');
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'canopy-test-tokens.state.json'), 'utf8'));
    history = state.history;
    assert.equal(history.length, 2);
    for (const id of history) {
      const ev = (await ana.get(`/api/v1/events/${id}`)).data.event;
      assert.ok(Date.parse(ev.endsAt) < Date.now(), 'it\'s over');
      assert.ok(Date.parse(ev.startsAt) < Date.now() - 4 * 24 * 60 * 60 * 1000, 'days ago');
      assert.ok(testerIds.has(ev.hosts[0].person.id));
      assert.ok(ev.counts.going >= 3);
    }
    // Events in common among the test people now.
    const someone = (await as(testers[0]).get('/api/v1/me/friends?limit=100')).data.friends;
    const host = (await ana.get(`/api/v1/events/${history[0]}`)).data.event.hosts[0].person.id;
    const hostFriends = (await as(testers.find((p) => p.id === host)).get('/api/v1/me/friends?limit=100')).data.friends;
    assert.ok(hostFriends.some((f) => f.eventsInCommon >= 1 && f.lastTogetherAt), JSON.stringify(someone.slice(0, 2)));
  });

  await t.test('photos are skipped, and nothing fails, when the account service is out of reach', async () => {
    const r = await runScript(['friends', ...common, '--photos', '--account-url', 'http://127.0.0.1:9']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /skipped: couldn't reach the account service/);
  });

  await t.test('cleanup: off every event, updates and hosted events deleted, friendships gone from their side', async () => {
    const dry = await runScript(['cleanup', ...common, '--dry-run']);
    assert.equal(dry.code, 0, dry.out);
    assert.equal(answered((await ana.get(`/api/v1/events/${capped.id}`)).data.event.counts), 20, 'a dry run changes nothing');

    const r = await runScript(['cleanup', ...common]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Delete all test people/);
    for (const ev of [capped, open]) {
      const e = (await ana.get(`/api/v1/events/${ev.id}`)).data.event;
      assert.equal(answered(e.counts), 0, `${ev.title} has no test guests left`);
      assert.equal((await testPosts(ev)).length, 0, 'their updates are gone');
      const wall = (await ana.get(`/api/v1/events/${ev.id}/wall?limit=100`)).data.entries;
      assert.ok(!wall.some((w) => w.person && testerIds.has(w.person.id)), 'and their "going" entries');
    }
    for (const id of history) assert.equal((await ana.get(`/api/v1/events/${id}`)).status, 404, 'history events deleted');
    for (const p of testers) {
      assert.deepEqual((await as(p).get('/api/v1/me/friends')).data.friends, [], `${p.name} has no friends left`);
      for (const list of ['all', 'past', 'declined']) assert.deepEqual((await as(p).get(`/api/v1/me/events/${list}`)).data.events, []);
    }
    assert.ok(!fs.existsSync(path.join(dir, 'canopy-test-tokens.state.json')));
    // Ana's own events are untouched.
    assert.equal((await ana.get(`/api/v1/events/${capped.id}`)).status, 200);
  });

  await t.test('a bad tokens file is refused before anything happens', async () => {
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, JSON.stringify({ people: [{ id: 'x', token: 'short' }] }));
    const r = await runScript(['seed', '--tokens', bad, '--base', server.base, '--event', open.id]);
    assert.equal(r.code, 1);
    assert.match(r.out, /isn't a tokens file/);
  });
});
