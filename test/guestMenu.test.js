// A guest's ⋯ menu on an event (routes/guestMenu.js): muting it, leaving
// it, and opting out of a host's invitations. What each does to the
// inbox, the guest list, the waitlist, the wall, the calendar and
// invitations; who may use them; and how the pages draw them.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, makeEvent, findLeaks, calendarAuth } = require('./harness');
const { createNotifier, MUTED_TYPES } = require('../lib/notify');
const UI = require('../public/ui.js');

const PUBLIC_FIELDS = ['firstName', 'id', 'lastName', 'photoUrl', 'shortName'];

async function inbox(who, eventId) {
  const r = await who.get('/api/v1/me/notifications?limit=100');
  assert.equal(r.status, 200);
  return r.data.notifications.filter((n) => !eventId || (n.event && n.event.id === eventId)).map((n) => n.type);
}

async function page(server, who, url) {
  const r = await who.get(url, { headers: { Accept: 'text/html' } });
  assert.deepEqual(findLeaks(r.text, null, server.people), [], `contact details in ${url}`);
  const start = r.text.indexOf('<body class=');
  const end = r.text.indexOf('<script type="application/json" id="pageData">');
  r.body = r.text.slice(start, end);
  return r;
}

test('notify(): a muted guest misses the chatter and keeps the essentials; a host is never muted', () => {
  const written = [];
  const store = {
    mutedOn: () => new Set(['muted']),
    addNotifications: (type, to) => { written.push([type, to]); return []; },
    getEvent: () => null
  };
  const notify = createNotifier({ store, push: { queue() {} } });
  for (const type of ['wall_post', 'rsvp', 'cohost_added', 'event_changed', 'event_cancelled', 'event_uncancelled', 'waitlist_promoted', 'invited']) {
    notify(type, { to: ['muted', 'other'], eventId: 'E' });
  }
  assert.deepEqual(MUTED_TYPES, ['wall_post', 'rsvp', 'cohost_added']);
  assert.deepEqual(Object.fromEntries(written), {
    wall_post: ['other'], rsvp: ['other'], cohost_added: ['other'],
    event_changed: ['muted', 'other'], event_cancelled: ['muted', 'other'], event_uncancelled: ['muted', 'other'],
    waitlist_promoted: ['muted', 'other'], invited: ['muted', 'other']
  });
});

test('mute: who may, what it stops, what it keeps, and unmuting', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const P = server.people;
  const [ana, ben, cy, dee, eve] = ['ana', 'ben', 'cy', 'dee', 'eve'].map((n) => client(server, n));
  const benApp = client(server, 'ben', { mode: 'bearer' });
  const e = await makeEvent(ana);
  await ben.put(`/api/v1/events/${e.id}/rsvp`, { status: 'going' });
  await cy.put(`/api/v1/events/${e.id}/rsvp`, { status: 'maybe' });
  await ana.post(`/api/v1/events/${e.id}/invites`, { personIds: [P.dee.id] });

  // Who may: a guest with an answer or an invitation; not a host, not
  // someone off the event, not someone removed.
  assert.deepEqual([(await ana.put(`/api/v1/events/${e.id}/mute`)).status, (await ana.put(`/api/v1/events/${e.id}/mute`)).data.reason], [409, 'is_host']);
  assert.equal((await eve.put(`/api/v1/events/${e.id}/mute`)).data.reason, 'not_on_event');
  const r = await benApp.put(`/api/v1/events/${e.id}/mute`);
  assert.equal(r.status, 200);
  assert.equal(r.data.event.viewer.muted, true);
  assert.equal((await ben.put(`/api/v1/events/${e.id}/mute`)).status, 200, 'again is fine');
  assert.equal((await dee.put(`/api/v1/events/${e.id}/mute`)).data.event.viewer.muted, true, 'invited is enough');
  assert.equal((await cy.get(`/api/v1/events/${e.id}`)).data.event.viewer.muted, false, "someone else's mute is theirs");

  // The chatter: a host's wall post reaches cy, not ben or dee.
  await ana.post(`/api/v1/events/${e.id}/wall`, { text: 'Bring snacks' });
  assert.ok((await inbox(cy, e.id)).includes('wall_post'));
  assert.ok(!(await inbox(ben, e.id)).includes('wall_post'));
  // The essentials still reach them: moved, cancelled, back on.
  await ana.patch(`/api/v1/events/${e.id}`, { locationName: 'Somewhere else' });
  await ana.patch(`/api/v1/events/${e.id}`, { status: 'cancelled' });
  await ana.patch(`/api/v1/events/${e.id}`, { status: 'active' });
  assert.deepEqual((await inbox(ben, e.id)).sort(), ['event_cancelled', 'event_changed', 'event_uncancelled']);
  // Nothing on the guest list says so.
  const guests = (await ana.get(`/api/v1/events/${e.id}/guests`)).data.guests;
  assert.deepEqual(guests.map((g) => Object.keys(g).sort()), guests.map(() => ['guests', 'guestsOverLimit', 'person', 'respondedAt', 'status']));

  // Made a co-host while muted: a host is never muted (they hear it, and
  // the answers that hosts get).
  await cy.get('/api/v1/me');
  await cy.put(`/api/v1/events/${e.id}/mute`);
  await ana.post(`/api/v1/events/${e.id}/cohosts`, { personId: P.cy.id });
  assert.ok((await inbox(cy, e.id)).includes('cohost_added'));
  assert.equal((await cy.get(`/api/v1/events/${e.id}`)).data.event.viewer.muted, false);
  await eve.put(`/api/v1/events/${e.id}/rsvp`, { status: 'going' });
  assert.ok((await inbox(cy, e.id)).includes('rsvp'));

  // Unmuting: always fine, and the chatter comes back.
  const un = await ben.del(`/api/v1/events/${e.id}/mute`);
  assert.deepEqual([un.status, un.data.event.viewer.muted], [200, false]);
  assert.equal((await ben.del(`/api/v1/events/${e.id}/mute`)).status, 200);
  await ana.post(`/api/v1/events/${e.id}/wall`, { text: 'Again' });
  assert.ok((await inbox(ben, e.id)).includes('wall_post'));

  // Removed: nothing to mute.
  await ana.put(`/api/v1/events/${e.id}/removed/${P.eve.id}`);
  assert.equal((await eve.put(`/api/v1/events/${e.id}/mute`)).data.reason, 'removed');
});

