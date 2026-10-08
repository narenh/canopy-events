// Cookie and bearer: both sign someone in; the Origin check holds changes
// made with the cookie to Canopy pages and skips bearer requests (which
// never use the cookie); renewed cookies only go back to cookie requests;
// and an account service that can't be reached is a JSON 503.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, eventBody, makeEvent } = require('./harness');

test('cookie and bearer', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const P = server.people;
  const anaPage = client(server, 'ana');
  const anaApp = client(server, 'ana', { mode: 'bearer' });

  await t.test('the cookie and a bearer token are the same person', async () => {
    assert.equal((await anaPage.get('/api/v1/me')).data.person.id, P.ana.id);
    assert.equal((await anaApp.get('/api/v1/me')).data.person.id, P.ana.id);
  });

  await t.test('a change with the cookie needs a Canopy page as its Origin', async () => {
    const evil = client(server, 'ana', { origin: 'https://evil.example' });
    let r = await evil.post('/api/v1/events', eventBody());
    assert.equal(r.status, 403);
    assert.equal(r.data.reason, 'bad_origin');
    const none = client(server, 'ana', { origin: null });
    r = await none.post('/api/v1/events', eventBody(), { headers: { Origin: '' } });
    assert.equal(r.data.reason, 'bad_origin');
    assert.equal((await none.post('/api/v1/events', eventBody(), { headers: { Origin: 'null' } })).data.reason, 'bad_origin');
    // http on a lookalike, or a Canopy name with a userinfo trick, aren't Canopy.
    for (const origin of ['http://events.canopysf.com', 'https://canopysf.com.evil.example', 'https://evilcanopysf.com']) {
      assert.equal((await none.post('/api/v1/events', eventBody(), { headers: { Origin: origin } })).data.reason, 'bad_origin', origin);
    }
    for (const origin of ['https://events.canopysf.com', 'https://canopysf.com', server.base]) {
      assert.equal((await none.post('/api/v1/events', eventBody(), { headers: { Origin: origin } })).status, 201, origin);
    }
    // Reading needs no Origin.
    assert.equal((await none.get('/api/v1/me')).status, 200);
  });

  await t.test('a bearer request skips the Origin check: apps send none', async () => {
    const r = await anaApp.post('/api/v1/events', eventBody());
    assert.equal(r.status, 201, r.text);
    const e = r.data.event;
    assert.equal((await anaApp.patch(`/api/v1/events/${e.id}`, { title: 'From the app' })).status, 200);
    // Even with a foreign Origin: the cookie plays no part in it.
    const odd = await anaApp.patch(`/api/v1/events/${e.id}`, { title: 'x' }, { headers: { Origin: 'https://evil.example' } });
    assert.equal(odd.status, 200);
    const ben = client(server, 'ben', { mode: 'bearer' });
    assert.equal((await ben.put(`/api/v1/events/${e.id}/rsvp`, { status: 'going' })).status, 200);
    assert.equal((await ben.del(`/api/v1/events/${e.id}/rsvp`)).status, 200);
  });

  await t.test('a bearer request is judged by its token alone, never the cookie', async () => {
    const e = await makeEvent(anaPage);
    // A bad token with Ana's good cookie: nobody (and no Origin check to
    // hide behind, so the cookie can't be used cross-site this way).
    const r = await fetch(`${server.base}/api/v1/events/${e.id}`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer nope', Cookie: `canopy_session=${P.ana.token}`, 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ title: 'Hijacked' })
    });
    assert.equal(r.status, 401);
    assert.equal((await r.json()).reason, 'sign_in_required');
    // Ben's token with Ana's cookie is Ben.
    const both = await fetch(`${server.base}/api/v1/me`, {
      headers: { Authorization: `Bearer ${P.ben.token}`, Cookie: `canopy_session=${P.ana.token}` }
    });
    assert.equal((await both.json()).person.id, P.ben.id);
  });

  await t.test('a renewed cookie goes back to a cookie request, never a bearer one', async () => {
    // Fresh tokens, so nothing's cached.
    const cy = server.people.cy;
    server.fake.renew.add(cy.token);
    const viaBearer = await fetch(`${server.base}/api/v1/me`, { headers: { Authorization: `Bearer ${cy.token}` } });
    assert.equal(viaBearer.status, 200);
    assert.equal(viaBearer.headers.getSetCookie().length, 0);
    const dee = server.people.dee;
    server.fake.renew.add(dee.token);
    const viaCookie = await fetch(`${server.base}/api/v1/me`, { headers: { Cookie: `canopy_session=${dee.token}` } });
    assert.ok(viaCookie.headers.getSetCookie().some((c) => c.startsWith(`canopy_session=${dee.token};`)));
  });

  await t.test("the account service can't be reached: a 503 in the API's shape", async () => {
    const e = await makeEvent(anaPage);
    await server.fake.close();
    // Someone not seen before (nothing cached to stand in).
    const eve = client(server, 'eve', { mode: 'bearer' });
    const r = await eve.get('/api/v1/me');
    assert.equal(r.status, 503);
    assert.equal(r.data.reason, 'accounts_unreachable');
    // Signed out needs no session lookup, but the hosts' names do.
    const out = await client(server, null).get(`/api/v1/events/${e.id}`);
    assert.equal(out.status, 503);
    assert.equal(out.data.reason, 'accounts_unreachable');
    assert.equal((await fetch(server.base + '/healthz')).status, 200, 'the server is still up');
  });
});
