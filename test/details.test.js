// An event's details (lib/details.js): the extra fields a host adds under
// the description, like a link, the dress code or parking. What the API
// takes and refuses, the round trip, who sees which (parking, a place to
// stay and a phone number are kept from people signed out, and from
// people a host removed, like the street address), the calendar feed,
// and how the event page and the editor draw them.
//
// Every answer here also goes through the harness's leak walker and spec
// check. The phone numbers the hosts type are made up and none of the
// fixture people's, so a walker hit would be a real leak.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, makeEvent, findLeaks, calendarAuth } = require('./harness');
const { cleanDetails, cleanUrl, telHref } = require('../lib/details');
const UI = require('../public/ui.js');

const HOST_PHONE = '(415) 555-0199';

const ALL = [
  { type: 'link', label: 'Tickets', value: 'https://tickets.example.com/rooftop?x=1' },
  { type: 'info', value: 'Doors at 7.\nBring a jacket.' },
  { type: 'dress_code', value: 'Black & white' },
  { type: 'food', label: 'Potluck', value: 'Bring a dish <to share>' },
  { type: 'parking', value: 'Garage on 2nd, code 4512' },
  { type: 'accommodation', value: 'Spare room at the Lis' },
  { type: 'phone', label: "Ana's cell", value: `  ${HOST_PHONE}  ` },
  { type: 'link', value: 'partiful.com/e/abc' }
];

const PUBLIC = ['link', 'info', 'dress_code', 'food'];

// GET a page as `who`, with nothing of anyone's contact details in it.
async function page(server, who, url) {
  const r = await who.get(url, { headers: { Accept: 'text/html' } });
  assert.deepEqual(findLeaks(r.text, null, server.people), [], `contact details in ${url}`);
  const start = r.text.indexOf('<body class=');
  const end = r.text.indexOf('<script type="application/json" id="pageData">');
  r.body = r.text.slice(start, end);
  return r;
}

test('cleaning: types, labels, values, links and phone numbers', () => {
  // A link: http(s) only, tidied; no scheme gets https; nothing else gets in.
  assert.equal(cleanUrl('partiful.com/e/x'), 'https://partiful.com/e/x');
  assert.equal(cleanUrl(' HTTPS://Example.COM/Path '), 'https://example.com/Path');
  assert.equal(cleanUrl('http://example.com'), 'http://example.com/');
  for (const bad of ['javascript:alert(1)', 'JavaScript:alert(document.cookie)', 'data:text/html,<b>x</b>', 'mailto:a@example.com',
    'ftp://example.com', '//example.com', 'https://party', 'https://bank.example@evil.example', 'example', 'vbscript:x', '']) {
    assert.equal(cleanUrl(bad), null, bad);
  }
  // A phone: as typed but trimmed, and its tel: link.
  assert.deepEqual(cleanDetails([{ type: 'phone', value: ` ${HOST_PHONE} ` }]).details, [{ type: 'phone', label: null, value: HOST_PHONE }]);
  assert.equal(telHref(HOST_PHONE), 'tel:4155550199');
  assert.equal(telHref('+44 20 7946 0958'), 'tel:+442079460958');
  // Text keeps its lines; a label is one line; an empty one is none.
  assert.deepEqual(cleanDetails([{ type: 'food', label: '  Kids\n menu ', value: 'a\r\nb ' }]).details, [{ type: 'food', label: 'Kids menu', value: 'a\nb' }]);
  assert.deepEqual(cleanDetails([{ type: 'info', label: '   ', value: 'x', extra: 1 }]).details, [{ type: 'info', label: null, value: 'x' }]);
  // Left out, cleared, and the refusals, each with the detail's index.
  assert.deepEqual(cleanDetails(undefined), { details: undefined });
  assert.deepEqual(cleanDetails(null), { details: [] });
  const refused = (raw) => cleanDetails(raw).error;
  assert.deepEqual(refused('nope').slice(0, 2), [400, 'bad_details']);
  assert.deepEqual(refused(Array(11).fill({ type: 'info', value: 'x' })).slice(0, 2), [400, 'too_many_details']);
  const ok = { type: 'info', value: 'x' };
  for (const [detail, reason] of [
    ['x', 'bad_detail'],
    [{ type: 'pets', value: 'x' }, 'bad_detail_type'],
    [{ type: 'info', label: 3, value: 'x' }, 'bad_detail_label'],
    [{ type: 'info', label: 'x'.repeat(61), value: 'x' }, 'detail_too_long'],
    [{ type: 'info', value: '  ' }, 'bad_detail_value'],
    [{ type: 'info' }, 'bad_detail_value'],
    [{ type: 'info', value: 'x'.repeat(501) }, 'detail_too_long'],
    [{ type: 'link', value: 'javascript:alert(1)' }, 'bad_detail_url'],
    [{ type: 'link', value: 'https://example.com/' + 'x'.repeat(490) }, 'detail_too_long'],
    [{ type: 'phone', value: 'call me' }, 'bad_detail_phone'],
    [{ type: 'phone', value: '12' }, 'bad_detail_phone']
  ]) {
    const e = refused([ok, detail]);
    assert.ok(e, JSON.stringify(detail));
    assert.deepEqual([e[1], e[3]], [reason, { index: 1 }], JSON.stringify(detail));
  }
  // At the limits is fine.
  assert.ok(cleanDetails([{ type: 'info', label: 'x'.repeat(60), value: 'x'.repeat(500) }]).details);
  assert.equal(cleanDetails(Array(10).fill(ok)).details.length, 10);
});

