// A stand-in for Apple's Maps Server API: the token trade (/v1/token), the
// suggestions (/v1/searchAutocomplete) and a suggestion, whole
// (/v1/search with its completion's q and metadata), shaped like Apple's
// own examples. In the test's own process, so a test can take it down,
// expire its tokens, and see every request it got.
//
// The key is made here (an EC P-256 pair, as a Maps key's .p8 is), and the
// token trade checks the JWT against its public half: the header, the
// claims, and the ES256 signature.
//
// The server is pointed at it with fake.env(): APPLE_MAPS_URL=<base>,
// and the team, key id and key (the key in Coolify's one-line form, with
// "\n" for its line breaks).

const crypto = require('crypto');
const express = require('express');
const { KEEP_ALIVE_MS } = require('./fakeAccount');

const TEAM_ID = 'TEAM123456';
const KEY_ID = 'KEY7890ABC';

function makeKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKey };
}

// Apple's own shapes. A suggestion that's a search (no location), a named
// place, and an address; and the places behind the last two.
const PLACES = [
  {
    name: 'Dolores Park',
    lines: ['19th St & Dolores St', 'San Francisco, CA 94114', 'United States'],
    lat: 37.7597727, lng: -122.4270634, id: 'I5B8A0D4E1F2C3B7A',
    structured: { locality: 'San Francisco', administrativeAreaCode: 'CA', fullThoroughfare: '19th St & Dolores St', thoroughfare: 'Dolores St' }
  },
  {
    name: 'Dolores Street Community Services',
    lines: ['938 Valencia St', 'San Francisco, CA 94110', 'United States'],
    lat: 37.757, lng: -122.4213, id: 'I1234567890ABCDEF',
    structured: { locality: 'San Francisco', fullThoroughfare: '938 Valencia St', subThoroughfare: '938', thoroughfare: 'Valencia St' }
  },
  {
    name: '1 Dolores St',
    lines: ['1 Dolores St', 'San Francisco, CA 94103', 'United States'],
    lat: 37.7693, lng: -122.4264, id: null,
    structured: { locality: 'San Francisco', fullThoroughfare: '1 Dolores St', subThoroughfare: '1', thoroughfare: 'Dolores St' }
  }
];

function completionUrl(p) {
  return '/v1/search?' + new URLSearchParams({ q: `${p.name} ${p.lines.join(', ')}`, metadata: Buffer.from(p.name).toString('base64') });
}

function suggestion(p) {
  return {
    completionUrl: completionUrl(p),
    displayLines: [p.name, p.lines.slice(p.name === p.lines[0] ? 1 : 0).join(', ')],
    location: { lat: p.lat, lng: p.lng },
    structuredAddress: p.structured
  };
}

function place(p) {
  const out = {
    name: p.name,
    coordinate: { latitude: p.lat, longitude: p.lng },
    formattedAddressLines: p.lines,
    structuredAddress: p.structured,
    country: 'United States',
    countryCode: 'US'
  };
  if (p.id) out.id = p.id;
  return out;
}

function verifyJwt(jwt, publicKey) {
  const parts = String(jwt || '').split('.');
  if (parts.length !== 3) return null;
  let header, claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
  } catch (e) {
    return null;
  }
  const ok = crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2], 'base64url'));
  return ok ? { header, claims } : null;
}

async function startFakeAppleMaps() {
  const key = makeKey();
  const state = {
    privateKeyPem: key.pem,
    publicKey: key.publicKey,
    // Everything answers 503.
    down: false,
    // How long the access tokens it gives out last.
    expiresInSeconds: 1800,
    // Access tokens it still takes. Clear it to make the server's go stale.
    valid: new Set(),
    // Every request: { path, query, authorization, acceptLanguage }.
    requests: [],
    // Every JWT traded: { header, claims }.
    jwts: [],
    tokensIssued: 0
  };

  const app = express();
  app.use((req, res, next) => {
    state.requests.push({ path: req.path, query: { ...req.query }, authorization: req.get('authorization') || null });
    if (state.down) return res.status(503).json({ error: { message: 'down', details: [] } });
    next();
  });

  app.get('/v1/token', (req, res) => {
    const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
    const jwt = m && verifyJwt(m[1], state.publicKey);
    const now = Math.floor(Date.now() / 1000);
    if (!jwt || jwt.header.alg !== 'ES256' || jwt.header.kid !== KEY_ID || jwt.header.typ !== 'JWT' ||
        jwt.claims.iss !== TEAM_ID || !(jwt.claims.iat <= now + 5) || !(jwt.claims.exp > now)) {
      return res.status(401).json({ error: { message: 'Not Authorized', details: [] } });
    }
    state.jwts.push(jwt);
    const token = `apple_access_${++state.tokensIssued}_${crypto.randomBytes(6).toString('hex')}`;
    state.valid.add(token);
    res.json({ accessToken: token, expiresInSeconds: state.expiresInSeconds });
  });

  const authorized = (req, res, next) => {
    const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
    if (!m || !state.valid.has(m[1])) return res.status(401).json({ error: { message: 'Not Authorized', details: [] } });
    next();
  };

  app.get('/v1/searchAutocomplete', authorized, (req, res) => {
    const q = String(req.query.q || '').toLowerCase();
    if (q === 'boom') return res.status(500).json({ error: { message: 'Internal error', details: [] } });
    const hits = PLACES.filter((p) => p.name.toLowerCase().includes(q) || p.lines.join(' ').toLowerCase().includes(q));
    const results = [{ completionUrl: '/v1/search?q=' + encodeURIComponent(q), displayLines: [req.query.q, 'Search Nearby'] }];
    // Plenty, so the server's cap shows: the hits, then copies (each its
    // own completion URL), then the first again exactly (a repeat).
    for (let i = 0; hits.length && i < 12; i++) {
      const s = suggestion(hits[i % hits.length]);
      if (i >= hits.length) s.completionUrl += `&n=${i}`;
      results.push(s);
    }
    if (hits.length) results.splice(2, 0, suggestion(hits[0]));
    res.json({ results });
  });

  app.get('/v1/search', authorized, (req, res) => {
    const p = PLACES.find((x) => req.query.metadata === Buffer.from(x.name).toString('base64'));
    res.json({ results: p ? [place(p)] : [] });
  });

  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  server.keepAliveTimeout = KEEP_ALIVE_MS;
  const base = `http://127.0.0.1:${server.address().port}`;
  return Object.assign(state, {
    base,
    // The server's settings to use this fake.
    env(extra = {}) {
      return {
        APPLE_MAPS_TEAM_ID: TEAM_ID,
        APPLE_MAPS_KEY_ID: KEY_ID,
        APPLE_MAPS_PRIVATE_KEY: key.pem.trim().replace(/\n/g, '\\n'),
        APPLE_MAPS_URL: base,
        ...extra
      };
    },
    of(path) { return state.requests.filter((r) => r.path === path); },
    close() { return new Promise((resolve) => server.close(resolve)); }
  });
}

module.exports = { startFakeAppleMaps, verifyJwt, makeKey, completionUrl, PLACES, TEAM_ID, KEY_ID };
