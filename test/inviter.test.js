// The invite sheet's drawing and ordering (public/ui.js; views/event.html
// runs it): which text is a lookup, who's suggested and in what order,
// search, the lists' "Invite all <n>", people already on the event (greyed,
// with their status, never pickable), the tray, and the dialog's markup for
// keyboards and screen readers. Plus the sheet's place on a host's page.

const test = require('node:test');
const assert = require('node:assert/strict');
const UI = require('../public/ui.js');
const { startServer, client, makeEvent } = require('./harness');

const person = (id, firstName, lastName) => ({ id, firstName, lastName, shortName: `${firstName} ${lastName[0]}`, photoUrl: null });

// A host, nine friends (s1..s9 in suggestion order), someone from a list,
// and people on the event already.
function state(over = {}) {
  const people = {};
  const add = (p, sub) => { people[p.id] = { person: p, sub }; };
  const names = [['Zoe', 'Price'], ['Ines', 'Moreau'], ['Leo', 'Alvarez'], ['Maya', 'Chen'], ['Kai', 'Tanaka'], ['Ari', 'Levi'], ['Omar', 'Farouk'], ['Nina', 'Berg'], ['Theo', 'Brooks']];
  names.forEach(([f, l], i) => add(person(`s${i + 1}`, f, l), '1 event together'));
  add(person('x1', 'Bea', 'Adams'), 'Added');
  add(person('m1', 'Cole', 'Ford'), 'On Drag Race');
  add(person('me', 'Ana', 'Lima'), '');
  return {
    me: { id: 'me', emailVerified: true },
    people,
    suggestedIds: ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9'],
    lists: [{ id: 'L1', name: 'Drag Race', memberIds: ['m1', 's1', 's2'] }],
    past: [{ id: 'E1', title: 'Drag Race night 4', startsAt: '2026-10-01T03:00:00.000Z', timeZone: 'America/Los_Angeles' }],
    onList: { s2: 'going', x1: 'invited' },
    selected: [],
    query: '',
    lookup: null,
    ...over
  };
}

test('the invite sheet: what counts as a lookup', () => {
  for (const q of ['ana', 'Ana Lima', '', '  ', '555-1234', '@', 'ana@example.com', '12345678901234567', 'ana.lima', '+1 (415) 555-12ab']) assert.equal(UI.lookupKindOf(q), null, q);
  assert.equal(UI.lookupKindOf('@ana.lima'), 'instagram');
  assert.equal(UI.lookupKindOf('  @Ana_L  '), 'instagram');
  assert.equal(UI.lookupKindOf('(415) 555-1234'), 'phone');
  assert.equal(UI.lookupKindOf('+44 20 7946 0958'), 'phone');
  assert.equal(UI.lookupKindOf('4155551234'), 'phone');
  assert.equal(UI.foldName('Inés Moreau'), 'ines moreau');
});

test('the invite sheet: Suggested first (eight, none on the event), then everyone else A to Z', () => {
  const st = state();
  const { suggested, everyone } = UI.inviteOrder(st);
  // s2 is going: not suggested, but still listed, greyed.
  assert.deepEqual(suggested, ['s1', 's3', 's4', 's5', 's6', 's7', 's8', 's9']);
  assert.deepEqual(everyone, ['x1', 'm1', 's2'], 'Bea Adams, Cole Ford, Ines Moreau: A to Z, you left out');
  assert.equal(UI.SUGGESTED_SHOWN, 8);
  const html = UI.inviteResults(st);
  const at = (s) => html.indexOf(s);
  assert.ok(at('Your lists') < at('Invite everyone from') && at('Invite everyone from') < at('Suggested') && at('Suggested') < at('Everyone else'));
  // With nothing to suggest, one heading: Everyone.
  assert.ok(UI.inviteResults(state({ suggestedIds: [] })).includes('>Everyone<'));
});

test('the invite sheet: searching filters everyone by name, accents aside, suggested first', () => {
  assert.deepEqual(UI.inviteOrder(state({ query: 'ines' })).everyone, ['s2']);
  assert.deepEqual(UI.inviteOrder(state({ query: 'e' })).everyone.slice(0, 2), ['s1', 's3'], 'suggested ones first');
  assert.ok(!UI.inviteOrder(state({ query: 'an' })).everyone.includes('me'), 'never yourself');
  const none = UI.inviteResults(state({ query: 'qqq' }));
  assert.ok(none.includes('No one by that name.') && !none.includes('Your lists'));
  // A phone number or @username: no name filter, the lookup's line instead.
  const st = state({ query: '@cole', lookup: { q: '@cole', state: 'loading' } });
  assert.deepEqual(UI.inviteOrder(st).everyone, []);
  assert.ok(UI.inviteResults(st).includes('Looking…'));
  assert.ok(UI.inviteResults({ ...st, lookup: { q: '@cole', state: 'none' } }).includes('No one found.'));
  assert.ok(UI.inviteResults({ ...st, lookup: { q: '@cole', state: 'error', message: 'Too many.' } }).includes('Too many.'));
  const found = UI.inviteResults({ ...st, lookup: { q: '@cole', state: 'found', person: st.people.m1.person } });
  assert.match(found, /Found<\/h3><ul class="people pick"><li class="person pick-row"><label class="pick-label">.*Cole Ford/);
  // A stale lookup (they've typed on) isn't shown.
  assert.ok(!UI.inviteResults({ ...st, query: '@cole2', lookup: { q: '@cole', state: 'none' } }).includes('No one found.'));
});