test('the API: set on create, replaced whole on edit, refused with the index, and who sees which', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const P = server.people;
  const [ana, ben, cy, una] = ['ana', 'ben', 'cy', 'una'].map((n) => client(server, n));
  const benApp = client(server, 'ben', { mode: 'bearer' });
  const anon = client(server, null);

  // None by default.
  const plain = await makeEvent(ana);
  assert.deepEqual([plain.details, plain.hiddenDetails], [[], 0]);

  const e = await makeEvent(ana, { details: ALL });
  const expected = [
    { type: 'link', label: 'Tickets', value: 'https://tickets.example.com/rooftop?x=1', href: 'https://tickets.example.com/rooftop?x=1' },
    { type: 'info', label: null, value: 'Doors at 7.\nBring a jacket.', href: null },
    { type: 'dress_code', label: null, value: 'Black & white', href: null },
    { type: 'food', label: 'Potluck', value: 'Bring a dish <to share>', href: null },
    { type: 'parking', label: null, value: 'Garage on 2nd, code 4512', href: null },
    { type: 'accommodation', label: null, value: 'Spare room at the Lis', href: null },
    { type: 'phone', label: "Ana's cell", value: HOST_PHONE, href: 'tel:4155550199' },
    { type: 'link', label: null, value: 'https://partiful.com/e/abc', href: 'https://partiful.com/e/abc' }
  ];
  assert.deepEqual(e.details, expected);
  assert.equal(e.hiddenDetails, 0);
  assert.deepEqual((await ana.get(`/api/v1/events/${e.id}`)).data.event.details, expected);

  // Signed in, a guest (by cookie or app), an unverified one, someone
  // just opening the link: all of them.
  await ben.put(`/api/v1/events/${e.id}/rsvp`, { status: 'going' });
  for (const who of [ben, benApp, una, cy]) {
    const got = (await who.get(`/api/v1/events/${e.id}`)).data.event;
    assert.deepEqual([got.details, got.hiddenDetails], [expected, 0], who.person.name);
  }
  // In lists too.
  const upcoming = (await ben.get('/api/v1/me/events/upcoming')).data.events.find((x) => x.id === e.id);
  assert.deepEqual(upcoming.details, expected);

  // Signed out: the public ones, in order, and how many are held back.
  const publicOnes = expected.filter((d) => PUBLIC.includes(d.type));
  const out = (await anon.get(`/api/v1/events/${e.id}`)).data.event;
  assert.deepEqual([out.details, out.hiddenDetails], [publicOnes, 3]);
  assert.ok(!JSON.stringify(out).includes('4512') && !JSON.stringify(out).includes('555-0199') && !JSON.stringify(out).includes('Spare room'));

  // Removed: the same as signed out (and no sign-in hint to give them).
  await ana.put(`/api/v1/events/${e.id}/removed/${P.ben.id}`);
  for (const who of [ben, benApp]) {
    const got = (await who.get(`/api/v1/events/${e.id}`)).data.event;
    assert.deepEqual([got.details, got.hiddenDetails], [publicOnes, 3]);
    assert.equal(got.viewer.rsvp.status, 'removed');
  }
  await ana.del(`/api/v1/events/${e.id}/removed/${P.ben.id}`);
  assert.equal((await ben.get(`/api/v1/events/${e.id}`)).data.event.hiddenDetails, 0, 'and back again when restored');

  // Only public ones: nothing held back.
  const open = await makeEvent(ana, { details: [{ type: 'food', value: 'Tacos' }] });
  assert.equal((await anon.get(`/api/v1/events/${open.id}`)).data.event.hiddenDetails, 0);

  // An edit replaces the whole list; leaving it out leaves it alone;
  // null and [] take them all off.
  let r = await ana.patch(`/api/v1/events/${e.id}`, { title: 'Renamed' });
  assert.deepEqual(r.data.event.details, expected);
  r = await ana.patch(`/api/v1/events/${e.id}`, { details: [{ type: 'dress_code', value: 'Costumes' }, { type: 'dress_code', label: 'Shoes', value: 'Flat' }] });
  assert.deepEqual(r.data.event.details.map((d) => [d.type, d.label, d.value]), [['dress_code', null, 'Costumes'], ['dress_code', 'Shoes', 'Flat']]);
  r = await ana.patch(`/api/v1/events/${e.id}`, { details: null });
  assert.deepEqual(r.data.event.details, []);
  r = await ana.patch(`/api/v1/events/${e.id}`, { details: [{ type: 'info', value: 'x' }] });
  r = await ana.patch(`/api/v1/events/${e.id}`, { details: [] });
  assert.deepEqual(r.data.event.details, []);

  // Refusals: 400, the reason, the index, and nothing changed.
  await ana.patch(`/api/v1/events/${e.id}`, { details: [{ type: 'food', value: 'Tacos' }] });
  for (const [body, reason, index] of [
    [{ details: [{ type: 'info', value: 'ok' }, { type: 'link', value: 'javascript:alert(1)' }] }, 'bad_detail_url', 1],
    [{ details: [{ type: 'link', value: 'data:text/html,hi' }] }, 'bad_detail_url', 0],
    [{ details: [{ type: 'pets', value: 'Dogs welcome' }] }, 'bad_detail_type', 0],
    [{ details: [{ type: 'info', value: 'x' }, { type: 'info', value: 'x' }, { type: 'info', value: 'x'.repeat(501) }] }, 'detail_too_long', 2],
    [{ details: [{ type: 'phone', value: 'ring me' }] }, 'bad_detail_phone', 0],
    [{ details: Array(11).fill({ type: 'info', value: 'x' }) }, 'too_many_details', undefined],
    [{ details: 'Tacos' }, 'bad_details', undefined]
  ]) {
    const res = await ana.patch(`/api/v1/events/${e.id}`, body);
    assert.equal(res.status, 400, reason);
    assert.equal(res.data.reason, reason);
    assert.equal(res.data.index, index, reason);
  }
  assert.deepEqual((await ana.get(`/api/v1/events/${e.id}`)).data.event.details.map((d) => d.value), ['Tacos']);
  // On create too, and a javascript: link never makes an event.
  const bad = await ana.post('/api/v1/events', { title: 'X', startsAt: '2030-01-01T20:00:00Z', timeZone: 'UTC', details: [{ type: 'link', label: 'Click', value: 'javascript:alert(1)' }] });
  assert.deepEqual([bad.status, bad.data.reason, bad.data.index], [400, 'bad_detail_url', 0]);
  // Guests can't set them.
  assert.equal((await ben.patch(`/api/v1/events/${e.id}`, { details: [] })).status, 403);
});

