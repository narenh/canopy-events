// Runs the real server in a child process on a scratch DATA_DIR, against
// the fake account service (fakeAccount.js), and clients that act as one
// of its people: with the cookie, as a browser page does, or with a
// bearer token, as an app does.
//
// Every JSON answer from /api/v1 that any test gets goes through the
// checks in CHECKS before the test sees it. The first is the leak walker:
// nobody's email, phone, Instagram, Venmo or Cash App but the caller's
// own, anywhere in it. A test doesn't have to remember to ask; a leak in
// any response fails whichever test made the request.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const Database = require('better-sqlite3');
const { startFakeAccount } = require('./fakeAccount');
const { checkResponse } = require('./openapi');

const CONTACT_FIELDS = ['email', 'phone', 'instagram', 'venmo', 'cashapp'];

// Every place in `data` that shows someone's contact details who isn't
// `callerId`: a contact field on any object that isn't the caller, or any
// other person's actual email, number or handle anywhere in any string.
function findLeaks(data, callerId, people) {
  const others = Object.values(people).filter((p) => p.id !== callerId);
  const found = [];
  const walk = (v, where) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${where}[${i}]`));
    if (v && typeof v === 'object') {
      const isCaller = callerId && v.id === callerId;
      for (const [k, x] of Object.entries(v)) {
        if (CONTACT_FIELDS.includes(k.toLowerCase()) && x != null && !isCaller) found.push(`${where}.${k}`);
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
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      NODE_ENV: 'test',
      CANOPY_ACCOUNT_URL: fake.base,
      CANOPY_ACCOUNT_KEY: fake.key,
      PUBLIC_URL: '',
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start:\n' + output)), 10000);
    child.stdout.on('data', () => { if (output.includes('listening on port')) { clearTimeout(timer); resolve(); } });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}:\n${output}`)); });
  });
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
    async stop() {
      if (db) db.close();
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
    const res = await fetch(server.base + url, { method, headers: h, body: payload, redirect: 'manual' });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) {}
    const r = { method, url, status: res.status, data, text, headers: res.headers };
    if (url.startsWith('/api/v1') && data !== null) {
      CHECKS.forEach((check) => check(r, { callerId: person ? person.id : null, people: server.people }));
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

module.exports = { startServer, client, eventBody, makeEvent, counts, findLeaks, CHECKS, CONTACT_FIELDS };
