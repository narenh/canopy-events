// Finding someone to invite by phone or Instagram: verified people only,
// the public shape and nothing else, the account service's refusals in
// this API's shape, and the visitor's address passed on for its limits.
// The leak walker (harness.js) checks every answer here too: a lookup by
// Cy's phone must not have Cy's phone in it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, makeEvent } = require('./harness');

const PUBLIC_FIELDS = ['firstName', 'id', 'lastName', 'photoUrl', 'shortName'];

test('lookup', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const P = server.people;
  const fake = server.fake;
  const [ana, una] = ['ana', 'una'].map((n) => client(server, n));
  const anaApp = client(server, 'ana', { mode: 'bearer' });
  const look = (who, body, opts) => who.post('/api/v1/people/lookup', body, opts);
  // Cy, Eve and Una let themselves be found (fakeAccount.js); Ben doesn't.

  await t.test('by phone, as typed: the public shape and nothing else', async () => {
    const r = await look(ana, { phone: '(415) 555-1003' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.person.id, P.cy.id);
    assert.deepEqual(Object.keys(r.data.person).sort(), PUBLIC_FIELDS);
    assert.ok(!r.text.includes('1003'), 'not even the number asked about');
    assert.equal(fake.lookups.at(-1).query.phone, '(415) 555-1003');
    // In the body, never the URL, on its way to the account service too.
    assert.equal(fake.lookups.at(-1).url, '/api/people/lookup');
  });

  await t.test('by Instagram, with an @ and capitals', async () => {
    const r = await look(anaApp, { instagram: '@EVE.insta' });
    assert.equal(r.data.person.id, P.eve.id);
    assert.ok(!r.text.toLowerCase().includes('eve.insta'));
  });

  await t.test('a miss, or someone who isn\'t findable, is just null', async () => {
    assert.deepEqual((await look(ana, { phone: '4155559999' })).data, { person: null });
    assert.deepEqual((await look(ana, { phone: P.ben.phone })).data, { person: null });
  });

  await t.test('what it feeds: an invitation by the id it found', async () => {
    const e = await makeEvent(ana);
    const found = (await look(ana, { instagram: 'cy.insta' })).data.person;
    const r = await ana.post(`/api/v1/events/${e.id}/invites`, { personIds: [found.id] });
    assert.deepEqual(r.data.invited.map((p) => p.id), [P.cy.id]);
  });

  await t.test('verified people only; signed out is a 401', async () => {
    const before = fake.lookups.length;
    let r = await look(una, { phone: '4155551003' });
    assert.equal(r.status, 403);
    assert.equal(r.data.reason, 'email_unverified');
    assert.ok(r.data.verify.startsWith(`${fake.base}/profile?verify=1`));
    r = await look(client(server, null), { phone: '4155551003' });
    assert.equal(r.status, 401);
    assert.equal(r.data.reason, 'sign_in_required');
    assert.equal(fake.lookups.length, before, 'neither reached the account service');
  });

  await t.test('one of phone or instagram, and what the account service refuses', async () => {
    for (const q of [{}, { phone: '1', instagram: 'x' }, { phone: ['1', '2'] }, { phone: 4155551003 }, { name: 'ana' }]) {
      const r = await look(ana, q);
      assert.equal(r.status, 400, JSON.stringify(q));
      assert.equal(r.data.reason, 'one_of', JSON.stringify(q));
    }
    let r = await look(ana, { phone: '12' });
    assert.equal(r.status, 400);
    assert.equal(r.data.reason, 'bad_phone');
    r = await look(ana, { instagram: 'no spaces allowed' });
    assert.equal(r.data.reason, 'bad_instagram');
  });

  await t.test("the account service's other refusals, in this API's shape", async () => {
    const cases = [
      [{ status: 429, body: { error: 'too many tries -- wait a few minutes', reason: 'rate_limited' } }, 429, 'rate_limited'],
      [{ status: 403, body: { error: 'this site may not look people up', reason: 'lookup_not_allowed' } }, 403, 'lookup_not_allowed'],
      [{ status: 403, body: { error: 'confirm your email first', reason: 'email_unverified' } }, 403, 'email_unverified'],
      [{ status: 401, body: { error: 'not signed in', reason: 'signed_out' } }, 401, 'sign_in_required'],
      [{ status: 500, body: { error: 'boom' } }, 503, 'accounts_unreachable'],
      [{ status: 418, body: { error: 'odd', reason: 'teapot' } }, 503, 'accounts_unreachable']
    ];
    try {
      for (const [answer, status, reason] of cases) {
        fake.lookupAnswer = answer;
        const r = await look(ana, { phone: '4155551003' });
        assert.equal(r.status, status, reason);
        assert.equal(r.data.reason, reason);
        assert.ok(r.data.error);
        if (reason === 'sign_in_required') assert.ok(r.data.signIn && r.data.quickSignUp);
        if (reason === 'email_unverified') assert.ok(r.data.verify);
      }
    } finally {
      fake.lookupAnswer = null;
    }
  });

  await t.test('a POST: the GET form, with the number in the URL, is gone', async () => {
    const r = await ana.get('/api/v1/people/lookup?phone=4155551003');
    assert.equal(r.status, 404);
    assert.equal(r.data.reason, 'not_found');
  });

  await t.test('from a page, the Origin check applies as to any change made with the cookie', async () => {
    const r = await ana.post('/api/v1/people/lookup', { phone: '4155551003' }, { headers: { Origin: 'https://evil.example' } });
    assert.equal(r.status, 403);
    assert.equal(r.data.reason, 'bad_origin');
  });

  await t.test("the visitor's address goes along, for the per-address limit", async () => {
    await look(ana, { phone: '4155551003' }, { headers: { 'CF-Connecting-IP': '203.0.113.9' } });
    assert.equal(fake.lookups.at(-1).visitorIp, '203.0.113.9');
    // Without Cloudflare, the address Express sees.
    await look(anaApp, { phone: '4155551003' });
    assert.match(fake.lookups.at(-1).visitorIp, /127\.0\.0\.1|::1/);
  });
});

// Its own server: closing the fake account service can't be undone.
test("lookup: the account service can't be reached", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const ana = client(server, 'ana');
  await ana.get('/api/v1/me'); // her session is cached for a minute
  await server.fake.close();
  const r = await ana.post('/api/v1/people/lookup', { phone: '4155551003' });
  assert.equal(r.status, 503);
  assert.equal(r.data.reason, 'accounts_unreachable');
});
