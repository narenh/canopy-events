// lib/canopy-account.js, the account service's client file, against the
// fake account service: the contract events relies on. req.person with
// emailVerified, bearer tokens (which win over the cookie and never get a
// Set-Cookie), the unverified answer on a site that doesn't allow them,
// and the quick sign-up and verify links.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { startFakeAccount } = require('./fakeAccount');
const createCanopyAccount = require('../lib/canopy-account');

test('the account client', async (t) => {
  const fake = await startFakeAccount();
  t.after(() => fake.close());
  const { ana, una, gus } = fake.people;

  const canopy = createCanopyAccount({ url: fake.base, key: fake.key, cacheMs: 0 });
  const site = express();
  site.use(canopy.attach);
  site.get('/who', (req, res) => res.json({ person: req.person, unverified: req.canopyUnverified }));
  site.get('/api/mine', canopy.requireSignIn, (req, res) => res.json({ ok: true }));
  const listener = await new Promise((resolve) => { const l = site.listen(0, () => resolve(l)); });
  t.after(() => listener.close());
  const base = `http://localhost:${listener.address().port}`;
  const who = async (headers) => (await fetch(base + '/who', { headers })).json();
  const cookie = (p) => ({ Cookie: `canopy_session=${p.token}` });
  const bearer = (p) => ({ Authorization: `Bearer ${p.token}` });

  await t.test('the cookie and a bearer token both sign someone in', async () => {
    assert.equal((await who(cookie(ana))).person.id, ana.id);
    assert.equal((await who(bearer(ana))).person.id, ana.id);
    assert.equal((await who(cookie(ana))).person.emailVerified, true);
    assert.equal((await who({})).person, null);
  });

  await t.test('a bearer token wins over the cookie, and a bad one is nobody', async () => {
    assert.equal((await who({ ...bearer(ana), ...cookie(una) })).person.id, ana.id);
    assert.equal((await who({ Authorization: 'Bearer not-a-token', ...cookie(ana) })).person, null);
    // Another scheme isn't a bearer token: the cookie counts.
    assert.equal((await who({ Authorization: 'Basic eDp5', ...cookie(ana) })).person.id, ana.id);
  });

  await t.test('a renewed cookie is passed on for the cookie, never for a bearer token', async () => {
    fake.renew.add(ana.token);
    const viaBearer = await fetch(base + '/who', { headers: bearer(ana) });
    assert.equal(viaBearer.headers.getSetCookie().length, 0);
    fake.renew.add(ana.token);
    const viaCookie = await fetch(base + '/who', { headers: cookie(ana) });
    assert.ok(viaCookie.headers.getSetCookie().some((c) => c.startsWith(`canopy_session=${ana.token};`)));
  });

  await t.test('an unverified person: themself where allowed, otherwise sent to verify', async () => {
    const allowed = await who(cookie(una));
    assert.equal(allowed.person.id, una.id);
    assert.equal(allowed.person.emailVerified, false);
    fake.allowsUnverified = false;
    try {
      assert.deepEqual(await who(cookie(una)), { person: null, unverified: true });
      const r = await fetch(base + '/api/mine', { headers: bearer(una) });
      assert.equal(r.status, 403);
      const body = await r.json();
      assert.equal(body.reason, 'email_unverified');
      assert.match(body.verify, /\/profile\?verify=1&return=/);
    } finally {
      fake.allowsUnverified = true;
    }
  });

  await t.test('a deleted person is signed out, and missing from people()', async () => {
    fake.deleted.add(gus.id);
    try {
      assert.equal((await who(cookie(gus))).person, null);
      const found = await canopy.people([ana.id, gus.id]);
      assert.deepEqual(Array.from(found.keys()), [ana.id]);
      assert.deepEqual(Object.keys(found.get(ana.id)).sort(), ['firstName', 'id', 'lastName', 'photoUrl', 'shortName']);
    } finally {
      fake.deleted.delete(gus.id);
    }
  });

  await t.test('quickSignUpUrl and verifyUrl', () => {
    const back = 'https://events.canopysf.com/e/AbCdEfGhIjKl';
    assert.equal(canopy.quickSignUpUrl({}, back), `${fake.base}/?quick=1&return=${encodeURIComponent(back)}`);
    assert.equal(canopy.verifyUrl({}, back), `${fake.base}/profile?verify=1&return=${encodeURIComponent(back)}`);
  });
});