test('the calendar feed: every detail, in the description', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const P = server.people;
  const [ana, ben] = ['ana', 'ben'].map((n) => client(server, n));
  const anon = client(server, null);
  const e = await makeEvent(ana, { description: 'Dinner upstairs.', details: ALL });
  await ben.put(`/api/v1/events/${e.id}/rsvp`, { status: 'going' });
  const feed = async (p) => (await anon.get(`/api/calendar/${p.id}`, { headers: { Authorization: calendarAuth(p.id) } })).data.entries;
  const [entry] = await feed(P.ben);
  assert.equal(entry.description, [
    "You're going.",
    'Dinner upstairs.',
    [
      'Tickets: https://tickets.example.com/rooftop?x=1',
      'Info:\nDoors at 7.\nBring a jacket.',
      'Dress code: Black & white',
      'Potluck: Bring a dish <to share>',
      'Parking: Garage on 2nd, code 4512',
      'Where to stay: Spare room at the Lis',
      `Ana's cell: ${HOST_PHONE}`,
      'Link: https://partiful.com/e/abc'
    ].join('\n'),
    `${server.base}/e/${e.id}`
  ].join('\n\n'));
  // None: no empty paragraph.
  await ana.patch(`/api/v1/events/${e.id}`, { details: [] });
  assert.equal((await feed(P.ben))[0].description, ["You're going.", 'Dinner upstairs.', `${server.base}/e/${e.id}`].join('\n\n'));
});

