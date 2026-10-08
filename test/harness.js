// Runs the real server in a child process on a scratch DATA_DIR, against
// the fake account service (fakeAccount.js), and clients that act as one
// of its people: with the cookie, as a browser page does, or with a
// bearer token, as an app does.
//
// Every JSON answer from /api/v1 (and the account service's
// /api/calendar) that any test gets goes through the
// checks in CHECKS before the test sees it. The first is the leak walker:
// nobody's email, phone, Instagram, Venmo or Cash App, anywhere in it, not
// even the caller's own (events shows none, so it answers with none). A
// test doesn't have to remember to ask; a leak in any response fails
// whichever test made the request.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const Database = require('better-sqlite3');
const { startFakeAccount, KEEP_ALIVE_MS } = require('./fakeAccount');
const { checkResponse } = require('./openapi');
const { TOKEN: TMDB_TOKEN } = require('./fakeTmdb');
const { internalAuthorization } = require('../lib/canopy-account');

const CONTACT_FIELDS = ['email', 'phone', 'instagram', 'venmo', 'cashapp'];

// What the account service signs its calendar requests with, as the
// account admin's Sites tab would show it (routes/calendar.js).
const CALENDAR_SECRET = 'cnc_test-calendar-secret';

// The account service's signature on a calendar request for `personId`
// (its lib/calendar.js), worked out here from the contract rather than
// borrowed from either side's code. `at` is when it's signed, in ms.
function calendarAuth(personId, { secret = CALENDAR_SECRET, at = Date.now() } = {}) {
  const t = Math.floor(at / 1000);
  const sig = require('crypto').createHmac('sha256', secret).update(`canopy-calendar-v1\n${personId}\n${t}`).digest('hex');
  return `Canopy-Calendar t=${t}, sig=${sig}`;
}

// The account service's signature on one of its other requests, to
// /api/internal (routes/internal.js): made by the shared client file's own
// signer (lib/canopy-account.js internalAuthorization), the one the
// account service signs with. `url` is the path; `at` when it's signed.
function internalAuth(server, { purpose, method, url, body, secret = CALENDAR_SECRET, at = Date.now() }) {
  return internalAuthorization(secret, { purpose, method, url: server.base + url, body }, at);
}

// The account service sending a signed request to /api/internal: no
// cookie, no Origin. `opts.auth` replaces the signature (a string, or
// null for none); the rest of `opts` goes to internalAuth.
async function asAccountService(server, method, url, body, opts = {}) {
  const auth = opts.auth !== undefined ? opts.auth : internalAuth(server, { purpose: opts.purpose, method, url, body, ...opts });
  const headers = auth === null ? {} : { Authorization: auth };
  const c = client(server, null, { origin: '' });
  if (method === 'DELETE') return c.del(url, { headers, body });
  return c[method.toLowerCase()](url, body, { headers });
}

// Every place in `data` that shows anyone's contact details, the caller's
// included: a contact field on any object, or anyone's actual email,
// number or handle anywhere in any string. (`callerId` is kept for the
// checks' signature; nobody is exempt any more.)
function findLeaks(data, callerId, people) {
  const others = Object.values(people);
  const found = [];
  const walk = (v, where) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${where}[${i}]`));
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (CONTACT_FIELDS.includes(k.toLowerCase()) && x != null) found.push(`${where}.${k}`);
        walk(x, `${where}.${k}`);
      }
      return;
    }
    if (typeof v !== 'string') return;
    const s = v.toLowerCase();
    for (const p of others) {
      for (const k of CONTACT_FIELDS) {
        if (p[k] && s.includes(String(p[k]).toLowerCase())) found.push(`${where} has ${p.name}'s ${k}`);
      }
    }
  };
  walk(data, '$');
  return found;
}

