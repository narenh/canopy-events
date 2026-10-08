// openapi.yaml against the server: every /api/v1 route Express has is in
// the spec and every operation in the spec is a route; every operation is
// documented properly; the examples are valid; the response checker that
// runs on every answer (harness.js) really does catch drift; and the spec
// and its rendered page are served, with the renderer from here, not a CDN.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const YAML = require('yaml');
const { spec, ajv, operations, checkResponse, escape } = require('./openapi');
const { startServer, client, makeEvent } = require('./harness');

// server.js in this process, only to ask Express what routes it has.
function expressRoutes() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-events-spec-'));
  Object.assign(process.env, { DATA_DIR: dir, CANOPY_ACCOUNT_URL: 'http://127.0.0.1:9', CANOPY_ACCOUNT_KEY: 'unused' });
  const { apiRoutes } = require('../server');
  return apiRoutes().map((r) => `${r.method.toUpperCase()} ${r.path}`);
}

test('every /api/v1 route is in openapi.yaml, and every operation in it is a route', () => {
  const routes = expressRoutes().sort();
  const documented = operations.map((o) => `${o.method.toUpperCase()} ${o.path}`).sort();
  assert.ok(routes.length >= 14, routes.join('\n'));
  assert.deepEqual(routes, documented);
});

test('every operation is documented properly', () => {
  assert.equal(spec.openapi, '3.1.0');
  assert.deepEqual(Object.keys(spec.components.securitySchemes).sort(), ['bearerAuth', 'cookieAuth']);
  const ids = new Set();
  for (const { method, path: p, op } of operations) {
    const name = `${method.toUpperCase()} ${p}`;
    assert.ok(op.operationId && !ids.has(op.operationId), `${name}: a unique operationId`);
    ids.add(op.operationId);
    assert.ok(op.summary, `${name}: a summary`);
    assert.ok(Object.keys(op.responses).some((s) => /^2/.test(s)), `${name}: a success response`);
    for (const [status, r] of Object.entries(op.responses)) assert.ok(r.$ref || r.description, `${name} ${status}: a description`);
    const security = op.security || spec.security;
    const needsAuth = security.length > 0 && !security.some((s) => Object.keys(s).length === 0);
    if (needsAuth) assert.ok(op.responses['401'], `${name}: signed in only, so it lists 401`);
    if (['post', 'put', 'patch', 'delete'].includes(method) && needsAuth) {
      assert.ok(op.responses['403'], `${name}: a change, so it lists 403 (bad_origin)`);
    }
    if (p.includes('{id}')) assert.ok(op.responses['404'], `${name}: an event, so it lists 404`);
  }
});

test('the examples in the spec are valid against their own schemas', () => {
  let n = 0;
  for (const [name, schema] of Object.entries(spec.components.schemas)) {
    if (schema.example === undefined) continue;
    const validate = ajv.getSchema(`openapi#/components/schemas/${escape(name)}`);
    assert.ok(validate(schema.example), `${name}'s example: ${ajv.errorsText(validate.errors)}`);
    n++;
  }
  assert.ok(n >= 4);
});

test('the response checker catches drift', () => {
  const person = { id: 'p', firstName: 'A', lastName: 'B', shortName: 'A B', photoUrl: null };
  const ok = { guestsVisible: true, guests: [{ person, status: 'going', guests: 0, respondedAt: null }], counts: { going: 1, maybe: 0, notGoing: 0, invited: 0, waitlisted: 0 }, nextCursor: null };
  const url = '/api/v1/events/AAAAAAAAAAAA/guests';
  checkResponse({ method: 'GET', url, status: 200, data: ok });
  // A person with one field too many: exactly what a leak would look like.
  const leaky = JSON.parse(JSON.stringify(ok));
  leaky.guests[0].person.email = 'x@example.com';
  assert.throws(() => checkResponse({ method: 'GET', url, status: 200, data: leaky }), /must NOT have additional properties/);
  assert.throws(() => checkResponse({ method: 'GET', url, status: 200, data: { ...ok, counts: undefined } }), /counts/);
  // A status the operation doesn't list, and a route that isn't in it.
  assert.throws(() => checkResponse({ method: 'GET', url, status: 418, data: {} }), /doesn't list/);
  assert.throws(() => checkResponse({ method: 'POST', url, status: 200, data: {} }), /isn't in openapi.yaml/);
  // Errors have their shape too.
  assert.throws(() => checkResponse({ method: 'GET', url, status: 404, data: { message: 'nope' } }), /must have required property/);
});

test('the spec and the docs page are served, the renderer from here', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const r = await fetch(server.base + '/api/v1/openapi.yaml');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^application\/yaml/);
  assert.deepEqual(YAML.parse(await r.text()), spec);

  const page = await fetch(server.base + '/docs');
  assert.equal(page.status, 200);
  const html = await page.text();
  const scripts = Array.from(html.matchAll(/<script src="([^"]+)"/g)).map((m) => m[1]);
  assert.deepEqual(scripts, ['/vendor/redoc-2.5.4/redoc.standalone.js']);
  assert.ok(!/https?:\/\//.test(html), 'nothing loaded from anywhere else');
  assert.match(html, /\/api\/v1\/openapi\.yaml/);
  const js = await fetch(server.base + scripts[0]);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.ok((await js.text()).length > 500000);
  for (const f of ['LICENSE', 'redoc.standalone.js.LICENSE.txt']) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', 'vendor', 'redoc-2.5.4', f)), f);
  }
});

test('one real answer of each kind is checked against the spec (through the harness)', async (t) => {
  // The harness checks every answer in every test file; this is a quick,
  // self-contained proof that it's on.
  const server = await startServer();
  t.after(() => server.stop());
  const ana = client(server, 'ana');
  const e = await makeEvent(ana);
  const r = await ana.get(`/api/v1/events/${e.id}`);
  assert.equal(r.status, 200);
  assert.ok(r.data.event.friendsGoing);
});
