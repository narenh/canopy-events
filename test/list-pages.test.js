// The lists pages: /friends ("Your lists", with links, QR codes and who's
// on each; "Lists you're on", with Leave), /l/<code> (signed out, signed
// in, your own, already on it, a wrong one; opening it joins nobody), the
// QR code image, and on an event the guest's "Get invited next time" and
// the host's Lists… and Show list QR. Every page is searched for contact
// details.

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const jsQR = require('jsqr');
const { startServer, client, makeEvent, findLeaks } = require('./harness');
const UI = require('../public/ui.js');

async function page(server, who, url) {
  const c = who && who.get ? who : client(server, who);
  const r = await c.get(url, { headers: { Accept: 'text/html' } });
  assert.deepEqual(findLeaks(r.text, null, server.people), [], `contact details in ${url}`);
  const start = r.text.indexOf('<body class=');
  const end = r.text.indexOf('<script type="application/json" id="pageData">');
  r.body = start < 0 ? r.text : r.text.slice(start, end < 0 ? undefined : end);
  return r;
}

function section(html, id) {
  const start = html.indexOf(`id="${id}"`);
  if (start < 0) return null;
  const end = html.indexOf('<section', start);
  return html.slice(start, end < 0 ? undefined : end);
}

function meta(html, key) {
  const m = new RegExp(`<meta (?:property|name)="${key.replace(/[:.]/g, '\\$&')}" content="([^"]*)">`).exec(html);
  return m ? m[1].replace(/&#39;/g, "'").replace(/&amp;/g, '&') : null;
}

async function scan(svg) {
  const { data, info } = await sharp(Buffer.from(svg), { density: 300 }).resize(300, 300, { kernel: 'nearest' })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const found = jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), info.width, info.height);
  return found && found.data;
}