// (response, request) -> throws on a problem.
const CHECKS = [
  function noLeaks(r, { callerId, people }) {
    const leaks = findLeaks(r.data, callerId, people);
    if (leaks.length) throw new Error(`contact details leaked in ${r.method} ${r.url}:\n  ${leaks.join('\n  ')}\n${r.text}`);
  },
  // The answer is what openapi.yaml says it is (test/openapi.js).
  function matchesSpec(r) {
    checkResponse(r);
  },
  // TMDB's token (the fake's, test/fakeTmdb.js) is never in an answer.
  function noTmdbToken(r) {
    if (r.text.includes(TMDB_TOKEN)) throw new Error(`the TMDB token is in ${r.method} ${r.url}`);
  }
];

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

// The fake account service and the server, together. `fake` is the
// account service's state (who exists, who's deleted...).
async function startServer(extraEnv = {}) {
  const fake = await startFakeAccount();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-events-test-'));
  const env = {
    ...process.env,
    PORT: String(port),
    DATA_DIR: dataDir,
    NODE_ENV: 'test',
    CANOPY_ACCOUNT_URL: fake.base,
    CANOPY_ACCOUNT_KEY: fake.key,
    CANOPY_CALENDAR_SECRET: CALENDAR_SECRET,
    PUBLIC_URL: '',
    // No curated backgrounds unless a test asks (test/backgrounds.test.js
    // and its fake TMDB): never config/backgrounds.json, whose images are
    // on the real TMDB.
    BACKGROUNDS_FILE: '',
    TMDB_TOKEN: '',
    TMDB_LIST_ID: '',
    // Idle connections kept for the whole file, not Node's 5 s: see
    // KEEP_ALIVE_MS in fakeAccount.js.
    KEEP_ALIVE_TIMEOUT_MS: String(KEEP_ALIVE_MS),
    ...extraEnv
  };
  let child;
  let output = '';
  async function launch() {
    child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const started = output.length;
    child.stdout.on('data', (c) => { output += c; });
    child.stderr.on('data', (c) => { output += c; });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not start:\n' + output)), 10000);
      child.stdout.on('data', () => { if (output.slice(started).includes('listening on port')) { clearTimeout(timer); resolve(); } });
      child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}:\n${output}`)); });
    });
  }
  // A server that didn't start is stopped, and the fake and the scratch
  // directory with it, before the error goes to the test. Left open, the
  // fake's listener would keep this test file's process alive after its
  // tests end, and the whole run would hang instead of saying what failed.
  try {
    await launch();
  } catch (err) {
    child.removeAllListeners('exit');
    child.kill();
    await fake.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    throw err;
  }
  let db = null;
  const server = {
    base: `http://localhost:${port}`,
    port,
    dataDir,
    fake,
    people: fake.people,
    output: () => output,
    // The server's own database, for moving an event in time.
    db() {
      if (!db) db = new Database(path.join(dataDir, 'events.db'));
      return db;
    },
    // Moves an event so it started `startedAgoMs` ago (negative: starts in
    // the future), and is over `overInMs` from now (negative: already over).
    setTimes(eventId, { startedAgoMs, overInMs }) {
      const now = Date.now();
      this.db().prepare('UPDATE events SET starts_at = ?, ends_at = NULL, over_at = ? WHERE id = ?')
        .run(now - startedAgoMs, now + overInMs, eventId);
    },
    // Stops the server and starts it again on the same DATA_DIR and port,
    // as a deploy does.
    async restart() {
      if (db) { db.close(); db = null; }
      child.removeAllListeners('exit');
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
      await launch();
    },
    async stop() {
      if (db) db.close();
      child.removeAllListeners('exit');
      child.kill();
      await fake.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };
  return server;
}