test('the event page: a row per detail, links and phones to tap, and only what the API gave', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const P = server.people;
  const [ana, ben] = ['ana', 'ben'].map((n) => client(server, n));
  const anon = client(server, null);
  const e = await makeEvent(ana, { details: ALL });

  const detailsOf = (html) => {
    const start = html.indexOf('<div class="details-list" id="eventDetails">');
    if (start < 0) return null;
    return html.slice(start, html.indexOf('<div class="description">', start));
  };

  // Signed in: every row, in order, between the hosts and the description.
  const guest = (await page(server, ben, `/e/${e.id}`)).body;
  const list = detailsOf(guest);
  assert.ok(list, 'the details are drawn');
  assert.ok(guest.indexOf('Hosted by') < guest.indexOf('id="eventDetails"'), 'after the hosts');
  assert.deepEqual([...list.matchAll(/<div class="meta detail(?: detail-line)?" data-type="(\w+)"><svg/g)].map((m) => m[1]), ALL.map((d) => d.type));
  // A link: one line, no heading. Its text (or, with none, its address
  // without https://, www. or the last slash), the whole address as its
  // title, a new tab, no opener or referrer.
  assert.ok(list.includes('<div class="meta detail detail-line" data-type="link"><svg'), list);
  assert.ok(list.includes('<div class="what"><a class="detail-link" href="https://tickets.example.com/rooftop?x=1" title="https://tickets.example.com/rooftop?x=1" target="_blank" rel="noopener noreferrer">Tickets</a></div>'), list);
  assert.ok(list.includes('<div class="what"><a class="detail-link" href="https://partiful.com/e/abc" title="https://partiful.com/e/abc" target="_blank" rel="noopener noreferrer">partiful.com/e/abc</a></div>'));
  // A phone: one line, its label and a dot, then the number as a tel: link.
  assert.ok(list.includes(`<div class="meta detail detail-line" data-type="phone"><svg`));
  assert.ok(list.includes(`<div class="what"><span class="detail-label">Ana&#39;s cell</span> · <a href="tel:4155550199">${HOST_PHONE}</a></div>`));
  assert.ok(!/detail-heading">(Link|Phone)</.test(list), 'no Link or Phone heading');
  // Text: the default heading, escaped, line breaks kept (CSS pre-line).
  assert.ok(list.includes('<span class="detail-heading">Info</span><span class="sub detail-value">Doors at 7.\nBring a jacket.</span>'));
  assert.ok(list.includes('<span class="detail-heading">Dress code</span><span class="sub detail-value">Black &amp; white</span>'));
  assert.ok(list.includes('<span class="detail-heading">Potluck</span><span class="sub detail-value">Bring a dish &lt;to share&gt;</span>'));
  assert.ok(list.includes('<span class="detail-heading">Parking</span>') && list.includes('<span class="detail-heading">Where to stay</span>'));
  assert.ok(!list.includes('details-hidden'), 'nothing held back');

  // Signed out: the public rows, and a line saying there's more.
  const out = (await page(server, anon, `/e/${e.id}`)).body;
  const outList = detailsOf(out);
  assert.deepEqual([...outList.matchAll(/data-type="(\w+)"/g)].map((m) => m[1]), ['link', 'info', 'dress_code', 'food', 'link']);
  assert.ok(outList.includes('<p class="details-hidden">More details show once you sign in.</p>'));
  for (const secret of ['4512', 'Spare room', '555-0199', 'tel:']) assert.ok(!out.includes(secret), secret);
  // Never in the link preview, signed in or out.
  const meta = (await page(server, ben, `/e/${e.id}`)).text.split('</head>')[0];
  for (const word of ['Tickets', 'tickets.example', 'Black', 'Potluck', '4512', '555-0199', 'partiful']) assert.ok(!meta.includes(word), word);

  // Removed: the public rows, and no sign-in line (signing in won't help).
  await ana.put(`/api/v1/events/${e.id}/removed/${P.ben.id}`);
  const removed = (await page(server, ben, `/e/${e.id}`)).body;
  assert.deepEqual([...detailsOf(removed).matchAll(/data-type="(\w+)"/g)].map((m) => m[1]), ['link', 'info', 'dress_code', 'food', 'link']);
  assert.ok(!removed.includes('details-hidden') && !removed.includes('4512'));

  // Without labels: a phone is the number alone; a long address is cut
  // with an ellipsis, all of it in the title.
  const LONG = 'https://www.example.com/events/2030/rooftop-dinner-with-everyone-from-the-office/rsvp/';
  const bare = await makeEvent(ana, { details: [{ type: 'link', value: LONG }, { type: 'phone', value: HOST_PHONE }] });
  const bareList = detailsOf((await page(server, ben, `/e/${bare.id}`)).body);
  assert.ok(bareList.includes(`<a class="detail-link" href="${LONG}" title="${LONG}" target="_blank" rel="noopener noreferrer">example.com/events/2030/rooftop-dinner-with-eve…</a>`), bareList);
  assert.ok(bareList.includes(`<div class="what"><a href="tel:4155550199">${HOST_PHONE}</a></div>`), bareList);

  // None at all: no section.
  const none = await makeEvent(ana);
  assert.equal(detailsOf((await page(server, anon, `/e/${none.id}`)).body), null);
});

