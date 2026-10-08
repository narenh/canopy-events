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
    assert.equal(UI.when(e, 'Europe/London').zoneNote, 'Times are Los Angeles time (PDT).');
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
    assert.ok(html.includes('1 going · 1 maybe'), 'counts are public');
    const here = encodeURIComponent(`${server.base}/e/${party.id}`);
    const rsvp = section(html, 'rsvp');
    assert.ok(rsvp.includes(`href="${server.fake.base}/?quick=1&amp;return=${here}">RSVP</a>`), rsvp);
    assert.ok(rsvp.includes(`href="${server.fake.base}/?return=${here}">I have a Canopy account, sign in</a>`));
    assert.equal(section(html, 'guests'), null);
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
    const friends = section(html, 'friends-going');
    assert.ok(friends.includes('1 friend going') && friends.includes('Ben O'), friends);
  });

  await t.test('responded-only list, not answered yet: counts, and why there are no names', async () => {
    const html = (await page(server, dee, `/e/${quiet.id}`)).body;
    const guests = section(html, 'guests');
    assert.ok(guests.includes('1 going'));
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
    assert.ok(html.includes('1 going · 1 maybe · 1 invited'));
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
    assert.match(london, /Times are Los Angeles time \(P[SD]T\)\./);
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
    assert.ok(host.includes(`href="${server.fake.base}/profile"`), 'your photo goes to your profile');
    assert.ok(host.includes(`${server.fake.base}/signout?return=`), 'sign out');
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
    const fresh = await page(server, ana, '/new');
    assert.equal(fresh.status, 200);
    for (const id of ['title', 'description', 'startsAt', 'endsAt', 'timeZone', 'locationName', 'locationAddress']) {
      assert.ok(fresh.body.includes(`id="${id}"`), id);
    }
    assert.ok(fresh.body.includes('Everyone with the link sees who is coming.'));
    assert.ok(fresh.body.includes("People see who is coming once they&#39;ve answered."));
    const edit = await page(server, ana, `/e/${party.id}/edit`);
    assert.equal(edit.status, 200);
    assert.ok(edit.body.includes('value="Rooftop dinner"'));
    assert.ok(edit.body.includes(`value="${UI.localInput(party.startsAt, party.timeZone)}"`));
    assert.ok(edit.body.includes('<option value="America/Los_Angeles" selected>'));
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
    // Ben (going) and Cy (maybe) are friends from the picnic.
    assert.match(list, /Ben Okafor[\s\S]*?class="tag">Going</);
    assert.match(list, /Cy Park[\s\S]*?class="tag off">Maybe</);
    const d = pageData(r.text);
    assert.equal(d.onList[P.dee.id], 'invited');
    assert.deepEqual(d.friends.map((f) => f.person.id).sort(), [P.ben.id, P.cy.id].sort());
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
    const none = await page(server, dee, '/friends');
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
    assert.equal(UI.whenHead(one, 'Europe/London').zoneNote, 'Times are Los Angeles time (PDT).');
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
    assert.ok(details.includes(`<img class="cover" src="${cover}" alt="">`), details);
    assert.equal(meta(r.text, 'og:image'), cover);
    assert.equal(meta(r.text, 'twitter:image'), cover);
    assert.equal(meta(r.text, 'twitter:card'), 'summary_large_image');
    assert.ok(details.includes('1 going +1 guest · 1 maybe · 1 on the waitlist'), details);
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
    assert.match(details, /<div class="hero"><span class="cover-art" style="[^"]+" aria-hidden="true"><\/span><\/div>/);
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
    assert.match(host, /Co-hosts · 1[\s\S]*Fay Tran[\s\S]*data-action="remove-cohost" data-person="[^"]+" data-name="Fay Tran"/);
    assert.ok(host.includes(`href="/e/${party.id}/cohosts">Add co-host</a>`));
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
    assert.ok(form.includes(`id="coverPreview" alt="" src="${cover}"`), 'the cover, previewed');
    assert.ok(form.includes('Replace photo') && form.includes('id="coverFile"') && !/id="coverRemove"[^>]*hidden/.test(form));
    assert.ok(form.includes('<option value="2" selected>2</option>'));
    assert.ok(/id="capacity"[^>]*value="2"/.test(form));
    const fresh = (await page(server, ana, '/new')).body;
    assert.ok(fresh.includes('Choose photo') && /id="coverRemove"[^>]*hidden/.test(fresh));
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

  await t.test('home: a cover is the list row\'s 3:2 thumbnail; no cover, the generated one', async () => {
    const hosting = section((await page(server, ana, '/')).body, 'list-hosting');
    assert.ok(hosting.includes(`<span class="thumb"><img class="cover" src="${cover}" alt="" loading="lazy">`), hosting);
    assert.match(hosting, /<span class="thumb"><span class="cover-art" style="--c1:#[0-9a-f]{6};/);
    assert.ok(section((await page(server, fay, '/')).body, 'list-hosting').includes('Garden party'));
  });
});
