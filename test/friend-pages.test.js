// The friends pages: /friends (your link and its QR code, adding by phone
// or Instagram, your list with Remove) and /f/<code> (someone's link:
// signed out, signed in, your own, already friends, a wrong one). Opening
// a link page adds nobody. Every page is searched for contact details.

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

test('friend pages', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const P = server.people;
  const [ana, ben, cy, dee, una] = ['ana', 'ben', 'cy', 'dee', 'una'].map((n) => client(server, n));
  const anon = client(server, null);
  const ids = async (who) => (await who.get('/api/v1/me/friends?limit=100')).data.friends.map((f) => f.person.id).sort();

  // Ana invited Ben (friends by invitation), and added Cy by id.
  const party = await makeEvent(ana, { title: 'Party' });
  await ana.post(`/api/v1/events/${party.id}/invites`, { personIds: [P.ben.id] });
  await ana.post('/api/v1/me/friends', { personId: P.cy.id });
  const link = (await ana.get('/api/v1/me/friend-link')).data;

  await t.test('/friends: the link, a QR code that scans to it, Share, Copy and Reset', async () => {
    const r = await page(server, ana, '/friends');
    assert.equal(r.status, 200);
    const box = section(r.body, 'friendLink');
    assert.ok(box.includes(`value="${link.url}"`));
    for (const action of ['share-link', 'copy-link', 'reset-link']) assert.ok(box.includes(`data-action="${action}"`), action);
    const svg = /<svg[\s\S]*?<\/svg>/.exec(box);
    assert.ok(svg, 'the QR code is inline');
    assert.equal(await scan(svg[0]), link.url);
  });

  await t.test('/friends: adding by phone or Instagram for verified people; the list, how each is in it, with Remove', async () => {
    const r = await page(server, ana, '/friends');
    const lookup = section(r.body, 'lookup');
    assert.ok(lookup.includes('Add by phone or Instagram') && lookup.includes('id="lookupForm"'));
    const list = section(r.body, 'friends');
    assert.match(list, /Ben Okafor<\/div><div class="sub">Invitation</);
    assert.match(list, /Cy Park<\/div><div class="sub">Added</);
    assert.ok(list.includes(`data-action="remove-friend" data-person="${P.cy.id}"`));
    assert.ok(list.includes('id="noFriends" style') && list.includes('class="empty hidden"'));
    // Unverified: no lookup, a way to confirm the email instead; and an
    // empty list says how to get friends.
    const quick = await page(server, una, '/friends');
    const ql = section(quick.body, 'lookup');
    assert.ok(!ql.includes('lookupForm') && ql.includes('Confirm your email to add people'));
    assert.ok(section(quick.body, 'friendLink').includes('<svg'), 'a quick account has a link too');
    assert.ok(quick.body.includes('class="empty" id="noFriends"'));
    assert.equal((await page(server, anon, '/friends')).status, 302);
  });

  await t.test('/f/<code> signed out: who it is, sign up or sign in to add them, and back here', async () => {
    const r = await page(server, anon, `/f/${link.code}`);
    assert.equal(r.status, 200);
    const card = section(r.body, 'friendInvite');
    assert.ok(card.includes('Ana Lima on Canopy'));
    assert.ok(card.includes('Sign up to add Ana'));
    const back = encodeURIComponent(`${server.base}/f/${link.code}`);
    assert.ok(card.includes(`quick=1&amp;return=${back}`), card);
    assert.ok(card.includes(`?return=${back}`));
    assert.ok(!card.includes('data-action="accept"'));
    // The preview: the first name, no photo.
    assert.equal(meta(r.text, 'og:title'), 'Add Ana on Canopy');
    assert.equal(meta(r.text, 'og:description'), "Ana's friend link on Canopy Events.");
    assert.equal(meta(r.text, 'og:image'), null);
    assert.ok(!/<meta[^>]*Lima/.test(r.text), 'no last name in the preview');
  });

  await t.test('/f/<code> signed in: one question and one button; opening it adds nobody', async () => {
    const before = [await ids(dee), await ids(ana)];
    const r = await page(server, dee, `/f/${link.code}`);
    const card = section(r.body, 'friendInvite');
    assert.ok(card.includes('Add Ana Lima as a friend?'));
    assert.ok(card.includes('id="acceptBtn" data-action="accept"'));
    assert.deepEqual([await ids(dee), await ids(ana)], before, 'nobody added by opening it');
    // Saying yes (what the button does), then the page says they're friends.
    assert.equal((await dee.post(`/api/v1/friend-links/${link.code}/accept`)).status, 200);
    const after = await page(server, dee, `/f/${link.code}`);
    assert.ok(section(after.body, 'friendInvite').includes('You and Ana are friends'));
    assert.ok(!after.body.includes('data-action="accept"'));
    // An unverified account can say yes too.
    assert.ok(section((await page(server, una, `/f/${link.code}`)).body, 'friendInvite').includes('data-action="accept"'));
  });

  await t.test('/f/<code>: your own link says so; a wrong or reset one is a 404 page', async () => {
    const own = await page(server, ana, `/f/${link.code}`);
    assert.ok(section(own.body, 'friendInvite').includes('This is your friend link'));
    assert.ok(!own.body.includes('data-action="accept"'));
    for (const bad of ['AAAAAAAAAAAA', 'nope']) {
      const r = await page(server, ben, `/f/${bad}`);
      assert.equal(r.status, 404);
      assert.ok(r.body.includes('This link doesn&#39;t work'));
    }
    await ana.post('/api/v1/me/friend-link/reset');
    assert.equal((await page(server, anon, `/f/${link.code}`)).status, 404);
  });

  await t.test('the invite sheet offers added friends too, each saying how they are in your list', async () => {
    const friends = (await ana.get('/api/v1/me/friends?limit=100')).data.friends;
    const people = {};
    friends.forEach((f) => { people[f.person.id] = { person: f.person, sub: UI.friendSub(f, 'invite') }; });
    const html = UI.inviteResults({ me: { id: P.ana.id }, people, suggestedIds: [], lists: [], past: [], onList: {}, selected: [], query: '' });
    assert.match(html, /Cy Park<\/div><div class="sub">Added</);
    assert.match(html, /Dee Ruiz<\/div><div class="sub">Friend link</);
  });
});