// A caller: one of the fake's people (or null, signed out), using the
// cookie as a page does (`mode: 'cookie'`, with an Origin on changes) or a
// bearer token as an app does (`mode: 'bearer'`, no Origin).
function client(server, who, { mode = 'cookie', origin } = {}) {
  const person = typeof who === 'string' ? server.people[who] : who;
  const pageOrigin = origin === undefined ? server.base : origin;

  async function request(method, url, { body, headers = {} } = {}) {
    const h = { Accept: 'application/json', ...headers };
    if (person && mode === 'cookie' && h.Cookie === undefined) h.Cookie = `canopy_session=${person.token}`;
    if (person && mode === 'bearer' && h.Authorization === undefined) h.Authorization = `Bearer ${person.token}`;
    if (method !== 'GET' && mode === 'cookie' && h.Origin === undefined && pageOrigin) h.Origin = pageOrigin;
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = typeof body === 'string' ? body : JSON.stringify(body); }
    let res;
    try {
      res = await fetch(server.base + url, { method, headers: h, body: payload, redirect: 'manual' });
    } catch (err) {
      // fetch's own message is just "fetch failed": say which request, and why.
      const why = err.cause ? err.cause.code || err.cause.message : '';
      throw new Error(`${method} ${url}: ${err.message}${why ? ` (${why})` : ''}`, { cause: err });
    }
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) {}
    const r = { method, url, status: res.status, data, text, headers: res.headers };
    if ((url.startsWith('/api/v1') || url.startsWith('/api/calendar/')) && data !== null) {
      CHECKS.forEach((check) => check(r, { callerId: person ? person.id : null, people: server.people }));
    }
    // /api/internal isn't in openapi.yaml (it isn't the apps' API), but
    // the other checks hold for it all the same.
    if (url.startsWith('/api/internal/') && data !== null) {
      CHECKS.filter((check) => check.name !== 'matchesSpec').forEach((check) => check(r, { callerId: null, people: server.people }));
    }
    return r;
  }

  return {
    person,
    get: (url, opts) => request('GET', url, opts),
    post: (url, body, opts) => request('POST', url, { ...opts, body: body === undefined ? {} : body }),
    put: (url, body, opts) => request('PUT', url, { ...opts, body }),
    patch: (url, body, opts) => request('PATCH', url, { ...opts, body }),
    del: (url, opts) => request('DELETE', url, opts),
    // A file upload: multipart/form-data with `buffer` in field `field`.
    upload: (method, url, buffer, { field = 'cover', filename = 'photo', type = 'application/octet-stream', ...opts } = {}) => {
      const form = new FormData();
      form.append(field, new Blob([buffer], { type }), filename);
      return request(method, url, { ...opts, body: form });
    }
  };
}

// An event's fields, a week from now unless told otherwise.
function eventBody(overrides = {}) {
  const start = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  return {
    title: 'Rooftop dinner',
    description: 'Bring a jacket.',
    startsAt: start.toISOString(),
    timeZone: 'America/Los_Angeles',
    locationName: "Ana's place",
    locationAddress: '1 Market St, San Francisco',
    ...overrides
  };
}

// The whole `counts` an event answers with, from the people with each
// status (`people`, leaving out the zeros) and their plus-ones (`guests`,
// by status).
function counts(people = {}, guests = {}) {
  const c = { going: 0, maybe: 0, notGoing: 0, invited: 0, waitlisted: 0, ...people };
  const g = { going: 0, maybe: 0, waitlisted: 0, ...guests };
  return { ...c, guests: g, total: { going: c.going + g.going, maybe: c.maybe + g.maybe, waitlisted: c.waitlisted + g.waitlisted } };
}

// Makes an event as `host` and returns it (throws if that didn't work).
async function makeEvent(host, overrides) {
  const r = await host.post('/api/v1/events', eventBody(overrides));
  if (r.status !== 201) throw new Error(`making an event failed: ${r.status} ${r.text}`);
  return r.data.event;
}

module.exports = { startServer, client, eventBody, makeEvent, counts, findLeaks, CHECKS, CONTACT_FIELDS, CALENDAR_SECRET, calendarAuth, internalAuth, asAccountService };
