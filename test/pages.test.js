// The web pages, against the real server and the fake account service:
// each page as someone signed out, an unverified (quick) account, a
// verified guest and a host. What each should and shouldn't show, the
// link preview tags, and the never-leak rule: every page fetched here is
// searched for anyone's email, phone, Instagram, Venmo or Cash App (the
// pages need none of them, the visitor's own included).
//
// The pages draw what the API answers (routes/pages.js), so the API's own
// tests already cover the rules. These check the pages show them: the
// right sections, the address and the guest names only where they should
// be, and the same event the API gives that visitor.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, makeEvent, findLeaks } = require('./harness');
const UI = require('../public/ui.js');
const { ASSUMED_LENGTH_MS } = require('../lib/rules');

// GET a page as `who`. Checks there are no contact details anywhere in it.
async function page(server, who, url, headers = {}) {
  const c = who && who.get ? who : client(server, who);
  const r = await c.get(url, { headers: { Accept: 'text/html', ...headers } });
  const leaks = findLeaks(r.text, null, server.people);
  assert.deepEqual(leaks, [], `contact details in ${url}`);
  // What the page shows: its body, without the scripts inlined after it
  // (whose source would match anything the renderer can draw).
  const start = r.text.indexOf('<body class=');
  const end = r.text.indexOf('<script type="application/json" id="pageData">');
  r.body = start < 0 ? r.text : r.text.slice(start, end < 0 ? undefined : end);
  return r;
}

// The JSON a page was drawn from (its <script id="pageData">).
function pageData(html) {
  const m = /<script type="application\/json" id="pageData">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, 'page has its data');
  return JSON.parse(m[1]);
}

// One <section id="..."> of a page, up to the next section.
function section(html, id) {
  const start = html.indexOf(`id="${id}"`);
  if (start < 0) return null;
  const end = html.indexOf('<section', start);
  return html.slice(start, end < 0 ? undefined : end);
}

function meta(html, key) {
  const m = new RegExp(`<meta (?:property|name)="${key.replace(/[:.]/g, '\\$&')}" content="([^"]*)">`).exec(html);
  return m ? m[1].replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"') : null;
}

test('ui.js: the browser and server renderer', async (t) => {
  await t.test('an event with no end is over when lib/rules.js says', () => {
    assert.equal(UI.ASSUMED_LENGTH_MS, ASSUMED_LENGTH_MS);
  });

  await t.test("times are in the event's zone, labelled only when the viewer's clock reads differently", () => {
    const e = { startsAt: '2030-07-04T02:30:00.000Z', endsAt: '2030-07-04T05:00:00.000Z', timeZone: 'America/Los_Angeles' };
    const w = UI.when(e, 'America/Los_Angeles');
    assert.match(w.date, /^Wednesday, July 3, 2030$/);
    assert.equal(w.time, '7:30 PM – 10:00 PM');
    assert.equal(w.zoneNote, null);
    // Phoenix doesn't change its clocks: the same as LA in July.
    assert.equal(UI.when(e, 'America/Phoenix').zoneNote, null);
    // The zone by its friendly name, as everywhere on the event page.
    assert.equal(UI.when(e, 'Europe/London').zoneNote, 'Times are in Pacific Time.');
    // Unknown viewer (the server's first paint): always labelled.
    assert.ok(UI.when(e, null).zoneNote);
    assert.equal(UI.whenPreview(e), 'Wednesday, July 3, 2030, 7:30 PM – 10:00 PM PDT');
  });

  await t.test('the editor reads a typed time on the chosen zone\'s clock, either side of a clock change', () => {
    for (const [value, zone, iso] of [
      ['2030-03-09T19:30', 'America/Los_Angeles', '2030-03-10T03:30:00.000Z'], // PST, the day before
      ['2030-03-10T19:30', 'America/Los_Angeles', '2030-03-11T02:30:00.000Z'], // PDT, the day of
      ['2030-11-03T12:30', 'Europe/Paris', '2030-11-03T11:30:00.000Z'],
      ['2030-06-01T00:00', 'Asia/Kolkata', '2030-05-31T18:30:00.000Z']
    ]) {
      assert.equal(UI.fromLocalInput(value, zone), iso, `${value} ${zone}`);
      assert.equal(UI.localInput(iso, zone), value);
    }
    assert.equal(UI.fromLocalInput('', 'UTC'), '');
  });

  await t.test('what people typed is escaped, and only http(s) photos are used', () => {
    const html = UI.eventPage({
      me: null,
      links: { quickSignUp: 'https://a/?quick=1', signIn: 'https://a/' },
      event: {
        id: 'AAAAAAAAAAAA', url: 'https://e/e/AAAAAAAAAAAA', title: '<script>x</script>', description: '"><img onerror=1>',
        startsAt: '2030-01-01T20:00:00.000Z', endsAt: null, timeZone: 'UTC', locationName: '<b>', locationAddress: null,
        locationAddressHidden: true, status: 'active', counts: { going: 0, maybe: 0, notGoing: 0, invited: 0, waitlisted: 0 },
        hosts: [{ person: { id: 'x', firstName: '<i>', lastName: 'L', shortName: 'x', photoUrl: 'javascript:alert(1)' }, role: 'creator' }],
        viewer: null
      }
    }, {});
    assert.ok(!html.includes('<script>') && !html.includes('<img onerror') && !html.includes('<b>') && !html.includes('<i>'));
    assert.ok(!html.includes('javascript:'));
    assert.ok(html.includes('&lt;script&gt;x&lt;/script&gt;'));
  });
});