test('list pages', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const P = server.people;
  const [ana, ben, cy, una] = ['ana', 'ben', 'cy', 'una'].map((n) => client(server, n));
  const anon = client(server, null);
  const drag = (await ana.post('/api/v1/me/lists', { name: 'Drag Race' })).data.list;
  await ben.post(`/api/v1/list-links/${drag.code}/join`);

  await t.test('/l/<code> signed out: the list and its owner, sign up or sign in and back here; previews say little', async () => {
    const r = await page(server, anon, `/l/${drag.code}`);
    assert.equal(r.status, 200);
    const card = section(r.body, 'listInvite');
    assert.ok(card.includes('<h1>Drag Race</h1>'));
    assert.ok(card.includes('Ana Lima&#39;s list on Canopy'));
    assert.ok(card.includes('Sign up to join') && card.includes('quick=1'));
    assert.ok(card.includes(encodeURIComponent(`/l/${drag.code}`)), 'comes back here');
    assert.ok(!card.includes('data-action="join"'));
    assert.equal(meta(r.text, 'og:title'), 'Join Drag Race on Canopy');
    assert.equal(meta(r.text, 'og:description'), "Ana's list on Canopy Events.");
    assert.equal(meta(r.text, 'og:image'), null);
    assert.ok(['og:title', 'og:description', 'twitter:title', 'description'].every((k) => !meta(r.text, k).includes('Lima')), 'no full name in the preview');
  });

  await t.test('/l/<code> signed in: one confirm card; opening joins nobody; your own and already on it say so', async () => {
    const r = await page(server, cy, `/l/${drag.code}`);
    const card = section(r.body, 'listInvite');
    assert.ok(card.includes('Join Ana&#39;s Drag Race?'));
    assert.ok(card.includes('Ana will be able to invite you to events.'));
    assert.ok(card.includes('data-action="join"'));
    assert.deepEqual((await cy.get('/api/v1/me/list-memberships')).data.lists, [], 'opening it joined nobody');
    const own = section((await page(server, ana, `/l/${drag.code}`)).body, 'listInvite');
    assert.ok(own.includes('This is your list') && own.includes('href="/friends#lists"') && !own.includes('data-action="join"'));
    const member = section((await page(server, ben, `/l/${drag.code}`)).body, 'listInvite');
    assert.ok(member.includes('You&#39;re on Ana&#39;s Drag Race') && !member.includes('data-action="join"'));
    assert.ok(member.includes('href="/"'));
    // After joining (drawn in the browser): the invitations it brought.
    const after = UI.listLinkPage({ me: { id: 'x' }, list: { name: 'Drag Race' }, owner: { firstName: 'Ana', lastName: 'Lima' }, viewer: { isOwner: false, isMember: false }, joined: { invitedTo: 2 } });
    assert.ok(after.includes('Ana invited you to 2 events.') && after.includes('href="/?tab=invited"'));
    for (const bad of ['AAAAAAAAAAAA', 'nope']) {
      const x = await page(server, ben, `/l/${bad}`);
      assert.equal(x.status, 404);
      assert.ok(x.body.includes('This link doesn&#39;t work'));
    }
  });

  await t.test('the QR code image scans to the list link; anything not shaped like a code is a 404', async () => {
    const r = await anon.get(`/l/${drag.code}/qr.svg`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /^image\/svg\+xml/);
    assert.equal(await scan(r.text), drag.url);
    assert.equal((await anon.get('/l/nope/qr.svg')).status, 404);
  });

  await t.test('/friends: your lists a row each, opening a sheet with the link, QR, rename, reset, delete and who is on it; the lists you are on, with Leave', async () => {
    const r = await page(server, ana, '/friends');
    const box = section(r.body, 'lists');
    assert.ok(box.includes('<h2>Your lists</h2>'));
    assert.match(box, new RegExp(`<button type="button" class="list-open" id="openList-${drag.id}" data-action="open-list" data-list="${drag.id}" aria-haspopup="dialog">.*Drag Race</span><span class="sub">1 person</span>`));
    // Who's on it is in the sheet, not on the page.
    assert.ok(!box.includes('Ben Okafor') && !box.includes('remove-member') && !box.includes(drag.url));
    assert.ok(box.includes('id="createList"') && box.includes('placeholder="Name a new list"'));
    // The sheet, drawn from what the API gives Ana.
    const members = (await ana.get(`/api/v1/me/lists/${drag.id}/members`)).data.members;
    const own = (await ana.get('/api/v1/me/lists')).data.lists.find((l) => l.id === drag.id);
    const sheet = UI.listSheet({ list: own, members, query: '', mode: 'members' });
    assert.match(sheet, /role="dialog" aria-modal="true" aria-labelledby="listHeading"/);
    assert.ok(sheet.includes('<h2 id="listHeading">Drag Race</h2>') && sheet.includes('data-action="close-list" aria-label="Close"'));
    assert.ok(sheet.includes(`value="${drag.url}"`));
    for (const action of ['share-list', 'copy-list', 'toggle-qr', 'rename-list', 'reset-list', 'delete-list', 'remove-member', 'add-people']) assert.ok(sheet.includes(`data-action="${action}"`), action);
    assert.match(sheet, /People · 1<\/h3><button type="button" class="small-btn" data-action="add-people"[^>]*>Add people<\/button>/);
    assert.match(sheet, /<ul class="people rows"><li class="person"[^>]*>.*Ben Okafor<\/div><div class="sub">Joined /);
    assert.ok(sheet.includes('id="memberSearch"') && sheet.includes('aria-label="Search the people on Drag Race"'));
    // Searching: only who matches, or a line.
    assert.ok(UI.listMembersResults({ list: drag, members, query: 'ben' }).includes('Ben Okafor'));
    assert.ok(UI.listMembersResults({ list: drag, members, query: 'zed' }).includes('No one on it by that name.'));
    // Added by Ana: "Added", not "Joined".
    assert.ok(UI.listMembersResults({ list: drag, members: [{ ...members[0], source: 'added' }] }).includes('<div class="sub">Added '));
    assert.equal(section(r.body, 'memberships'), null, "Ana isn't on any");
    // Ben: none of his own, Ana's in "Lists you're on", and nobody else on it.
    const b = await page(server, ben, '/friends');
    assert.ok(!section(b.body, 'lists').includes('list-item'));
    const mine = section(b.body, 'memberships');
    assert.ok(mine.includes('Lists you&#39;re on') && mine.includes('Drag Race') && mine.includes('Ana Lima&#39;s list') && mine.includes('data-action="leave-list"'));
    assert.ok(!b.body.includes('Joined '), 'a member never sees who joined');
    // Quick accounts can't make lists: told how instead.
    const q = section((await page(server, una, '/friends')).body, 'lists');
    assert.ok(!q.includes('id="createList"') && q.includes('Confirm your email to make lists.'));
    // The QR code, once opened, is the image of the list link.
    assert.ok(UI.listSheet({ list: drag, members: [], qr: true }).includes(`<img src="/l/${drag.code}/qr.svg"`));
    assert.ok(UI.listSheet({ list: drag, members: [] }).includes('Add people, or share the link or QR code'));
  });

  await t.test('an event: guests get "Get invited next time"; hosts get Lists… and Show list QR', async () => {
    const e = await makeEvent(ana, { title: 'Drag Race night' });
    // No list on it: no card, and no QR item.
    assert.equal(section((await page(server, cy, `/e/${e.id}`)).body, 'joinList'), null);
    let host = section((await page(server, ana, `/e/${e.id}`)).body, 'host');
    assert.ok(host.includes('data-action="lists"') && !host.includes('data-action="show-list-qr"'));
    await ana.put(`/api/v1/events/${e.id}/lists/${drag.id}`);
    host = section((await page(server, ana, `/e/${e.id}`)).body, 'host');
    assert.ok(host.includes('data-action="show-list-qr"'));
    // Cy (not on it), signed in: joins in one tap.
    await cy.put(`/api/v1/events/${e.id}/rsvp`, { status: 'going' });
    const card = section((await page(server, cy, `/e/${e.id}`)).body, 'joinList');
    assert.ok(card.includes('Get invited next time'));
    assert.ok(card.includes('Join Ana&#39;s Drag Race? Ana will be able to invite you to events.'));
    assert.match(card, new RegExp(`data-action="join-list" data-code="${drag.code}"[^>]*>Join Drag Race</button>`));
    // Signed out: the list's own page.
    const out = section((await page(server, anon, `/e/${e.id}`)).body, 'joinList');
    assert.ok(out.includes(`href="/l/${drag.code}"`) && !out.includes('data-action="join-list"'));
    // Ben (on it): nothing. Ana (hosting): nothing.
    assert.equal(section((await page(server, ben, `/e/${e.id}`)).body, 'joinList'), null);
    assert.equal(section((await page(server, ana, `/e/${e.id}`)).body, 'joinList'), null);
    // The host's lists block, and the QR sheet, drawn by the page's script.
    const ev = (await ana.get(`/api/v1/events/${e.id}`)).data.event;
    const block = UI.eventListsBlock(ev, 'upcoming', { myLists: [drag, { id: 'BBBBBBBBBBBB', name: 'Book club', memberCount: 3 }] });
    assert.match(block, /Drag Race<\/div><div class="sub">Your list · 1 person<\/div><\/div><button[^>]*data-action="detach-list"/);
    assert.match(block, /Book club<\/div><div class="sub">3 people<\/div><\/div><button[^>]*data-action="attach-list"/);
    assert.ok(block.includes('id="newEventList"'));
    assert.ok(!UI.eventListsBlock(ev, 'over', { myLists: [] }).includes('attach-list'), 'nothing to add to an event that is over');
    const sheet = UI.listQrSheet(ev.hostLists);
    assert.match(sheet, /role="dialog" aria-modal="true" aria-labelledby="listQrHeading"/);
    assert.ok(sheet.includes(`/l/${drag.code}/qr.svg`) && sheet.includes('alt="QR code for the Drag Race link"'));
    // After joining, the card says so (drawn in the browser).
    assert.ok(UI.joinListSection(ev, { me: {}, joinedList: { first: 'Ana', name: 'Drag Race' } }).includes('You&#39;re on Ana&#39;s Drag Race.'));
    assert.equal(P.ana.id, ev.hostLists[0].owner.id);
  });
});