test('leave: off the event entirely, the spot to the waitlist, and back as a fresh visitor', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const P = server.people;
  const [ana, ben, cy, dee, eve] = ['ana', 'ben', 'cy', 'dee', 'eve'].map((n) => client(server, n));
  const anon = client(server, null);
  const e = await makeEvent(ana, { capacity: 1 });
  await ben.put(`/api/v1/events/${e.id}/rsvp`, { status: 'going' });
  const wait = await cy.put(`/api/v1/events/${e.id}/rsvp`, { status: 'going' });
  assert.equal(wait.data.waitlisted, true);
  await ana.post(`/api/v1/events/${e.id}/wall`, { text: 'See you' });
  await ben.put(`/api/v1/events/${e.id}/mute`);
  await ana.patch(`/api/v1/events/${e.id}`, { locationName: 'Upstairs' });
  assert.ok((await inbox(ben, e.id)).length > 0, 'ben has notifications about it');
  const feed = async (p) => (await anon.get(`/api/calendar/${p.id}`, { headers: { Authorization: calendarAuth(p.id) } })).data.entries;
  assert.equal((await feed(P.ben)).length, 1);
  assert.ok((await ana.get(`/api/v1/events/${e.id}/wall`)).data.entries.some((x) => x.type === 'going' && x.person.id === P.ben.id));

  // Hosts can't; nor can someone not on it.
  assert.deepEqual([(await ana.post(`/api/v1/events/${e.id}/leave`)).status, (await ana.post(`/api/v1/events/${e.id}/leave`)).data.reason], [409, 'is_host']);
  assert.equal((await eve.post(`/api/v1/events/${e.id}/leave`)).data.reason, 'not_on_event');

  const r = await ben.post(`/api/v1/events/${e.id}/leave`);
  assert.equal(r.status, 200);
  assert.equal(r.data.event.viewer.rsvp, null, 'as anyone opening the link');
  assert.equal(r.data.event.viewer.muted, false, 'the mute went too');
  // The row is gone: not on the list (not even as can't go), not counted.
  const list = (await ana.get(`/api/v1/events/${e.id}/guests`)).data;
  assert.ok(!list.guests.some((g) => g.person.id === P.ben.id));
  assert.equal(list.counts.notGoing, 0);
  // The waitlist moved up, and cy heard.
  assert.equal((await cy.get(`/api/v1/events/${e.id}`)).data.event.viewer.rsvp.status, 'going');
  assert.ok((await inbox(cy, e.id)).includes('waitlist_promoted'));
  // Their "going" left the wall; their notifications about it went; it's
  // out of their lists and their calendar.
  assert.ok(!(await ana.get(`/api/v1/events/${e.id}/wall`)).data.entries.some((x) => x.type === 'going' && x.person.id === P.ben.id));
  assert.deepEqual(await inbox(ben, e.id), []);
  assert.ok(!(await ben.get('/api/v1/me/events/upcoming')).data.events.some((x) => x.id === e.id));
  assert.deepEqual(await feed(P.ben), []);
  // Leaving again: they're not on it.
  assert.equal((await ben.post(`/api/v1/events/${e.id}/leave`)).data.reason, 'not_on_event');
  // Not removed: the link works and they can answer afresh (the waitlist
  // now, the spot being cy's).
  const again = await ben.put(`/api/v1/events/${e.id}/rsvp`, { status: 'going' });
  assert.deepEqual([again.status, again.data.waitlisted], [200, true]);

  // Invited, no answer: leaving takes the invitation off too.
  await ana.post(`/api/v1/events/${e.id}/invites`, { personIds: [P.dee.id] });
  assert.ok((await dee.get('/api/v1/me/events/invitations')).data.events.some((x) => x.id === e.id));
  assert.equal((await dee.post(`/api/v1/events/${e.id}/leave`)).status, 200);
  assert.ok(!(await dee.get('/api/v1/me/events/invitations')).data.events.some((x) => x.id === e.id));
  assert.deepEqual(await inbox(dee, e.id), []);

  // A co-host steps down instead; removed people can't.
  await cy.get('/api/v1/me');
  await ana.post(`/api/v1/events/${e.id}/cohosts`, { personId: P.cy.id });
  assert.equal((await cy.post(`/api/v1/events/${e.id}/leave`)).data.reason, 'is_host');
  await ana.put(`/api/v1/events/${e.id}/removed/${P.eve.id}`);
  assert.equal((await eve.post(`/api/v1/events/${e.id}/leave`)).data.reason, 'removed');
});

