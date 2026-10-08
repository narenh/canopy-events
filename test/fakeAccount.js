// A stand-in for the account service: just the two calls a site makes
// (/api/session and /api/people), answered from fixtures, in the test's
// own process so a test can change who exists while the server runs.
//
// The people have every contact detail filled in, each one distinctive,
// so the leak walker (harness.js) can spot any of them in a response.

const express = require('express');

const KEY = 'cnp_test-site-key';

function token(name) {
  // A canopy_session value is 43 base64url characters.
  return (`tok_${name}_`.padEnd(43, 'x')).slice(0, 43);
}

function fixture(n, name, first, last, extra = {}) {
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  return {
    name,
    id,
    email: `${name}@example.com`,
    firstName: first,
    lastName: last,
    phone: `+1415555${String(1000 + n)}`,
    instagram: `${name}.insta`,
    venmo: `${name}-venmo`,
    cashapp: `${name}Cash`,
    emailVerified: true,
    findable: n % 2 === 1,
    token: token(name),
    ...extra
  };
}

// Verified: ana, ben, cy, dee, eve, fay. Unverified (a quick sign-up):
// una. Deleted from the account service (a former member): gus, whose
// token still names him so a test can have him do things before he goes.
function makePeople() {
  const list = [
    fixture(1, 'ana', 'Ana', 'Lima'),
    fixture(2, 'ben', 'Ben', 'Okafor'),
    fixture(3, 'cy', 'Cy', 'Park'),
    fixture(4, 'dee', 'Dee', 'Ruiz'),
    fixture(5, 'eve', 'Eve', 'Sato'),
    fixture(6, 'fay', 'Fay', 'Tran'),
    fixture(7, 'una', 'Una', 'Quick', { emailVerified: false }),
    fixture(8, 'gus', 'Gus', 'Gone')
  ];
  return Object.fromEntries(list.map((p) => [p.name, p]));
}

async function startFakeAccount() {
  const people = makePeople();
  const byToken = new Map(Object.values(people).map((p) => [p.token, p]));
  const state = {
    people,
    deleted: new Set(),
    // A site the admin hasn't marked as allowing quick accounts.
    allowsUnverified: true,
    // Tokens whose next session answer carries a renewed cookie.
    renew: new Set(),
    sessionCalls: 0,
    peopleCalls: 0
  };
  const app = express();
  let base = '';

  const photoUrl = (p) => (p.name === 'cy' ? null : `${base}/photo/${p.id}?v=1`);

  app.use((req, res, next) => {
    if (req.get('authorization') !== `Bearer ${KEY}`) return res.status(401).json({ error: 'unknown or revoked site key' });
    next();
  });

  app.get('/api/session', (req, res) => {
    state.sessionCalls++;
    const t = req.get('x-canopy-session');
    const p = byToken.get(t);
    if (!p || state.deleted.has(p.id)) return res.json({ person: null });
    if (!p.emailVerified && !state.allowsUnverified) return res.json({ person: null, unverified: true });
    const person = {
      id: p.id, email: p.email, firstName: p.firstName, lastName: p.lastName, shortName: `${p.firstName} ${p.lastName[0]}`,
      photoUrl: photoUrl(p), venmo: p.venmo, phone: p.phone, instagram: p.instagram, cashapp: p.cashapp
    };
    // Like the real one: only a site that allows unverified accounts is
    // told whether the email is proven (and whether they're findable).
    if (state.allowsUnverified) Object.assign(person, { emailVerified: p.emailVerified, findable: p.findable });
    const body = { person };
    if (state.renew.has(t)) {
      state.renew.delete(t);
      body.renewCookie = `canopy_session=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`;
    }
    res.json(body);
  });

  app.get('/api/people', (req, res) => {
    state.peopleCalls++;
    const ids = String(req.query.ids || '').split(',').filter(Boolean);
    if (ids.length > 200) return res.status(400).json({ error: 'at most 200 ids at a time' });
    const found = Object.values(people).filter((p) => ids.includes(p.id) && !state.deleted.has(p.id));
    res.json({
      people: found.map((p) => ({ id: p.id, firstName: p.firstName, lastName: p.lastName, shortName: `${p.firstName} ${p.lastName[0]}`, photoUrl: photoUrl(p) }))
    });
  });

  const listener = await new Promise((resolve) => { const l = app.listen(0, () => resolve(l)); });
  base = `http://127.0.0.1:${listener.address().port}`;
  // The state itself, so a test that sets fake.allowsUnverified or adds to
  // fake.deleted changes what the next answer says.
  return Object.assign(state, {
    base,
    key: KEY,
    close: () => new Promise((resolve) => { listener.closeAllConnections(); listener.close(resolve); })
  });
}

module.exports = { startFakeAccount, makePeople, token, KEY };