test('pages', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const P = server.people;
  const [ana, ben, cy, dee, una] = ['ana', 'ben', 'cy', 'dee', 'una'].map((n) => client(server, n));
  const anon = client(server, null);

  // Friends first: ana hosted something ben and cy went to.
  const before = await makeEvent(ana, { title: 'Picnic before' });
  await ben.put(`/api/v1/events/${before.id}/rsvp`, { status: 'going' });
  await cy.put(`/api/v1/events/${before.id}/rsvp`, { status: 'going' });
  server.setTimes(before.id, { startedAgoMs: 9 * 86400e3, overInMs: -8 * 86400e3 });

  // The event: guest list for everyone, ben going, cy maybe, dee invited.
  const party = await makeEvent(ana, { title: 'Rooftop dinner', guestListVisibility: 'everyone' });
  await ana.post(`/api/v1/events/${party.id}/invites`, { personIds: [P.dee.id] });
  await ben.put(`/api/v1/events/${party.id}/rsvp`, { status: 'going' });
  await cy.put(`/api/v1/events/${party.id}/rsvp`, { status: 'maybe' });

  // The same, with the list shown only to people who've answered.
  const quiet = await makeEvent(ana, { title: 'Quiet dinner', guestListVisibility: 'responded' });
  await ana.post(`/api/v1/events/${quiet.id}/invites`, { personIds: [P.dee.id] });
  await ben.put(`/api/v1/events/${quiet.id}/rsvp`, { status: 'going' });

  const ADDRESS = '1 Market St';

  await t.test('signed out: the public details, a big RSVP to quick sign-up, no address, no guests', async () => {
    const r = await page(server, anon, `/e/${party.id}`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const html = r.body;
    assert.ok(html.includes('Rooftop dinner'));
    assert.ok(html.includes('Ana&#39;s place'), 'the place name');
    assert.ok(!html.includes(ADDRESS), 'no street address');
    assert.ok(html.includes('The address shows once you sign in.'));
    assert.ok(html.includes('Hosted by Ana Lima'), 'hosts are public');
    for (const name of ['Ben', 'Okafor', 'Cy Park', 'Dee']) assert.ok(!html.includes(name), `no guest name: ${name}`);
    assert.ok(section(html, 'guests').includes('<p class="attend-sum">1 Going · 1 Maybe</p>'), 'counts are public');
    const here = encodeURIComponent(`${server.base}/e/${party.id}`);
    const rsvp = section(html, 'rsvp');
    assert.ok(rsvp.includes(`href="${server.fake.base}/?quick=1&amp;return=${here}">RSVP</a>`), rsvp);
    assert.ok(rsvp.includes(`href="${server.fake.base}/?return=${here}">I have a Canopy account, sign in</a>`));
    // Attending, signed out: the heading and counts, no faces, no list.
    const attend = section(html, 'guests');
    assert.ok(attend.includes('>Attending</h2>'));
    assert.ok(!attend.includes('avatar-row') && !attend.includes('View all'));
    assert.equal(section(html, 'host'), null);
    assert.ok(!html.includes('id="verifyBanner"'));
    assert.match(r.text, /<meta name="robots" content="noindex, nofollow">/);
    assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow');
    // What the page's script starts from is what the API gave a stranger.
    const d = pageData(r.text);
    assert.deepEqual(d.event, (await anon.get(`/api/v1/events/${party.id}`)).data.event);
    assert.equal(d.guests, null);
    assert.equal(d.me, null);
  });

  await t.test('link preview tags: title, date and place name, never the address', async () => {
    const html = (await page(server, anon, `/e/${party.id}`)).text;
    assert.equal(meta(html, 'og:title'), 'Rooftop dinner');
    assert.equal(meta(html, 'og:url'), `${server.base}/e/${party.id}`);
    assert.equal(meta(html, 'og:type'), 'website');
    assert.equal(meta(html, 'twitter:card'), 'summary');
    const desc = meta(html, 'og:description');
    assert.equal(desc, `${UI.whenPreview(party)} · Ana's place`);
    assert.match(desc, /(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \w+ \d+.* (PST|PDT) · Ana's place$/);
    assert.equal(meta(html, 'twitter:description'), desc);
    assert.equal(meta(html, 'og:image'), null, 'no cover image yet');
    // Signed in, the preview is the same: it never says the address.
    const signedIn = (await page(server, ben, `/e/${party.id}`)).text;
    assert.equal(meta(signedIn, 'og:description'), desc);
    assert.ok(!/<meta[^>]*1 Market/.test(signedIn));
  });

  await t.test('unverified: the full event, answering, and the banner that can\'t be closed', async () => {
    const html = (await page(server, una, `/e/${party.id}`)).body;
    const banner = /<div class="card verify-banner" id="verifyBanner"[\s\S]*?<\/div>/.exec(html);
    assert.ok(banner, 'the banner');
    assert.ok(banner[0].includes(`href="${server.fake.base}/profile?verify=1&amp;return=${encodeURIComponent(`${server.base}/e/${party.id}`)}"`), banner[0]);
    assert.ok(!/close|dismiss/i.test(banner[0]));
    assert.ok(html.includes(ADDRESS), 'signed in sees the address');
    const rsvp = section(html, 'rsvp');
    assert.ok(rsvp.includes('data-action="answer" data-status="going"'));
    assert.ok(rsvp.includes('Are you going?'));
    assert.ok(section(html, 'guests').includes('Ben Okafor'), 'everyone-visible list');
  });

  await t.test('a verified guest: their answer, friends going, the guest list', async () => {
    const r = await page(server, ben, `/e/${party.id}`);
    const html = r.body;
    assert.ok(!html.includes('id="verifyBanner"'));
    const rsvp = section(html, 'rsvp');
    assert.ok(rsvp.includes('data-status="going" aria-pressed="true"'), rsvp);
    assert.ok(rsvp.includes('data-status="maybe" aria-pressed="false"'));
    assert.ok(rsvp.includes('Take back my answer'));
    assert.equal(section(html, 'host'), null, 'no host tools');
    const guests = section(html, 'guests');
    assert.ok(guests.includes('Going · 1') && guests.includes('Ben Okafor'));
    assert.ok(guests.includes('Maybe · 1') && guests.includes('Cy Park'));
    assert.ok(!guests.includes('Dee Ruiz'), 'only hosts see who is invited and hasn\'t answered');
    // Ben and Cy were at the picnic: Cy's a friend, and on the list.
    const friends = section(html, 'friends-going');
    assert.equal(friends, null, 'cy said maybe, so no friends going yet');
    // The page drew what the API gives ben.
    const d = pageData(r.text);
    assert.deepEqual(d.event, (await ben.get(`/api/v1/events/${party.id}`)).data.event);
    assert.deepEqual(d.guests, (await ben.get(`/api/v1/events/${party.id}/guests?limit=50`)).data);
    assert.deepEqual(d.me, { id: P.ben.id, firstName: 'Ben', emailVerified: true });
  });

  await t.test('friends going, with names when the list is visible', async () => {
    const html = (await page(server, cy, `/e/${party.id}`)).body;
    // Friends come first in Attending's row (there's no separate card).
    assert.equal(section(html, 'friends-going'), null);
    assert.match(section(html, 'guests'), /<ul class="avatar-row" id="attendRow" style="--slots:5"><li title="Ben Okafor">/);
  });

  await t.test('responded-only list, not answered yet: counts, and why there are no names', async () => {
    const html = (await page(server, dee, `/e/${quiet.id}`)).body;
    const guests = section(html, 'guests');
    assert.ok(guests.includes('1 Going · 0 Maybe'));
    assert.ok(!guests.includes('avatar-row') && !guests.includes('View all'), 'no faces, no list');
    assert.ok(guests.includes('The host shows who&#39;s coming to people who&#39;ve answered.'));
    assert.ok(!html.includes('Ben Okafor') && !html.includes('Ben O<'), 'no names anywhere');
    assert.ok(section(html, 'rsvp').includes('You&#39;re invited. Are you going?'));
  });

  await t.test('the host: share, invite, edit and cancel, and everyone on the list', async () => {
    const html = (await page(server, ana, `/e/${party.id}`)).body;
    const host = section(html, 'host');
    assert.ok(host.includes('You&#39;re hosting'));
    assert.ok(host.includes(`href="/e/${party.id}/invite"`) && host.includes(`href="/e/${party.id}/edit"`));
    assert.ok(host.includes('data-action="cancel"') && host.includes('data-action="share"'));
    assert.equal(section(html, 'rsvp'), null, 'hosts don\'t answer');
    const guests = section(html, 'guests');
    assert.ok(guests.includes("Invited, hasn&#39;t answered · 1") && guests.includes('Dee Ruiz'), guests);
    assert.ok(section(html, 'guests').includes('1 Going · 1 Maybe'));
    assert.ok(section(html, 'guests').includes('<details class="view-all" id="viewAll"><summary class="pill-btn">'), 'View all, shut');
    // No help text under "You're hosting": the heading, then the buttons.
    assert.match(host, /<h3>You&#39;re hosting<\/h3><div class="host-actions">/);
    // ⋯ is a drawn icon (three dots on the centre line), read out as "More".
    const more = /<button [^>]*id="hostMenuBtn"[^>]*>([\s\S]*?)<\/button>/.exec(host);
    assert.ok(more, 'the ⋯ button');
    assert.match(more[0], /class="secondary more-btn"/);
    assert.match(more[0], /aria-label="More"/);
    assert.match(more[1], /^<svg viewBox="0 0 24 24"[^>]*aria-hidden="true"[^>]*>(<circle cx="(5|12|19)" cy="12" r="[\d.]+" fill="currentColor"\/>){3}<\/svg>$/);
    assert.ok(!host.includes('⋯'), 'not the text character');
  });

  await t.test('phones: the event sits on the page, with no card, outline or rules', async () => {
    const r = await page(server, ana, `/e/${party.id}`);
    const head = /<section class="([^"]*)" id="details"/.exec(r.body);
    assert.ok(head && !head[1].split(' ').includes('card'), 'the event head isn\'t a card');
    assert.ok(/<div class="details-card">/.test(r.body), 'its details aren\'t one either');
    const css = require('fs').readFileSync(require('path').join(__dirname, '../public/events.css'), 'utf8');
    // Everything before the 700px block is the phone's layout.
    const desktopAt = css.indexOf('@media (min-width:700px)');
    assert.ok(desktopAt > 0);
    const phone = css.slice(0, desktopAt).replace(/\/\*[\s\S]*?\*\//g, '');
    const desktop = css.slice(desktopAt);
    assert.ok(!/\.details-card::before/.test(phone), 'no glass or outline on a phone');
    assert.match(desktop, /\.details-card::before\{[^}]*border:1px solid var\(--glass-edge\)/, 'the card from 700px');
    const description = /\.description\{([^}]*)\}/.exec(phone);
    assert.ok(description && !/border/.test(description[1]), 'no rule above the description');
    // The background: sized to the large viewport from the top, never the
    // dynamic one (which moves with Safari's toolbars).
    assert.match(phone, /\.mesh-bg::before, \.mesh-bg::after \{[^}]*position: fixed; top: 0;[^}]*height: 100vh; height: 100lvh;/);
    assert.ok(!/100dvh/.test(phone.slice(phone.indexOf('.mesh-bg {'), phone.indexOf('.hidden{'))), 'no dvh in the background');
    // Room under the last thing for the floating toolbar and the home bar.
    assert.match(phone, /padding-bottom:calc\(var\(--toolbar-clear\) \+ env\(safe-area-inset-bottom, 0px\)\)/);
    // Every page runs edge to edge (viewport-fit=cover) with a bar colour.
    for (const url of ['/', `/e/${party.id}`, `/e/${party.id}/edit`, '/friends', `/e/${party.id}/invite`, '/new']) {
      const text = (await page(server, ana, url)).text;
      assert.match(text, /<meta name="viewport" content="[^"]*viewport-fit=cover[^"]*">/, url);
      assert.match(text, /<meta name="theme-color" content="#[0-9a-f]{6}">/, url);
    }
  });

  await t.test('a cancelled event reads as cancelled, and takes no answers', async () => {
    const off = await makeEvent(ana, { title: 'Bonfire' });
    await ben.put(`/api/v1/events/${off.id}/rsvp`, { status: 'going' });
    await ana.patch(`/api/v1/events/${off.id}`, { status: 'cancelled' });
    const out = await page(server, anon, `/e/${off.id}`);
    assert.ok(out.body.includes('class="tag danger">Cancelled<'));
    assert.ok(out.body.includes('This event has been cancelled.'));
    assert.ok(!out.body.includes('>RSVP</a>'), 'no RSVP for a cancelled event');
    assert.equal(meta(out.text, 'og:title'), 'Cancelled: Bonfire');
    const guest = (await page(server, ben, `/e/${off.id}`)).body;
    assert.ok(!guest.includes('data-action="answer"'));
    assert.ok(guest.includes('You said: Going.'));
    const host = section((await page(server, ana, `/e/${off.id}`)).body, 'host');
    assert.ok(host.includes('data-action="restore"') && !host.includes('data-action="cancel"'));
  });

  await t.test('a past event reads as ended', async () => {
    const html = (await page(server, ben, `/e/${before.id}`)).body;
    assert.match(html, /class="tag rel off"[^>]*>Ended</);
    assert.ok(html.includes('This event has ended.'));
    assert.ok(!html.includes('data-action="answer"'));
    const host = section((await page(server, ana, `/e/${before.id}`)).body, 'host');
    assert.ok(!host.includes('/invite"') && !host.includes('data-action="cancel"'), 'nothing to invite to or cancel');
  });

  await t.test('times say their zone when it isn\'t the viewer\'s (the tz cookie)', async () => {
    const la = await page(server, ben, `/e/${party.id}`, { Cookie: `canopy_session=${P.ben.token}; tz=America/Los_Angeles` });
    assert.ok(!la.body.includes('zone-note'));
    assert.equal(pageData(la.text).drawnZone, 'America/Los_Angeles');
    const london = (await page(server, ben, `/e/${party.id}`, { Cookie: `canopy_session=${P.ben.token}; tz=Europe/London` })).body;
    assert.ok(london.includes('Times are in Pacific Time.'), london);
    const nonsense = (await page(server, ben, `/e/${party.id}`, { Cookie: `canopy_session=${P.ben.token}; tz=Not%2FAZone` })).text;
    assert.equal(pageData(nonsense).drawnZone, null);
  });

  await t.test('no such event: a 404 page', async () => {
    for (const id of ['AAAAAAAAAAAA', 'short', 'has-a-dash-1']) {
      const r = await page(server, ben, `/e/${id}`);
      assert.equal(r.status, 404, id);
      assert.ok(r.body.includes('There&#39;s no event at this link.'));
    }
  });

  await t.test('home, signed out: what this is, and sign in', async () => {
    const r = await page(server, anon, '/');
    assert.equal(r.status, 200);
    assert.ok(r.body.includes('id="welcome"'));
    assert.ok(r.body.includes(`href="${server.fake.base}/?return=${encodeURIComponent(`${server.base}/`)}">Sign in</a>`));
    assert.ok(!r.body.includes('id="lists"'));
  });

  await t.test('home, verified: invitations to answer, hosting, coming up, past, and a new event', async () => {
    const host = (await page(server, ana, '/')).body;
    assert.ok(host.includes('href="/new"'), 'make an event');
    assert.ok(section(host, 'list-hosting').includes('Rooftop dinner'));
    assert.ok(section(host, 'list-past').includes('Picnic before'));
    assert.ok(host.includes('aria-current="page">Your events<'));
    // Your photo opens the account menu: your name (to your Canopy
    // profile), then Sign out, which appears nowhere else on the page.
    const menu = host.slice(host.indexOf('id="accountMenu"'), host.indexOf('</div>', host.indexOf('id="accountMenu"')));
    assert.ok(host.includes('id="accountMenuBtn" aria-haspopup="menu" aria-expanded="false"'), 'the photo is a menu button');
    assert.ok(menu.includes(`href="${server.fake.base}/profile"`) && menu.includes('>Ana Lima<'), 'first, your name, to your profile');
    assert.ok(menu.indexOf('Ana Lima') < menu.indexOf('Sign out'), 'name first, then Sign out');
    assert.ok(menu.includes(`${server.fake.base}/signout?return=`), 'sign out, in the menu');
    assert.equal(host.split('/signout?return=').length - 1, 1, 'Sign out appears only once, in the menu');
    assert.ok(!host.includes('class="foot"'), 'no foot with Sign out');
    const guest = (await page(server, dee, '/')).body;
    const invitations = section(guest, 'list-invitations');
    assert.ok(invitations.includes('Rooftop dinner') && invitations.includes('data-action="reply" data-status="going"'));
    assert.ok(invitations.includes('data-status="not_going"'));
    assert.ok(section((await page(server, ben, '/')).body, 'list-upcoming').includes('Rooftop dinner'));
  });

  await t.test('home, unverified: no new event, and a line saying to confirm the email to host', async () => {
    const html = (await page(server, una, '/')).body;
    assert.ok(!html.includes('href="/new"'));
    assert.ok(html.includes('Confirm your email to make your own events.'));
    assert.ok(html.includes('id="verifyBanner"'));
  });

  await t.test('the editor: verified people make, hosts edit, everyone else is told why', async () => {
    const out = await page(server, anon, '/new');
    assert.equal(out.status, 302);
    assert.equal(out.headers.get('location'), `${server.fake.base}/?return=${encodeURIComponent(`${server.base}/new`)}`);
    const quick = await page(server, una, '/new');
    assert.equal(quick.status, 403);
    assert.ok(quick.body.includes('Confirm your email first') && !quick.body.includes('id="eventForm"'));
    // From a Pacific browser (its tz cookie).
    const pacific = { Cookie: `canopy_session=${P.ana.token}; tz=America/Los_Angeles` };
    const fresh = await page(server, ana, '/new', pacific);
    assert.equal(fresh.status, 200);
    for (const id of ['title', 'description', 'startDate', 'startTime', 'endsAt', 'timeZone', 'locationName', 'locationAddress', 'guestsAllowed', 'capacity', 'themeHue']) {
      assert.ok(fresh.body.includes(`id="${id}"`), id);
    }
    // It looks like the event: the card, its hero (no cover: the
    // generated picture), and the title typed where the title goes.
    assert.match(fresh.body, /<section class="event-head editor-head" id="details"><div class="hero" id="coverHero"><span class="cover-art" id="coverArt" style="--c0:#[0-9a-f]{6};/);
    assert.match(fresh.body, /<div class="head-text">[\s\S]*<textarea id="title" class="event-title title-input" rows="1" maxlength="120" required placeholder="Event title"><\/textarea>/);
    assert.match(fresh.body, /<div class="when-big when-edit"><div class="when-date"><label class="pick empty" id="startDatePick">/);
    // On the hero: the upload button, labelled for a screen reader; no
    // remove without a cover.
    assert.match(fresh.body, /<div class="hero-tools"><label class="hero-btn file-btn" title="Add cover photo"><svg[^>]*>[\s\S]*?<input type="file" id="coverFile" [^>]*aria-label="Add cover photo">/);
    assert.match(fresh.body, /<button type="button" class="hero-btn" id="coverRemove" data-action="remove-cover" aria-label="Remove cover photo" title="Remove cover photo" hidden>/);
    // No help text: nothing explains a field. The only sentences in the
    // form are the two status lines, hidden until needed.
    const form = fresh.body.slice(fresh.body.indexOf('<form class="stack editor"'), fresh.body.indexOf('</form>'));
    assert.deepEqual(form.match(/<p class="[^"]*"/g), ['<p class="hero-note hidden"', '<p class="zone-none hidden"']);
    assert.ok(!/field-hint|legend/.test(form));
    for (const gone of ['Shown at the top of the event', 'Only people who are signed in see the address', 'You always see everyone', 'The most people going', 'Slide to colour']) {
      assert.ok(!fresh.body.includes(gone), gone);
    }
    assert.ok(form.includes('>Everyone with the link<') && form.includes('>Only people who&#39;ve answered<'));
    assert.ok(form.includes('placeholder="Address (only signed-in guests see it)"'));
    // The time zone: its friendly name, small, with "Change" and its menu
    // (the six zones near Pacific, Pacific ticked and marked as yours,
    // then the rest). The value sent is the IANA id.
    assert.ok(form.includes('<span class="zone-name" id="zoneName">Pacific Time</span>'));
    assert.match(form, /<button type="button" class="chip-btn" id="zoneBtn" data-action="zone-menu" aria-haspopup="menu" aria-expanded="false" aria-controls="zoneMenu" aria-label="Change time zone">Change<\/button>/);
    assert.match(form, /<div class="menu zone-menu" id="zoneMenu" role="menu" aria-label="Time zone" hidden>/);
    const menu = form.slice(form.indexOf('id="zoneMenu"'), form.indexOf('</div>', form.indexOf('id="zoneMenu"')));
    assert.deepEqual([...menu.matchAll(/data-zone="([^"]+)"/g)].map((m) => m[1]),
      ['Pacific/Honolulu', 'America/Anchorage', 'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York']);
    assert.match(menu, /role="menuitemradio" tabindex="-1" class="menu-item zone-item" aria-checked="true" data-action="pick-zone" data-zone="America\/Los_Angeles">.*?Pacific Time<span class="zone-yours">Your time zone<\/span>/);
    assert.equal((menu.match(/aria-checked="true"/g) || []).length, 1);
    assert.ok(menu.includes('data-action="zone-search">Other time zones…</button>'));
    assert.ok(form.includes('<input type="hidden" id="timeZone" value="America/Los_Angeles">'));
    assert.match(form, /<div class="zone-panel" id="zonePanel" role="dialog" aria-modal="true" aria-label="Time zone" hidden>/);
    const edit = await page(server, ana, `/e/${party.id}/edit`);
    assert.equal(edit.status, 200);
    assert.ok(edit.body.includes('placeholder="Event title">Rooftop dinner</textarea>'));
    const local = UI.localInput(party.startsAt, party.timeZone);
    assert.ok(edit.body.includes(`<input type="date" id="startDate" value="${local.slice(0, 10)}" aria-label="Date">`));
    assert.ok(edit.body.includes(`<input type="time" id="startTime" value="${local.slice(11)}" aria-label="Start time">`));
    assert.ok(edit.body.includes(`id="startDateText" aria-hidden="true">${UI.dayWords(local.slice(0, 10))}</span>`));
    assert.ok(edit.body.includes('<input type="hidden" id="timeZone" value="America/Los_Angeles">'));
    assert.ok(edit.body.includes(ADDRESS));
    const notHost = await page(server, ben, `/e/${party.id}/edit`);
    assert.equal(notHost.status, 403);
    assert.ok(notHost.body.includes('Only a host can edit this event.') && !notHost.body.includes('id="eventForm"'));
    assert.equal((await page(server, anon, `/e/${party.id}/edit`)).status, 302);
  });

  await t.test('inviting: the host\'s friends, with who\'s already on the list marked', async () => {
    const r = await page(server, ana, `/e/${party.id}/invite`);
    assert.equal(r.status, 200);
    const list = section(r.body, 'invite');
    assert.ok(list.includes('id="search"'));
    // Ben (going) and Cy (maybe) are friends from the picnic; Dee, from
    // being invited.
    assert.match(list, /Ben Okafor[\s\S]*?class="tag">Going</);
    assert.match(list, /Cy Park[\s\S]*?class="tag off">Maybe</);
    assert.match(list, /Dee Ruiz[\s\S]*?class="tag off">Invited</);
    const d = pageData(r.text);
    assert.equal(d.onList[P.dee.id], 'invited');
    assert.deepEqual(d.friends.map((f) => f.person.id).sort(), [P.ben.id, P.cy.id, P.dee.id].sort());
    assert.equal((await page(server, ben, `/e/${party.id}/invite`)).status, 403);
    // Over or cancelled: nothing to invite to.
    const past = await page(server, ana, `/e/${before.id}/invite`);
    assert.ok(past.body.includes("This event isn&#39;t taking invitations"));
  });

  await t.test('friends: who, and how many events in common', async () => {
    const r = await page(server, ben, '/friends');
    assert.equal(r.status, 200);
    assert.ok(r.body.includes('Ana Lima') && r.body.includes('Cy Park'));
    assert.ok(r.body.includes('1 event together'));
    assert.ok(r.body.includes('aria-current="page">Friends<'));
    const none = await page(server, una, '/friends');
    assert.ok(none.body.includes('No friends yet.'));
    assert.equal((await page(server, anon, '/friends')).status, 302);
  });

  await t.test('scripts and styles are inside the page, and its data can\'t break out of its tag', async () => {
    const sneaky = await makeEvent(ana, { title: '</script><script>alert(1)</script>', description: '<!-- PAGE:MAIN --> __PAGE_DATA__' });
    const r = await page(server, ben, `/e/${sneaky.id}`);
    const html = r.text;
    assert.ok(!html.includes('<script src='), 'no script fetched separately');
    assert.ok(!html.includes('<link rel="stylesheet"'), 'no stylesheet fetched separately');
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.equal(pageData(html).event.title, '</script><script>alert(1)</script>');
    assert.equal(pageData(html).event.description, '<!-- PAGE:MAIN --> __PAGE_DATA__');
    assert.ok(html.includes('&lt;!-- PAGE:MAIN --&gt; __PAGE_DATA__'));
  });

  await t.test('anything else is an HTML 404 for a browser; the API keeps its JSON 404', async () => {
    const r = await page(server, ben, '/nothing-here');
    assert.equal(r.status, 404);
    assert.ok(r.body.includes("There&#39;s nothing at this address."));
    const api = await ben.get('/api/v1/nothing-here');
    assert.equal(api.status, 404);
    assert.equal(api.data.reason, 'not_found');
  });
});

test('pages when Canopy accounts can\'t be reached: a page that says so', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const ana = client(server, 'ana');
  const e = await makeEvent(ana);
  await server.fake.close();
  // Signed out needs no session check, but the hosts' names do.
  const out = await page(server, null, `/e/${e.id}`);
  assert.equal(out.status, 503);
  assert.ok(out.body.includes("Canopy accounts can&#39;t be reached right now."));
  // Signed in with a session the server hasn't seen: the session check.
  const r = await page(server, 'ben', '/');
  assert.equal(r.status, 503);
  assert.ok(r.body.includes("Canopy accounts can&#39;t be reached right now."));
});

// ---------------- The features: covers, capacity and plus-ones, co-hosts,
// the wall, moderation and lookup, each section as every kind of viewer.

test('ui.js: the features, drawn', async (t) => {
  await t.test('plus-ones allowed in the editor are the API\'s', () => {
    assert.equal(UI.MAX_GUESTS_ALLOWED, require('../lib/eventInput').MAX_GUESTS_ALLOWED);
  });

  await t.test('when, big: the day, the time, and days spanning more than one', () => {
    const one = { startsAt: '2030-10-12T02:30:00.000Z', endsAt: '2030-10-12T06:00:00.000Z', timeZone: 'America/Los_Angeles' };
    assert.deepEqual(UI.whenHead(one, 'America/Los_Angeles'), { date: 'Friday, October 11, 2030', time: '7:30 PM – 11:00 PM', zoneNote: null });
    assert.equal(UI.whenHead(one, 'Europe/London').zoneNote, 'Times are in Pacific Time.');
    const weekend = { startsAt: '2030-10-12T02:30:00.000Z', endsAt: '2030-10-13T18:00:00.000Z', timeZone: 'America/Los_Angeles' };
    assert.deepEqual(UI.whenHead(weekend, 'America/Los_Angeles'), { date: 'Fri, Oct 11, 2030 – Sun, Oct 13, 2030', time: '7:30 PM – 11:00 AM', zoneNote: null });
    assert.equal(UI.whenRow(one, 'America/Los_Angeles'), 'Fri, Oct 11, 2030 · 7:30 PM');
    assert.equal(UI.whenRow(one, 'Europe/London'), 'Fri, Oct 11, 2030 · 7:30 PM PDT');
    assert.equal(UI.whenRow(weekend, 'America/Los_Angeles'), 'Fri, Oct 11, 2030 – Sun, Oct 13, 2030');
  });

  await t.test('how soon, counted in days on the event\'s clock', () => {
    // Now: Wednesday 2030-10-09, 10:00 in Los Angeles.
    const now = Date.parse('2030-10-09T17:00:00.000Z');
    const at = (iso) => UI.relativeWhen({ startsAt: iso, endsAt: null, timeZone: 'America/Los_Angeles', status: 'active' }, now);
    assert.equal(at('2030-10-09T20:00:00.000Z'), 'Today'); // 1 PM
    assert.equal(at('2030-10-10T02:30:00.000Z'), 'Tonight'); // 7:30 PM, still the 9th there
    assert.equal(at('2030-10-10T19:00:00.000Z'), 'Tomorrow');
    assert.equal(at('2030-10-12T19:00:00.000Z'), 'This Saturday');
    assert.equal(at('2030-10-19T19:00:00.000Z'), 'Next Saturday');
    assert.equal(at('2030-10-15T19:00:00.000Z'), 'Next Tuesday', 'six days away, but next week');
    assert.equal(at('2030-10-30T19:00:00.000Z'), 'In 3 weeks');
    assert.equal(at('2030-11-12T19:00:00.000Z'), 'In a month');
    assert.equal(at('2031-01-09T19:00:00.000Z'), 'In 3 months');
    assert.equal(at('2030-10-09T16:00:00.000Z'), 'Happening now');
    assert.equal(at('2030-10-01T16:00:00.000Z'), 'Ended');
    assert.equal(UI.relativeWhen({ startsAt: '2030-10-12T19:00:00.000Z', timeZone: 'UTC', status: 'cancelled' }, now), '');
  });

  await t.test('an event\'s colour: null is today\'s green, hue 161 the same, every hue as dark', () => {
    assert.equal(UI.themeStyle(null), '');
    assert.equal(UI.themeStyle(360), '');
    const hex = (rgb) => '#' + rgb.map((x) => x.toString(16).padStart(2, '0')).join('');
    const green = UI.themeColors(UI.THEME_DEFAULT_HUE);
    const today = { base: '#03120c', m1: '#0f4a33', m2: '#0a3b2e', m3: '#145c3e', m4: '#072b1f', m5: '#0c3a28', card: '#03200b' };
    for (const [k, v] of Object.entries(today)) {
      const near = green[k].every((x, i) => Math.abs(x - parseInt(v.slice(1 + 2 * i, 3 + 2 * i), 16)) <= 2);
      assert.ok(near, `${k}: ${hex(green[k])} vs ${v}`);
    }
    // White on the card over the brightest glow, composited in linear
    // light, at a few hues: never under 9:1 (the green's is 9.5:1).
    const lin = (b) => { const c = b / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const lum = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    for (const hue of [UI.THEME_DEFAULT_HUE, 25, 60, 100, 193, 255, 305, 345]) {
      const c = UI.themeColors(hue);
      const overGlow = c.m3.map((x, i) => 0.7 * lin(x) + 0.3 * lin(c.card[i]));
      const ratio = 1.05 / (lum(overGlow) + 0.05);
      assert.ok(ratio >= 9, `hue ${hue}: ${ratio.toFixed(2)}`);
    }
    // The generated picture turns with it.
    assert.notEqual(UI.coverArt({ id: 'AAAAAAAAAAAA', themeHue: 300 }), UI.coverArt({ id: 'AAAAAAAAAAAA', themeHue: null }));
  });

  await t.test('no colour: every colour a neutral grey exactly as light, and the same contrast', () => {
    assert.equal(UI.themeKeyOf({ themeHue: 30, themeGrayscale: true }), 'grey');
    assert.equal(UI.themeKeyOf({ themeHue: 30, themeGrayscale: false }), 30);
    assert.equal(UI.themeKeyOf({ themeHue: null, themeGrayscale: false }), null);
    const c = UI.themeColors('grey');
    for (const [k, rgb] of Object.entries(c)) assert.ok(rgb[0] === rgb[1] && rgb[1] === rgb[2], `${k} is neutral: ${rgb}`);
    const lin = (b) => { const x = b / 255; return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
    const lum = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    const overGlow = c.m3.map((x, i) => 0.7 * lin(x) + 0.3 * lin(c.card[i]));
    assert.ok(1.05 / (lum(overGlow) + 0.05) >= 9, 'white on a card over the brightest glow');
    // The generated picture goes grey too.
    assert.match(UI.coverArt({ id: 'AAAAAAAAAAAA', themeGrayscale: true }), /--c1:#([0-9a-f]{2})\1\1;/);
    // The slider: grey at the left, then the wheel; untouched, Canopy green.
    assert.equal(UI.sliderOf(null), UI.SLIDER_GREY + 161);
    assert.equal(UI.keyOfSlider(0), 'grey');
    assert.equal(UI.keyOfSlider(UI.SLIDER_GREY - 1), 'grey');
    assert.equal(UI.keyOfSlider(UI.SLIDER_GREY), 0);
    assert.equal(UI.keyOfSlider(UI.SLIDER_MAX), 359);
    for (const key of ['grey', 0, 161, 359]) assert.equal(UI.keyOfSlider(UI.sliderOf(key)), key);
  });

  await t.test('the editor offers "Match photo" only once there\'s a photo whose colour is known', () => {
    const base = { id: 'AAAAAAAAAAAA', title: 'T', startsAt: '2030-01-01T20:00:00.000Z', timeZone: 'UTC', guestListVisibility: 'everyone' };
    assert.match(UI.editorForm({ event: { ...base, coverHue: 200, coverGrayscale: false } }), /id="themeMatch" data-action="theme-match">/);
    assert.match(UI.editorForm({ event: { ...base, coverHue: null, coverGrayscale: true } }), /id="themeMatch" data-action="theme-match">/);
    assert.match(UI.editorForm({ event: { ...base, coverHue: null, coverGrayscale: false } }), /id="themeMatch" data-action="theme-match" hidden>/);
    assert.match(UI.editorForm({ event: { ...base, themeGrayscale: true } }), /id="themeHue"[^>]*value="15"[^>]*aria-valuetext="No colour"/);
  });

  await t.test('time zones by friendly name', () => {
    const july = Date.parse('2030-07-15T19:00:00Z');
    const names = Object.fromEntries(['America/Los_Angeles', 'America/Vancouver', 'America/Denver', 'America/Boise', 'America/Phoenix', 'America/Chicago',
      'America/New_York', 'America/Anchorage', 'Pacific/Honolulu', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'America/Mexico_City',
      'America/Regina', 'UTC'].map((z) => [z, UI.zoneName(z, july)]));
    assert.deepEqual(names, {
      'America/Los_Angeles': 'Pacific Time', 'America/Vancouver': 'Pacific Time', 'America/Denver': 'Mountain Time', 'America/Boise': 'Mountain Time',
      'America/Phoenix': 'Arizona', 'America/Chicago': 'Central Time', 'America/New_York': 'Eastern Time', 'America/Anchorage': 'Alaska Time',
      'Pacific/Honolulu': 'Hawaii Time', 'Europe/London': 'London', 'Europe/Paris': 'Central European Time', 'Europe/Berlin': 'Central European Time',
      // The same generic name as a main zone, but not its clock: the city.
      'America/Mexico_City': 'Mexico City', 'America/Regina': 'Regina', UTC: 'UTC'
    });
    assert.equal(UI.offsetWords(-420), 'GMT−7');
    assert.equal(UI.offsetWords(330), 'GMT+5:30');
    assert.equal(UI.offsetWords(0), 'GMT');
  });

  await t.test('the time zone menu: the zones near the viewer\'s, at the event\'s date', () => {
    const july = Date.parse('2030-07-15T19:00:00Z');
    const january = Date.parse('2030-01-15T19:00:00Z');
    const near = (viewer, at, selected) => UI.nearbyZones(viewer, at, selected).map((z) => z.zone);
    const PACIFIC = ['Pacific/Honolulu', 'America/Anchorage', 'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York'];
    // From Pacific, summer or winter: exactly these six, west to east.
    assert.deepEqual(near('America/Los_Angeles', july, 'America/Los_Angeles'), PACIFIC);
    assert.deepEqual(near('America/Los_Angeles', january, 'America/Los_Angeles'), PACIFIC);
    // Vancouver is Pacific Time too: the same list, with Los Angeles
    // standing for it and marked as the viewer's.
    const van = UI.nearbyZones('America/Vancouver', july, 'America/Vancouver');
    assert.deepEqual(van.map((z) => z.zone), PACIFIC);
    assert.deepEqual(van.filter((z) => z.yours).map((z) => z.name), ['Pacific Time']);
    assert.deepEqual(van.filter((z) => z.selected).map((z) => z.name), ['Pacific Time']);
    assert.deepEqual(UI.nearbyZones('America/Los_Angeles', july).map((z) => z.offset), [-600, -480, -420, -360, -300, -240]);
    // Arizona shares Pacific's clock in summer and Mountain's in winter,
    // so it's only its own line for someone there.
    const phoenix = near('America/Phoenix', july, 'America/Phoenix');
    assert.deepEqual(phoenix, ['Pacific/Honolulu', 'America/Anchorage', 'America/Los_Angeles', 'America/Phoenix', 'America/Denver', 'America/Chicago', 'America/New_York']);
    // Paris, summer and winter (both change clocks the same weekend, so
    // Athens is +3 with Moscow in July and +2 in January, when Moscow gets
    // its own line).
    assert.deepEqual(near('Europe/Paris', july, 'Europe/Paris'), ['Europe/London', 'Europe/Paris', 'Europe/Athens', 'Asia/Dubai', 'Asia/Karachi']);
    assert.deepEqual(near('Europe/Paris', january, 'Europe/Paris'), ['Europe/London', 'Europe/Paris', 'Europe/Athens', 'Europe/Moscow', 'Asia/Dubai']);
    assert.deepEqual(UI.nearbyZones('Europe/Berlin', july, 'Europe/Berlin').filter((z) => z.yours).map((z) => z.zone), ['Europe/Paris']);
    // The event's own zone is always there, even far away.
    const far = UI.nearbyZones('Europe/Paris', july, 'America/Los_Angeles');
    assert.deepEqual(far[0], { zone: 'America/Los_Angeles', name: 'Pacific Time', offset: -420, yours: false, selected: true });
    // In the week the US has changed its clocks and Europe hasn't (March
    // 2030: US on the 10th, EU on the 31st), London is 7 hours from Los
    // Angeles, not 8, and still out of reach.
    const march = Date.parse('2030-03-20T19:00:00Z');
    assert.equal(UI.zoneOffset('Europe/London', march) - UI.zoneOffset('America/Los_Angeles', march), 420);
    assert.deepEqual(near('America/Los_Angeles', march, 'America/Los_Angeles'), PACIFIC);
    // Every zone, for the search: west to east, each with its city.
    const all = UI.allZones(['Europe/London', 'America/Los_Angeles', 'America/Vancouver', 'Not/AZone'], july);
    assert.deepEqual(all.map((z) => [z.name, z.city]), [['Pacific Time', 'Los Angeles'], ['Pacific Time', 'Vancouver'], ['London', 'London']]);
  });

  await t.test('Attending: friends first, going before maybe, newest first, and +N for everyone else', () => {
    const person = (n) => ({ id: 'p' + n, firstName: 'P' + n, lastName: 'X', shortName: 'P' + n, photoUrl: null });
    // Answers oldest first, as the API lists them: 1..40 going, 41..60 maybe.
    const guests = [];
    for (let n = 1; n <= 60; n++) guests.push({ person: person(n), status: n <= 40 ? 'going' : 'maybe', guests: 0 });
    const e = {
      counts: { going: 82, maybe: 64, notGoing: 3, invited: null, waitlisted: 0, guests: { going: 5, maybe: 0, waitlisted: 0 } },
      friendsGoing: { count: 1, people: [person(7)] }
    };
    const g = { guestsVisible: true, guests, nextCursor: 'more' };
    assert.deepEqual(UI.attendPeople(e, g).slice(0, 3).map((p) => p.id), ['p7', 'p40', 'p39']);
    assert.equal(UI.attendPeople(e, g)[40].id, 'p60', 'maybe after going');
    const row = UI.attendRow(e, g, 6);
    assert.equal((row.match(/<li title=/g) || []).length, 5, 'five faces and the +N in six places');
    assert.ok(row.includes('<span>+141</span>'), 'everyone else going or maybe, people not guests: 146 - 5');
    assert.equal(UI.attendSummary(e), '82 Going · 64 Maybe · +5 guests');
    assert.equal(UI.attendSummary({ counts: { ...e.counts, waitlisted: 3 } }), '82 Going · 64 Maybe · 3 Waitlist · +5 guests');
    // Few enough to fit: everyone, no +N.
    const few = UI.attendRow({ counts: { going: 2, maybe: 1 } }, { guests: guests.slice(0, 2).concat(guests.slice(45, 46)) }, 5);
    assert.equal((few.match(/<li title=/g) || []).length, 3);
    assert.ok(!few.includes('more-circle'));
    // Nobody yet: no row at all.
    assert.equal(UI.attendRow({ counts: { going: 0, maybe: 0 } }, { guests: [] }, 5), '');
  });

  await t.test('counts are people, plus the guests they bring', () => {
    const counts = { going: 4, maybe: 1, notGoing: 0, invited: 2, waitlisted: 1, guests: { going: 2, maybe: 1, waitlisted: 0 } };
    assert.equal(UI.countsLine({ counts }, false), '4 going +2 guests · 1 maybe +1 guest · 1 on the waitlist');
    assert.equal(UI.countsLine({ counts }, true), '4 going +2 guests · 1 maybe +1 guest · 1 on the waitlist · 2 invited');
  });

  await t.test('wall entries: names escaped and in bold, unknown types left out', () => {
    const person = { id: 'p', firstName: '<i>Ana', lastName: 'L', shortName: 'A', photoUrl: null };
    const entry = { id: '1', type: 'going', createdAt: new Date().toISOString(), person, text: null, details: null, canDelete: false };
    const html = UI.wallEntry(entry, { timeZone: 'UTC' }, {});
    assert.ok(html.includes('<strong>&lt;i&gt;Ana L</strong> is going.'), html);
    assert.ok(!html.includes('<i>'));
    assert.equal(UI.wallEntry({ ...entry, type: 'something_new' }, { timeZone: 'UTC' }, {}), '');
    const place = UI.wallEntry({ ...entry, type: 'place_changed', details: { locationName: null, locationAddress: null } }, { timeZone: 'UTC' }, {});
    assert.ok(place.includes('took the place off.'));
    assert.equal(UI.ago(new Date(Date.now() - 5 * 60e3).toISOString(), 'UTC'), '5m');
    assert.equal(UI.ago(new Date(Date.now() - 3 * 3600e3).toISOString(), 'UTC'), '3h');
    assert.equal(UI.ago('2030-01-02T12:00:00.000Z', 'UTC', Date.parse('2030-01-09T12:00:00.000Z')), 'Jan 2');
  });

  await t.test('someone removed never sees a raw copy key, whatever the event\'s state', () => {
    const e = { id: 'AAAAAAAAAAAA', guestsAllowed: 0, capacity: null, viewer: { role: null, canEdit: false, rsvp: { status: 'removed', guests: 0, guestsOverLimit: false } } };
    for (const phase of ['upcoming', 'cancelled', 'over']) {
      const html = UI.rsvpSection(e, phase, {});
      assert.ok(html.includes('You&#39;re not on the list for this event.'), phase);
      assert.ok(!/(status|event|wall)\.[a-zA-Z]/.test(html), phase);
    }
  });

  await t.test('a lookup shows a name and a photo, and nothing else of theirs', () => {
    const p = { id: 'x', firstName: 'Ana', lastName: 'Lima', shortName: 'Ana L', photoUrl: 'https://a/photo/x', phone: '+14155550000', instagram: 'ana.insta' };
    const html = UI.lookupResult(p, {});
    assert.ok(html.includes('Ana Lima') && html.includes('https://a/photo/x') && html.includes('data-action="invite-found"'));
    assert.ok(!html.includes('4155550000') && !html.includes('ana.insta'));
    assert.ok(UI.lookupResult(p, { x: 'removed' }).includes('class="tag off">Removed<'));
  });

  await t.test('lookup is for verified hosts; anyone else is told how', () => {
    const event = { id: 'AAAAAAAAAAAA', title: 'T' };
    const quick = UI.invitePage({ event, me: { emailVerified: false }, links: { verify: 'https://a/profile?verify=1' }, friends: [], onList: {}, phase: 'upcoming' });
    assert.ok(quick.includes('href="https://a/profile?verify=1"') && !quick.includes('lookupForm'));
    const verified = UI.invitePage({ event, me: { emailVerified: true }, friends: [], onList: {}, phase: 'upcoming' });
    assert.ok(verified.includes('id="lookupForm"'));
    const over = UI.invitePage({ event, me: { emailVerified: true }, friends: [], onList: {}, phase: 'over' });
    assert.ok(!over.includes('lookupForm'));
  });
});

test('pages: the features, as everyone who might look', async (t) => {
  const sharp = require('sharp');
  const server = await startServer();
  t.after(() => server.stop());
  const P = server.people;
  const [ana, ben, cy, dee, eve, fay, una] = ['ana', 'ben', 'cy', 'dee', 'eve', 'fay', 'una'].map((n) => client(server, n));
  const anon = client(server, null);
  const ADDRESS = '1 Market St';

  // Fay has opened events with a confirmed email, so she can co-host.
  await fay.get('/api/v1/me');
  // Friends: ana hosted a picnic ben, cy, dee and fay went to.
  const before = await makeEvent(ana, { title: 'Picnic before' });
  for (const who of [ben, cy, dee, fay]) await who.put(`/api/v1/events/${before.id}/rsvp`, { status: 'going' });
  server.setTimes(before.id, { startedAgoMs: 9 * 86400e3, overInMs: -8 * 86400e3 });

  // The party: room for 2, up to 2 guests each, a cover, fay co-hosting.
  // Ben goes with a guest (full), cy is waitlisted, una says maybe, and
  // dee was invited and then removed.
  const party = await makeEvent(ana, { title: 'Garden party', capacity: 2, guestsAllowed: 2 });
  const jpeg = await sharp({ create: { width: 1200, height: 675, channels: 3, background: '#0A3800' } }).jpeg().toBuffer();
  const up = await ana.upload('PUT', `/api/v1/events/${party.id}/cover`, jpeg, { type: 'image/jpeg', filename: 'cover.jpg' });
  assert.equal(up.status, 200, up.text);
  const cover = up.data.event.coverImageUrl;
  // Its sizes (1200 wide: 400, 800 and itself), as every page's srcset.
  const srcset = up.data.event.coverImages.map((c) => `${c.url} ${c.width}w`).join(', ');
  assert.deepEqual(up.data.event.coverImages.map((c) => c.width), [400, 800, 1200]);
  // A 16:9 photo in a 3:2 frame is drawn 16/9 / 3/2 = 1.19 times the
  // frame's width, so that's the width each place asks for.
  const img = (cls, sizes, attrs = '') => `<img class="${cls}"${attrs} src="${cover}" srcset="${srcset}" sizes="${sizes}" alt="" decoding="async">`;
  assert.equal((await ana.post(`/api/v1/events/${party.id}/cohosts`, { personId: P.fay.id })).status, 200);
  await ana.post(`/api/v1/events/${party.id}/invites`, { personIds: [P.dee.id] });
  await ben.put(`/api/v1/events/${party.id}/rsvp`, { status: 'going', guests: 1 });
  assert.equal((await cy.put(`/api/v1/events/${party.id}/rsvp`, { status: 'going' })).data.waitlisted, true);
  await una.put(`/api/v1/events/${party.id}/rsvp`, { status: 'maybe' });
  assert.equal((await ana.put(`/api/v1/events/${party.id}/removed/${P.dee.id}`)).status, 200);
  assert.equal((await ben.post(`/api/v1/events/${party.id}/wall`, { text: 'See you there! <b>bold</b>' })).status, 201);
  await ana.patch(`/api/v1/events/${party.id}`, { locationName: 'The garden' });

  await t.test('signed out: the cover as the hero and in the preview, the spots, no wall', async () => {
    const r = await page(server, anon, `/e/${party.id}`);
    const details = section(r.body, 'details');
    // The hero: the column (680px) on a desktop, the whole width on a
    // phone; not lazy (it's the first thing on the page).
    assert.ok(details.includes(img('cover', '(min-width: 700px) 809px, 119vw')), details);
    // One card: the details under the hero aren't a card of their own.
    assert.ok(details.includes('<div class="details-card">') && !details.includes('card details-card'), 'one card');
    assert.equal(meta(r.text, 'og:image'), cover);
    assert.equal(meta(r.text, 'twitter:image'), cover);
    assert.equal(meta(r.text, 'twitter:card'), 'summary_large_image');
    assert.ok(section(r.body, 'guests').includes('1 Going · 1 Maybe · 1 Waitlist · +1 guest'), section(r.body, 'guests'));
    assert.ok(details.includes('Full. New answers join the waitlist.'));
    assert.ok(details.includes('Hosted by Ana Lima and Fay Tran'));
    assert.equal(section(r.body, 'wall'), null);
    assert.ok(!r.body.includes('data-action="remove-guest"') && !r.body.includes('data-action="guests"'));
    assert.equal(pageData(r.text).wall, null);
  });

  await t.test('without a cover: the same hero with a generated picture, and no image in the preview', async () => {
    const plain = await makeEvent(ana, { title: 'No picture' });
    const r = await page(server, anon, `/e/${plain.id}`);
    assert.equal(meta(r.text, 'og:image'), null);
    assert.equal(meta(r.text, 'twitter:card'), 'summary');
    const details = section(r.body, 'details');
    assert.ok(!details.includes('<img class="cover"'));
    assert.match(details, /<div class="hero"><span class="cover-art" style="[^"]+" aria-hidden="true"><\/span><div class="tags"><span class="tag rel"[^>]*>[^<]+<\/span><\/div><\/div>/);
    // The same event always gets the same picture, and the picture has
    // no words in it.
    assert.equal(UI.coverArt({ id: plain.id }), UI.coverArt({ id: plain.id }));
    assert.notEqual(UI.coverArt({ id: plain.id }), UI.coverArt({ id: 'BBBBBBBBBBBB' }));
  });

  await t.test('unverified, maybe: the guests stepper, and the wall with a box to post in', async () => {
    const html = (await page(server, una, `/e/${party.id}`)).body;
    assert.ok(html.includes('id="verifyBanner"'));
    const rsvp = section(html, 'rsvp');
    assert.ok(rsvp.includes('data-status="maybe" aria-pressed="true"'));
    assert.ok(rsvp.includes('data-action="guests" data-delta="1"') && rsvp.includes('<output id="guestCount" aria-live="polite">0</output>'), rsvp);
    assert.ok(rsvp.includes('You can bring up to 2.'));
    const wall = section(html, 'wall');
    assert.ok(wall.includes('id="wallForm"'));
    assert.ok(wall.includes('See you there! &lt;b&gt;bold&lt;/b&gt;'), 'posts are escaped');
    assert.ok(!wall.includes('data-action="delete-entry"'), 'nothing of hers to delete');
  });

  await t.test('a guest going with a plus-one: their count, the waitlist group, their own post to delete', async () => {
    const r = await page(server, ben, `/e/${party.id}`);
    const rsvp = section(r.body, 'rsvp');
    assert.ok(rsvp.includes('data-status="going" aria-pressed="true"'));
    assert.ok(rsvp.includes('<output id="guestCount" aria-live="polite">1</output>'));
    assert.ok(!rsvp.includes('It&#39;s full.'), 'already going');
    const guests = section(r.body, 'guests');
    assert.ok(guests.includes('Going · 1 +1 guest') && guests.includes('Ben Okafor'), guests);
    assert.match(guests, /Ben Okafor<\/div><div class="sub">\+1 guest</);
    assert.ok(guests.includes('Waitlist · 1') && guests.includes('Cy Park'));
    assert.ok(!guests.includes('Dee Ruiz'), 'the removed are only for hosts');
    assert.ok(!guests.includes('data-action="remove-guest"') && !guests.includes('removedGroup'));
    const wall = section(r.body, 'wall');
    assert.ok(wall.includes('<strong>Ben Okafor</strong> is going.'), wall);
    assert.ok(wall.includes('<strong>Ana Lima</strong> changed the place to <strong>The garden</strong>.'));
    assert.ok(wall.includes('<strong>Fay Tran</strong> is co-hosting.'));
    assert.equal((wall.match(/data-action="delete-entry"/g) || []).length, 1, 'only his own post');
    const d = pageData(r.text);
    assert.deepEqual(d.wall, (await ben.get(`/api/v1/events/${party.id}/wall?limit=20`)).data);
    assert.equal(d.removed, null);
    // How many are invited is the hosts' business: null, and not drawn.
    assert.equal(d.event.counts.invited, null);
    assert.ok(!section(r.body, 'details').includes('invited'));
  });

  await t.test('waitlisted: their place, and no "it\'s full" warning; someone new gets the warning', async () => {
    const rsvp = section((await page(server, cy, `/e/${party.id}`)).body, 'rsvp');
    assert.ok(rsvp.includes('You&#39;re on the waitlist.'));
    assert.ok(rsvp.includes('data-status="going" aria-pressed="true"'));
    assert.ok(!rsvp.includes('It&#39;s full.'));
    const fresh = section((await page(server, eve, `/e/${party.id}`)).body, 'rsvp');
    assert.ok(fresh.includes('It&#39;s full. If you say going, you&#39;ll join the waitlist'), fresh);
  });

  await t.test('removed: a calm line, and nothing about who\'s coming', async () => {
    const r = await page(server, dee, `/e/${party.id}`);
    assert.equal(r.status, 200);
    const rsvp = section(r.body, 'rsvp');
    assert.ok(rsvp.includes('You&#39;re not on the list for this event.'), rsvp);
    assert.ok(!r.body.includes('status.removed') && !/>\s*(status|event|wall)\.[a-zA-Z]/.test(r.body), 'no raw copy keys');
    assert.ok(!r.body.includes('data-action="answer"') && !r.body.includes('Take back my answer'));
    for (const id of ['guests', 'wall', 'friends-going', 'host']) assert.equal(section(r.body, id), null, id);
    assert.ok(!r.body.includes(ADDRESS), 'no address');
    for (const name of ['Ben Okafor', 'Cy Park', 'Una Quick']) assert.ok(!r.body.includes(name), name);
    const d = pageData(r.text);
    assert.equal(d.event.viewer.rsvp.status, 'removed');
    assert.equal(d.guests, null);
    assert.equal(d.wall, null);
  });

  await t.test('a co-host: running it, removing and undoing, stepping down, but not cancelling or relinking', async () => {
    const r = await page(server, fay, `/e/${party.id}`);
    const host = section(r.body, 'host');
    assert.ok(host.includes('You&#39;re co-hosting'));
    assert.ok(host.includes(`href="/e/${party.id}/invite"`) && host.includes(`href="/e/${party.id}/edit"`));
    assert.ok(!host.includes('data-action="cancel"') && !host.includes('data-action="new-link"'));
    assert.ok(host.includes('data-action="step-down"') && !host.includes('data-action="remove-cohost"'));
    assert.deepEqual([...host.matchAll(/role="menuitem"[^>]*data-action="([^"]+)"/g)].map((m) => m[1]), ["step-down"], "a co-host's menu: step down, nothing creator-only");
    assert.ok(!host.includes("delete-event"));
    assert.equal(section(r.body, 'rsvp'), null);
    const guests = section(r.body, 'guests');
    assert.ok(guests.includes(`data-action="remove-guest" data-person="${P.ben.id}" data-name="Ben Okafor"`), guests);
    assert.match(guests, /id="removedGroup"[\s\S]*Removed · 1[\s\S]*Dee Ruiz[\s\S]*data-action="undo-remove"/);
    const wall = section(r.body, 'wall');
    assert.equal((wall.match(/data-action="delete-entry"/g) || []).length, (wall.match(/class="wall-entry/g) || []).length, 'hosts delete anything');
    assert.deepEqual(pageData(r.text).removed, (await fay.get(`/api/v1/events/${party.id}/guests?status=removed&limit=50`)).data);
    assert.equal((await page(server, fay, `/e/${party.id}/edit`)).status, 200);
    const pick = await page(server, fay, `/e/${party.id}/cohosts`);
    assert.equal(pick.status, 403);
    assert.ok(pick.body.includes('Only the person who made this event can add co-hosts.'));
  });

  await t.test('the creator: co-hosts, a new link, cancelling, and the removed', async () => {
    const r = await page(server, ana, `/e/${party.id}`);
    const host = section(r.body, 'host');
    assert.ok(host.includes('You&#39;re hosting'));
    assert.ok(host.includes('data-action="new-link"') && host.includes('data-action="cancel"'));
    assert.ok(!host.includes('data-action="step-down"'));
    // Share and Invite, then Edit with the ⋯ menu: co-hosts, new link,
    // cancel, and delete last, in red.
    assert.match(host, /data-action="share"[^>]*>Share link<\/button><a class="button secondary" href="\/e\/[^"]+\/invite">Invite<\/a>/);
    assert.match(host, /<div class="edit-row"><a class="button secondary" href="[^"]+\/edit">Edit<\/a>/);
    assert.match(host, /id="hostMenuBtn" data-action="host-menu" aria-haspopup="menu" aria-expanded="false" aria-controls="hostMenu"/);
    const items = [...host.matchAll(/role="menuitem"[^>]*data-action="([^"]+)">([^<]+)</g)].map((m) => [m[1], m[2]]);
    assert.deepEqual(items, [['cohosts', 'Co-hosts…'], ['new-link', 'Make a new link…'], ['cancel', 'Cancel event'], ['delete-event', 'Delete event…']]);
    assert.match(host, /class="menu-item danger" data-action="delete-event"/);
    assert.ok(!host.includes('id="cohosts"'), 'the co-hosts open from the menu');
    // Opened: Fay, with Remove, and Add co-host.
    const opened = UI.hostSection(pageData(r.text).event, 'upcoming', { showCohosts: true });
    assert.match(opened, /Co-hosts · 1[\s\S]*Fay Tran[\s\S]*data-action="remove-cohost" data-person="[^"]+" data-name="Fay Tran"/);
    assert.ok(opened.includes(`href="/e/${party.id}/cohosts">Add co-host</a>`));
    assert.ok(section(r.body, 'guests').includes('Dee Ruiz'));
    // A new link: the page's data is the event under it, and the old one
    // is gone.
    const relinked = await makeEvent(ana, { title: 'Relinked' });
    const moved = (await ana.post(`/api/v1/events/${relinked.id}/new-link`)).data.event;
    assert.equal((await page(server, ana, `/e/${relinked.id}`)).status, 404);
    assert.equal(pageData((await page(server, ana, `/e/${moved.id}`)).text).event.url, `${server.base}/e/${moved.id}`);
    // The new link's box, as the page draws it after making one.
    const drawn = UI.eventPage({ me: { id: P.ana.id }, event: moved, guests: null, wall: null, newLink: true }, {});
    assert.ok(drawn.includes('id="newLink"') && drawn.includes(`value="${moved.url}"`) && drawn.includes('data-action="copy"'));
  });

  await t.test('adding co-hosts: the creator\'s friends, those hosting marked', async () => {
    const r = await page(server, ana, `/e/${party.id}/cohosts`);
    assert.equal(r.status, 200);
    const list = section(r.body, 'addCohosts');
    assert.match(list, /Ben Okafor[\s\S]*?data-action="add-cohost" data-person="[^"]+" data-name="Ben Okafor"/);
    assert.match(list, /Fay Tran[\s\S]*?class="tag off">Co-hosting</);
    assert.equal((await page(server, ben, `/e/${party.id}/cohosts`)).status, 403);
    assert.equal((await page(server, anon, `/e/${party.id}/cohosts`)).status, 302);
    assert.ok((await page(server, ana, `/e/${before.id}/cohosts`)).body.includes('Co-hosts can&#39;t be added'));
  });

  await t.test('stepping down leaves a co-host a guest, and their page a guest\'s', async () => {
    const e = await makeEvent(ana, { title: 'Brief co-host' });
    await ana.post(`/api/v1/events/${e.id}/cohosts`, { personId: P.fay.id });
    assert.ok(section((await page(server, fay, `/e/${e.id}`)).body, 'host'));
    await fay.del(`/api/v1/events/${e.id}/cohosts/${P.fay.id}`);
    const html = (await page(server, fay, `/e/${e.id}`)).body;
    assert.equal(section(html, 'host'), null);
    assert.ok(section(html, 'rsvp').includes('You&#39;re invited. Are you going?'));
  });

  await t.test('the editor: the cover, plus-ones and capacity', async () => {
    const edit = await page(server, ana, `/e/${party.id}/edit`);
    const form = edit.body;
    // The cover is the hero, drawn (and sized) as the event page draws it,
    // with "Change cover photo" and the × to take it off.
    assert.ok(form.includes('<section class="event-head editor-head has-cover" id="details">'));
    assert.ok(form.includes(img('cover', '(min-width: 700px) 809px, 119vw', ' id="coverPreview"')), 'the cover, previewed');
    assert.ok(form.includes('aria-label="Change cover photo"') && !/id="coverRemove"[^>]*hidden/.test(form));
    assert.ok(form.includes('<option value="2" selected>2</option>'));
    assert.ok(/id="capacity"[^>]*value="2"/.test(form));
    const fresh = (await page(server, ana, '/new')).body;
    assert.ok(fresh.includes('aria-label="Add cover photo"') && /id="coverRemove"[^>]*hidden/.test(fresh));
    assert.ok(fresh.includes('<img class="cover" id="coverPreview" alt="" decoding="async">'));
    assert.ok(fresh.includes('<option value="0" selected>None</option>'));
    assert.ok(/id="capacity"[^>]*value=""/.test(fresh));
    // A new event whose cover didn't upload comes back here to say so.
    assert.equal(pageData((await page(server, ana, `/e/${party.id}/edit?coverError=too_large`)).text).coverError, 'too_large');
    assert.equal(pageData((await page(server, ana, `/e/${party.id}/edit?coverError=%3Cb%3E`)).text).coverError, null);
  });

  await t.test('plus-ones over a lowered limit: kept, and said gently', async () => {
    const e = await makeEvent(ana, { title: 'Dinner', guestsAllowed: 3 });
    await ben.put(`/api/v1/events/${e.id}/rsvp`, { status: 'going', guests: 2 });
    await ana.patch(`/api/v1/events/${e.id}`, { guestsAllowed: 1 });
    const rsvp = section((await page(server, ben, `/e/${e.id}`)).body, 'rsvp');
    assert.ok(rsvp.includes('The host now allows 1 guests each, and you&#39;re down for 2.'), rsvp);
    assert.ok(rsvp.includes('<output id="guestCount" aria-live="polite">2</output>'));
    assert.ok(section((await page(server, ana, `/e/${e.id}`)).body, 'guests').includes('+2 guests · more than now allowed'));
  });

  await t.test('a wall the host shows only to people who\'ve answered', async () => {
    const quiet = await makeEvent(ana, { title: 'Quiet one', guestListVisibility: 'responded' });
    await ana.post(`/api/v1/events/${quiet.id}/invites`, { personIds: [P.eve.id] });
    const wall = section((await page(server, eve, `/e/${quiet.id}`)).body, 'wall');
    assert.ok(wall.includes('The host shows the wall to people who&#39;ve answered.'), wall);
    assert.ok(!wall.includes('wallForm'));
  });

  await t.test('inviting: lookup by phone or Instagram, with the hosts and the removed marked', async () => {
    const r = await page(server, ana, `/e/${party.id}/invite`);
    const lookup = section(r.body, 'lookup');
    assert.ok(lookup.includes('Invite by phone number or Instagram') && lookup.includes('id="lookupForm"'));
    const list = section(r.body, 'invite');
    assert.match(list, /Dee Ruiz[\s\S]*?class="tag off">Removed</);
    assert.match(list, /Fay Tran[\s\S]*?class="tag off">Co-hosting</);
    const d = pageData(r.text);
    assert.equal(d.onList[P.dee.id], 'removed');
    assert.equal(d.links, null);
  });

  await t.test('an event\'s colour: its page (signed out too), its editor and its list card; nothing else', async () => {
    const purple = await makeEvent(ana, { title: 'Purple party', themeHue: 300 });
    const style = UI.themeStyle(300);
    for (const who of [anon, ben, ana]) {
      const html = (await page(server, who, `/e/${purple.id}`)).text;
      assert.ok(html.includes(`<html lang="en" style="${style}">`), 'the page is turned');
      assert.ok(!html.includes('<meta name="theme-color" content="#03120c">'), "the browser's bar too");
    }
    const green = (await page(server, anon, `/e/${party.id}`)).text;
    assert.ok(green.includes('<html lang="en">') && green.includes('<meta name="theme-color" content="#03120c">'));
    // The bar's colour is exactly the page's base colour (--theme-base,
    // what html, body and the mesh are drawn on), hue or grey.
    const grey = await makeEvent(ana, { title: 'Grey party', themeGrayscale: true });
    for (const [id, key] of [[purple.id, 300], [grey.id, 'grey']]) {
      const html = (await page(server, anon, `/e/${id}`)).text;
      const base = /--theme-base:(#[0-9a-f]{6});/.exec(UI.themeStyle(key))[1];
      assert.ok(html.includes(`<meta name="theme-color" content="${base}">`), `theme-color for ${key}`);
      assert.ok(html.includes(`style="${UI.themeStyle(key)}"`));
    }
    assert.ok((await page(server, anon, `/e/${grey.id}`)).text.includes('<meta name="theme-color" content="#0e0e0e">'), 'grey: a neutral near-black');
    const edit = await page(server, ana, `/e/${purple.id}/edit`);
    assert.ok(edit.text.includes(`<html lang="en" style="${style}">`));
    assert.match(edit.body, /<input type="range" id="themeHue" min="0" max="389" step="1" value="330"/);
    assert.match((await page(server, ana, "/new")).body, /id="themeHue"[^>]*value="191"[^>]*aria-valuetext="Canopy green"[\s\S]*id="themeMatch" data-action="theme-match" hidden/);
    const home = await page(server, ana, '/');
    assert.ok(home.text.includes('<html lang="en">'), 'home stays green');
    assert.match(section(home.body, 'list-hosting'), /<a class="event-row card" href="\/e\/[^"]+" style="--card:rgba\(\d+,\d+,\d+,0\.45\)">/);
    assert.ok((await page(server, ana, `/e/${purple.id}/invite`)).text.includes('<html lang="en">'), 'inviting stays green');
  });

  await t.test('home: a cover is the list row\'s 3:2 thumbnail; no cover, the generated one', async () => {
    const hosting = section((await page(server, ana, '/')).body, 'list-hosting');
    assert.ok(hosting.includes(`<span class="thumb">${img('cover', '(min-width: 700px) 200px, 138px', ' loading="lazy"')}`), hosting);
    assert.match(hosting, /<span class="thumb"><span class="cover-art" style="--c0:#[0-9a-f]{6};--c1:#[0-9a-f]{6};/);
    assert.ok(section((await page(server, fay, '/')).body, 'list-hosting').includes('Garden party'));
  });
});

test('the Calendar card on your events page', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const ana = client(server, 'ana');
  let r = await page(server, ana, '/');
  const card = section(r.body, 'calendar');
  assert.ok(card, 'the card');
  assert.ok(card.includes(`href="${server.fake.base}/profile#calendarCard"`), card);
  assert.ok(card.includes('Add to your calendar'));
  assert.match(card, /Show events I&#39;m invited to<\/span><input type="checkbox" role="switch" class="switch" id="calendarInvites" checked>/);
  await ana.patch('/api/v1/me/settings', { calendarInvites: false });
  r = await page(server, ana, '/');
  assert.match(section(r.body, 'calendar'), /id="calendarInvites">/);
  // Signed out: no card.
  assert.equal(section((await page(server, null, '/')).body, 'calendar'), null);
});