test('opting out of a host\'s invitations: skipped, vaguely, no friendship, and undone', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const P = server.people;
  const [ana, ben, dee, fay] = ['ana', 'ben', 'dee', 'fay'].map((n) => client(server, n));

  // Dee is on one of Ana's events, and opts out of Ana's invitations.
  const first = await makeEvent(ana);
  await dee.put(`/api/v1/events/${first.id}/rsvp`, { status: 'going' });
  assert.equal((await dee.put(`/api/v1/me/invite-optouts/${P.ana.id}`)).status, 200);
  assert.equal((await dee.put(`/api/v1/me/invite-optouts/${P.ana.id}`)).status, 200, 'twice is fine');
  assert.equal((await dee.put(`/api/v1/me/invite-optouts/${P.dee.id}`)).data.reason, 'is_you');
  assert.equal((await dee.put('/api/v1/me/invite-optouts/00000000-0000-4000-8000-000000000999')).data.reason, 'person_not_found');
  assert.equal((await dee.put('/api/v1/me/invite-optouts/nope')).data.reason, 'bad_person_id');
  // The list: the public shape, and only ever yours.
  const mine = (await dee.get('/api/v1/me/invite-optouts')).data.hosts;
  assert.deepEqual(mine.map((p) => p.id), [P.ana.id]);
  assert.deepEqual(Object.keys(mine[0]).sort(), PUBLIC_FIELDS);
  assert.deepEqual((await ben.get('/api/v1/me/invite-optouts')).data.hosts, []);
  // It doesn't take her off the event she's on.
  assert.equal((await dee.get(`/api/v1/events/${first.id}`)).data.event.viewer.rsvp.status, 'going');

  // Fay opts out too, and has never met Ana: no friendship may come of it.
  await fay.put(`/api/v1/me/invite-optouts/${P.ana.id}`);
  const next = await makeEvent(ana);
  const r = await ana.post(`/api/v1/events/${next.id}/invites`, { personIds: [P.fay.id, P.ben.id, '00000000-0000-4000-8000-000000000999'] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.invited.map((p) => p.id), [P.ben.id]);
  // The same answer as for someone with no account.
  assert.deepEqual(r.data.skipped, [
    { personId: P.fay.id, reason: 'not_found' },
    { personId: '00000000-0000-4000-8000-000000000999', reason: 'not_found' }
  ]);
  assert.ok(!(await fay.get('/api/v1/me/events/invitations')).data.events.some((x) => x.id === next.id));
  assert.deepEqual(await inbox(fay), []);
  assert.ok(!(await fay.get('/api/v1/me/friends')).data.friends.some((f) => f.person.id === P.ana.id), 'no friendship from it');
  assert.ok(!(await ana.get('/api/v1/me/friends')).data.friends.some((f) => f.person.id === P.fay.id));
  // Someone already on the event gets the answer anyone would.
  const again = await ana.post(`/api/v1/events/${first.id}/invites`, { personIds: [P.dee.id] });
  assert.deepEqual(again.data.skipped, [{ personId: P.dee.id, reason: 'already_on_list' }]);
  assert.equal((await dee.get(`/api/v1/events/${first.id}`)).data.event.viewer.rsvp.invited, false, 'and nothing about her changed');
  // Another host's invitations still reach her.
  const bens = await makeEvent(ben);
  assert.deepEqual((await ben.post(`/api/v1/events/${bens.id}/invites`, { personIds: [P.fay.id] })).data.invited.map((p) => p.id), [P.fay.id]);

  // Undo: Ana's invitations reach her again.
  assert.equal((await fay.del(`/api/v1/me/invite-optouts/${P.ana.id}`)).status, 200);
  assert.equal((await fay.del(`/api/v1/me/invite-optouts/${P.ana.id}`)).status, 200, 'twice is fine');
  assert.deepEqual((await fay.get('/api/v1/me/invite-optouts')).data.hosts, []);
  assert.deepEqual((await ana.post(`/api/v1/events/${next.id}/invites`, { personIds: [P.fay.id] })).data.invited.map((p) => p.id), [P.fay.id]);
});