test('ui.js: details drawn safely, whatever comes', () => {
  const row = (x) => UI.detailRow({ label: null, href: null, ...x });
  // A link the API wouldn't give (javascript:, data:) is text, not a link.
  for (const href of ['javascript:alert(1)', 'data:text/html,x', ' https://x.example']) {
    const h = row({ type: 'link', value: href, href });
    assert.ok(!h.includes('<a '), h);
  }
  // A tel: that isn't digits is text.
  assert.ok(!row({ type: 'phone', value: 'x', href: 'tel:1;javascript:alert(1)' }).includes('<a '));
  // Markup in a label or value is escaped.
  const h = row({ type: 'link', label: '"><img src=x onerror=alert(1)>', value: 'https://x.example/', href: 'https://x.example/' });
  assert.ok(!h.includes('<img') && h.includes('&quot;&gt;&lt;img'), h);
  // A type this page doesn't know is left out.
  assert.equal(row({ type: 'pets', value: 'x' }), '');
  assert.equal(UI.linkHost('https://www.Example.com:8443/x'), 'example.com');
  // A link's own line: no scheme, no www., no last slash; long ones cut.
  assert.equal(UI.linkText('https://www.example.com/'), 'example.com');
  assert.equal(UI.linkText('http://example.com/a/b/?q=1'), 'example.com/a/b/?q=1');
  assert.equal(UI.linkText('https://example.com/' + 'x'.repeat(100)).length, 48);
  assert.ok(UI.linkText('https://example.com/' + 'x'.repeat(100)).endsWith('…'));
  // Signed in with nothing hidden and no rows: nothing at all.
  assert.equal(UI.detailsBlock({ details: [], hiddenDetails: 0 }, false), '');
  assert.equal(UI.detailsBlock({ details: [], hiddenDetails: 2 }, true), '');
  assert.match(UI.detailsBlock({ details: [], hiddenDetails: 2 }, false), /More details show once you sign in/);
});

