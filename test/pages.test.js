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
  const start = r.text.indexOf('<body');
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
    assert.ok(html.includes('class="tag off">Ended<'));
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