test('the pages: a guest\'s ⋯ menu, and the friends page\'s opt-outs', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const P = server.people;
  const [ana, ben, cy] = ['ana', 'ben', 'cy'].map((n) => client(server, n));
  const anon = client(server, null);
  const e = await makeEvent(ana);
  await ben.put(`/api/v1/events/${e.id}/rsvp`, { status: 'maybe' });
  await cy.get('/api/v1/me');
  await ana.post(`/api/v1/events/${e.id}/cohosts`, { personId: P.cy.id });

  const menuOf = (html) => {
    const m = /<div class="menu" id="guestMenu"[^>]*>([\s\S]*?)<\/div><\/div>/.exec(html);
    return m ? [...m[1].matchAll(/data-action="([\w-]+)"[^>]*>([^<]+)</g)].map((x) => [x[1], x[2]]) : null;
  };
  // A guest: on the card's heading line; one item per host.
  let html = (await page(server, ben, `/e/${e.id}`)).body;
  assert.match(html, /<div class="card-head-row"><h3>[^<]+<\/h3><div class="menu-wrap"><button type="button" class="secondary more-btn" id="guestMenuBtn" data-action="guest-menu" aria-haspopup="menu" aria-expanded="false" aria-controls="guestMenu"/);
  assert.deepEqual(menuOf(html), [
    ['mute', 'Mute event'],
    ['optout-invites', 'Opt out of invites from Ana'],
    ['optout-invites', 'Opt out of invites from Cy'],
    ['leave', 'Remove me from event']
  ]);
  // Muted and opted out: the items say so.
  await ben.put(`/api/v1/events/${e.id}/mute`);
  await ben.put(`/api/v1/me/invite-optouts/${P.ana.id}`);
  html = (await page(server, ben, `/e/${e.id}`)).body;
  assert.deepEqual(menuOf(html).slice(0, 3), [['unmute', 'Unmute event'], ['allow-invites', 'Allow invites from Ana'], ['optout-invites', 'Opt out of invites from Cy']]);
  // Hosts (creator and co-host) and someone signed out: no guest menu.
  for (const who of [ana, cy, anon]) assert.ok(!(await page(server, who, `/e/${e.id}`)).body.includes('guestMenuBtn'));
  // Someone who opened the link and hasn't answered: nothing to mute or leave.
  assert.ok(!(await page(server, client(server, 'dee'), `/e/${e.id}`)).body.includes('guestMenuBtn'));

  // The friends page lists who they opted out of, with Undo.
  const friends = (await page(server, ben, '/friends')).body;
  assert.match(friends, /<section class="card" id="optouts" data-section="optouts"><h2>Opted out of invites from<\/h2>/);
  assert.ok(friends.includes(`data-action="undo-optout" data-person="${P.ana.id}">Undo</button>`));
  assert.ok(!(await page(server, cy, '/friends')).body.includes('id="optouts"'), 'nothing when there is nobody');

  // ui.js: two hosts with one first name get their short names.
  const twin = UI.guestMenu({
    viewer: { role: null, rsvp: { status: 'going' }, muted: false },
    hosts: [{ person: { id: 'a', firstName: 'Sam', shortName: 'Sam L' } }, { person: { id: 'b', firstName: 'Sam', shortName: 'Sam K' } }]
  }, { optouts: [] });
  assert.ok(twin.includes('Opt out of invites from Sam L') && twin.includes('Opt out of invites from Sam K'));
  assert.equal(UI.guestMenu({ viewer: { role: null, rsvp: { status: 'removed' } }, hosts: [] }, {}), '');
});
