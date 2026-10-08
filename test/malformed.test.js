// Malformed requests are the caller's fault: a 4xx in the API's shape,
// never a 500. From the security review's fuzz.js: a cut-off cover
// upload, URLs whose %-escapes don't decode, and a spread of odd bodies
// and query strings on every route that takes one.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, makeEvent } = require('./harness');
const { checkResponse } = require('./openapi');

test('malformed requests get a 4xx, not a 500', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const ana = client(server, 'ana');
  const e = await makeEvent(ana);
  const E = `/api/v1/events/${e.id}`;

  // A request as a browser page sends it, with nothing added: the body and
  // its Content-Type exactly as given. JSON answers from the API are still
  // held to the spec.
  async function raw(method, url, body, headers = {}) {
    const h = { Cookie: `canopy_session=${server.people.ana.token}`, Origin: server.base, ...headers };
    if (body !== undefined && !h['Content-Type']) h['Content-Type'] = 'application/json';
    const res = await fetch(server.base + url, { method, headers: h, body });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (err) {}
    if (url.startsWith('/api/v1') && data !== null) checkResponse({ method, url, status: res.status, data });
    return { status: res.status, data, text, type: res.headers.get('content-type') };
  }

  await t.test('a cut-off cover upload is 400 bad_image', async () => {
    const body = '--x\r\nContent-Disposition: form-data; name="cover"; filename="a"\r\n\r\nhello';
    const r = await raw('PUT', `${E}/cover`, body, { 'Content-Type': 'multipart/form-data; boundary=x' });
    assert.equal(r.status, 400, r.text);
    assert.equal(r.data.reason, 'bad_image');
    // A form with no boundary at all, likewise.
    const r2 = await raw('PUT', `${E}/cover`, 'whatever', { 'Content-Type': 'multipart/form-data' });
    assert.equal(r2.status, 400, r2.text);
    assert.equal(r2.data.reason, 'bad_image');
  });

  await t.test("a URL that doesn't decode is 400 bad_request in the API", async () => {
    for (const [method, url] of [['get', '/api/v1/events/%'], ['get', '/api/v1/events/%E0%A4%A/guests'], ['del', `${E}/wall/%zz`]]) {
      const r = await ana[method](url);
      assert.equal(r.status, 400, `${url}: ${r.text}`);
      assert.equal(r.data.reason, 'bad_request', url);
    }
  });

  await t.test("...and a 'nothing here' page, or plain text, for a page", async () => {
    let r = await fetch(`${server.base}/e/%E0%A4%A`, { headers: { Accept: 'text/html' } });
    assert.equal(r.status, 404);
    assert.match(r.headers.get('content-type'), /^text\/html/);
    await r.text();
    r = await fetch(`${server.base}/e/%E0%A4%A`);
    assert.equal(r.status, 400);
    assert.match(r.headers.get('content-type'), /^text\/plain/);
    await r.text();
  });

  await t.test('odd bodies and query strings never make a 500 (fuzz.js)', async () => {
    const bodies = ['null', '[]', '"x"', '1', '{"status":{"a":1}}', '{"guests":1e400}', '{"personIds":[{}]}',
      '{"personId":["x"]}', '{"text":["a"]}', '{"ids":["1",null]}', '{"startsAt":"2026-13-45T99:99Z","timeZone":"Mars/Base"}',
      '{"capacity":"5"}', '{"title":"' + 'a'.repeat(200) + '","timeZone":{"toString":1}}', '{"token":{"length":20}}',
      '{"__proto__":{"admin":true},"status":"going"}', '{"broken'];
    const routes = [['PUT', `${E}/rsvp`], ['PATCH', E], ['POST', '/api/v1/events'], ['POST', `${E}/invites`],
      ['POST', `${E}/cohosts`], ['POST', `${E}/wall`], ['POST', '/api/v1/me/notifications/read'], ['POST', '/api/v1/me/devices'], ['POST', '/api/v1/people/lookup'],
      ['DELETE', '/api/v1/me/devices'], ['PUT', `${E}/cover`]];
    const fiveHundreds = [];
    for (const [method, url] of routes) {
      for (const body of bodies) {
        const r = await raw(method, url, body);
        if (r.status >= 500) fiveHundreds.push(`${r.status} ${method} ${url} ${body}`);
      }
    }
    const b64 = (v) => Buffer.from(v).toString('base64url');
    const gets = [`${E}/guests?limit=1e1`, `${E}/guests?limit[]=1`, `${E}/guests?cursor[a]=1`, `${E}/guests?status[]=going`,
      `${E}/guests?cursor=${b64('[1e300,"x"]')}`, `${E}/wall?cursor=${b64('["a","b"]')}`, `/api/v1/me/events/past?cursor=${b64('[1,{}]')}`,
      '/api/v1/events/%', '/e/%E0%A4%A',
      `${E}/wall/99999999999999999`, '/covers/..%2f..%2fevents.db', '/covers/%2e%2e', '/covers/%'];
    for (const url of gets) {
      const r = await raw('GET', url);
      if (r.status >= 500) fiveHundreds.push(`${r.status} GET ${url}`);
    }
    const r = await raw('DELETE', `${E}/wall/99999999999999999`);
    if (r.status >= 500) fiveHundreds.push(`${r.status} DELETE wall entry`);
    assert.deepEqual(fiveHundreds, []);
    assert.equal((await fetch(`${server.base}/healthz`)).status, 200);
  });
});