test('the invite sheet: people on the event are greyed with their status and can\'t be picked', () => {
  const st = state({ onList: { s2: 'going', x1: 'invited', s3: 'maybe', s4: 'hosting', s5: 'removed' }, selected: ['s1'] });
  const row = (id) => UI.invitePickRow(st, id);
  assert.match(row('s2'), /class="person pick-row on-list"><div class="pick-label">.*<span class="tag status-going">Going<\/span>/);
  assert.ok(row('x1').includes('class="tag status-invited">Invited<') && row('s3').includes('class="tag status-maybe">Maybe<'));
  assert.ok(row('s4').includes('class="tag status-hosting">Hosting<') && row('s5').includes('class="tag off">Removed<'));
  for (const id of ['s2', 'x1', 's3', 's4', 's5']) assert.ok(!row(id).includes('type="checkbox"'), id);
  assert.match(row('s1'), /<label class="pick-label">.*<input type="checkbox" class="pick-box" value="s1" checked aria-label="Zoe Price">/);
  assert.ok(!row('s6').includes('checked'));
});

test('the invite sheet: "Invite all <n>" counts the list\'s people not on the event, and toggles', () => {
  const st = state();
  const l = st.lists[0];
  assert.deepEqual(UI.listPickable(st, l), ['m1', 's1'], 's2 is going');
  assert.match(UI.inviteListRow(st, l), /Drag Race<\/div><div class="sub">3 people<\/div><\/div><button [^>]*data-action="pick-list" data-list="L1" aria-pressed="false">Invite all 2<\/button>/);
  assert.ok(UI.inviteListRow({ ...st, selected: ['s1', 'm1'] }, l).includes('aria-pressed="true"'));
  assert.ok(UI.inviteListRow({ ...st, onList: { m1: 'invited', s1: 'going', s2: 'going' } }, l).includes('All invited'));
  // A list with nobody on it isn't offered.
  assert.ok(!UI.inviteResults(state({ lists: [{ id: 'L2', name: 'Empty', memberIds: [] }] })).includes('Empty'));
});

test('the invite sheet: the tray is the picked as faces, newest first, and "Invite <n>"', () => {
  assert.match(UI.inviteTray(state()), /<button type="button" id="inviteSend" data-action="send-invites" disabled>Invite<\/button>/);
  const tray = UI.inviteTray(state({ selected: ['s1', 'm1', 's3'] }));
  assert.ok(tray.includes('>Invite 3</button>') && !tray.includes('disabled'));
  assert.ok(tray.includes('role="list" aria-label="3 picked"'));
  const faces = [...tray.matchAll(/data-person="([^"]+)" aria-label="([^"]+)"/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(faces, [['s3', 'Take Leo Alvarez out'], ['m1', 'Take Cole Ford out'], ['s1', 'Take Zoe Price out']]);
});

test('the invite sheet: a dialog with a labelled search box, the past events to pick from, and a live region', () => {
  const html = UI.inviteSheet({ title: 'Drag Race night 5' }, state());
  assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="inviteHeading"/);
  assert.ok(html.includes('<h2 id="inviteHeading">Invite to Drag Race night 5</h2>'));
  assert.match(html, /<input type="search" id="inviteSearch" placeholder="Name, phone or @username" aria-label="Search your friends, or find someone by phone number or Instagram" aria-controls="inviteResults"/);
  assert.ok(html.includes('data-action="close-invite" aria-label="Close"'));
  assert.ok(html.includes('<label class="sr-only" for="inviteFrom">Invite everyone from…</label>'));
  assert.ok(html.includes('<option value="E1">Drag Race night 4 · Sep 30</option>'), 'in the event\'s own time zone');
  assert.ok(html.includes('id="inviteLive" aria-live="polite"'));
  assert.ok(UI.inviteSheet({ title: 'T' }, { loading: true, people: {}, selected: [], onList: {} }).includes('Loading…'));
});

test('the invite sheet on a host\'s page: the Invite button opens it; guests have none', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const ana = client(server, 'ana');
  const ben = client(server, 'ben');
  const e = await makeEvent(ana, { title: 'Sheet party' });
  const host = (await ana.get(`/e/${e.id}`, { headers: { Accept: 'text/html' } })).text;
  assert.ok(host.includes('<button type="button" class="secondary" data-action="open-invite" id="inviteBtn" aria-haspopup="dialog">Invite</button>'));
  assert.ok(host.includes('function openInvite(') && host.includes("has('invite')"), 'the page opens it, and does for ?invite=1');
  await ben.put(`/api/v1/events/${e.id}/rsvp`, { status: 'going' });
  const guest = (await ben.get(`/e/${e.id}`, { headers: { Accept: 'text/html' } })).text;
  assert.ok(!guest.slice(guest.indexOf('<body'), guest.indexOf('id="pageData"')).includes('data-action="open-invite"'));
});