test('the editor: the chips, and a row per detail with the right inputs', async (t) => {
  // A new event: the chips, in order, under the description, no rows yet.
  const fresh = UI.editorForm({ event: null }, { zone: 'UTC' });
  const chips = fresh.slice(fresh.indexOf('<div class="detail-chips"'));
  assert.ok(fresh.indexOf('id="description"') < fresh.indexOf('id="detailChips"'), 'below the description');
  assert.deepEqual([...chips.matchAll(/data-action="add-detail" data-type="(\w+)">([^<]+)<\/button>/g)].map((m) => [m[1], m[2]]), [
    ['link', '+ Link'], ['info', '+ Info'], ['dress_code', '+ Dress code'], ['food', '+ Food'],
    ['parking', '+ Parking'], ['accommodation', '+ Stay'], ['phone', '+ Phone']
  ]);
  assert.ok(fresh.includes('<div id="detailRows"></div>'));

  // Each type's row: its icon, its inputs, a ×.
  const link = UI.detailEditRow({ type: 'link' });
  assert.match(link, /^<div class="meta detail-edit" data-type="link"><svg/);
  // A link: the address first, then its text, whose placeholder is what
  // the page would show without one.
  assert.ok(link.indexOf('detail-value') < link.indexOf('detail-label'));
  assert.match(link, /class="soft detail-label"[^>]*placeholder="Link text"/);
  assert.match(UI.detailEditRow({ type: 'link', value: 'https://www.partiful.com/e/abc/' }), /class="soft detail-label"[^>]*placeholder="partiful.com\/e\/abc"/);
  assert.match(link, /<input type="text" class="soft detail-value" inputmode="url"/);
  assert.match(link, /data-action="remove-detail" aria-label="Remove link"/);
  // A phone: one line, the number; no label field (one it came with rides
  // along on the row).
  const phone = UI.detailEditRow({ type: 'phone' });
  assert.ok(!phone.includes('detail-label'));
  assert.match(phone, /<input type="text" class="soft detail-value" inputmode="tel"/);
  assert.match(UI.detailEditRow({ type: 'phone', label: 'Venue', value: '123' }), /data-type="phone" data-label="Venue">/);
  // No autocomplete or name of their own: the editor's noAutofill() does it.
  for (const html of [link, phone]) assert.ok(!/ (name|autocomplete)=/.test(html), html);
  const food = UI.detailEditRow({ type: 'food' });
  assert.match(food, /class="soft detail-label"[^>]*placeholder="Food"/);
  assert.match(food, /<textarea class="soft detail-value" maxlength="500"/);
  assert.match(UI.detailEditRow({ type: 'accommodation' }), /aria-label="Remove where to stay"/);
  assert.equal(UI.detailEditRow({ type: 'pets' }), '');

  // Editing: the event's own, filled in and escaped, in order.
  const edit = UI.editorForm({ event: { id: 'AAAAAAAAAAAA', title: 'X', startsAt: '2030-01-01T20:00:00.000Z', timeZone: 'UTC', details: [
    { type: 'phone', label: null, value: HOST_PHONE, href: 'tel:4155550199' },
    { type: 'info', label: 'A "note"', value: '<b>hi</b>\nthere', href: null }
  ] } }, {});
  const rows = edit.slice(edit.indexOf('<div id="detailRows">'), edit.indexOf('<div class="detail-chips"'));
  assert.deepEqual([...rows.matchAll(/data-type="(\w+)"/g)].map((m) => m[1]), ['phone', 'info']);
  assert.ok(rows.includes(`value="${HOST_PHONE}"`));
  assert.ok(rows.includes('value="A &quot;note&quot;"') && rows.includes('>&lt;b&gt;hi&lt;/b&gt;\nthere</textarea>'));
  // Ten already: no more chips.
  const full = UI.editorForm({ event: { id: 'AAAAAAAAAAAA', title: 'X', startsAt: '2030-01-01T20:00:00.000Z', timeZone: 'UTC',
    details: Array(10).fill({ type: 'info', label: null, value: 'x', href: null }) } }, {});
  assert.equal([...full.matchAll(/data-action="add-detail" data-type="\w+" disabled>/g)].length, 7);

  // As the server draws it for the host, from the API's answer.
  const server = await startServer();
  t.after(() => server.stop());
  const ana = client(server, 'ana');
  const e = await makeEvent(ana, { details: [{ type: 'parking', value: 'Garage on 2nd' }] });
  const html = (await page(server, ana, `/e/${e.id}/edit`)).body;
  assert.ok(html.includes('<div class="meta detail-edit" data-type="parking">'));
  assert.ok(html.includes('>Garage on 2nd</textarea>'));
  assert.ok(html.includes('id="detailChips"'));
});
