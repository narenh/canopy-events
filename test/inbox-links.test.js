// The inbox (and push) never hand an event's current link to someone who
// isn't on the event any more, so "make a new link" keeps out the people
// it's made to keep out. From the security review's repro: a removed
// guest and an uninvited one used to read the new link from their inbox.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, makeEvent } = require('./harness');
const { createNotifier } = require('../lib/notify');

test('a new link stays out of the inbox of people taken off the event', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const P = server.people;
  const [ana, ben, dee, una] = ['ana', 'ben', 'dee', 'una'].map((n) => client(server, n));
  for (const who of [ana, ben, dee, una]) await who.get('/api/v1/me');

  // Everything `who` can get from the API without knowing the link.
  async function everythingSeenBy(who) {
    const urls = ['/api/v1/me', '/api/v1/me/notifications?limit=100', '/api/v1/me/notifications/unread',
      ...['hosting', 'upcoming', 'invitations', 'declined', 'all', 'past'].map((l) => `/api/v1/me/events/${l}?limit=100`)];
    let all = '';
    for (const url of urls) {
      const r = await who.get(url);
      assert.equal(r.status, 200, `${url}: ${r.text}`);
      all += r.text;
    }
    return all;
  }

  await t.test("removed and uninvited people don't get the new link (newlink.js)", async () => {
    const e = await makeEvent(ana);
    const E = `/api/v1/events/${e.id}`;
    assert.equal((await ana.post(`${E}/invites`, { personIds: [P.ben.id, P.dee.id] })).status, 200);
    assert.equal((await ben.put(`${E}/rsvp`, { status: 'going' })).status, 200);
    // A host post, so Ben has more than the invitation in his inbox.
    assert.equal((await ana.post(`${E}/wall`, { text: 'Parking is round the back' })).status, 201);
    const aboutIt = async (who) => (await who.get('/api/v1/me/notifications?limit=100')).data.notifications
      .filter((n) => n.event && n.event.id === e.id);
    assert.ok((await aboutIt(ben)).length >= 2);
    assert.equal((await aboutIt(dee)).length, 1);

    assert.equal((await ana.put(`${E}/removed/${P.ben.id}`)).status, 200);
    assert.equal((await ana.del(`${E}/invites/${P.dee.id}`)).status, 200);
    // Their notifications about it are gone, unread count included.
    for (const who of [ben, dee]) {
      const inbox = (await who.get('/api/v1/me/notifications?limit=100')).data;
      assert.deepEqual(inbox.notifications, [], who.person.name);
      assert.equal(inbox.unreadCount, 0);
    }

    const r = await ana.post(`${E}/new-link`);
    assert.equal(r.status, 200);
    const fresh = r.data.event;
    assert.notEqual(fresh.id, e.id);
    assert.equal((await ben.get(E)).status, 404, 'the old link is dead');
    for (const who of [ben, dee]) {
      const seen = await everythingSeenBy(who);
      assert.ok(!seen.includes(fresh.id), `${who.person.name} can read the new link`);
    }
    // Ana (a host) still has it, from her inbox too.
    const anas = (await ana.get('/api/v1/me/notifications?limit=100')).data.notifications.filter((n) => n.event);
    assert.ok(anas.length > 0 && anas.every((n) => n.event.id === fresh.id && n.event.url === fresh.url));
  });

  await t.test('the inbox shows the event only to people still on it', async () => {
    const e = await makeEvent(ana, { title: 'Second' });
    const E = `/api/v1/events/${e.id}`;
    // Una answers without an invitation and hears about a host's post.
    assert.equal((await una.put(`${E}/rsvp`, { status: 'maybe' })).status, 200);
    assert.equal((await ana.post(`${E}/wall`, { text: 'Bring snacks' })).status, 201);
    const posts = async () => (await una.get('/api/v1/me/notifications?limit=100')).data.notifications
      .filter((n) => n.type === 'wall_post' && n.details.text === 'Bring snacks');
    let [n] = await posts();
    assert.equal(n.event.id, e.id);
    // Can't Go is still an answer: she's on the list, and it's still there.
    assert.equal((await una.put(`${E}/rsvp`, { status: 'not_going' })).status, 200);
    [n] = await posts();
    assert.equal(n.event.id, e.id);
    // No route takes a guest off the list and leaves their inbox any more
    // (there's no taking an answer back; removing and uninviting clear
    // it), so her row goes behind the API's back: her inbox keeps the line
    // but not the event.
    server.db().prepare('DELETE FROM rsvps WHERE event_id = ? AND person_id = ?').run(e.id, P.una.id);
    [n] = await posts();
    assert.ok(n, 'the notification stays');
    assert.equal(n.event, null, 'without the event');
    const r = await ana.post(`${E}/new-link`);
    assert.ok(!(await everythingSeenBy(una)).includes(r.data.event.id));
    // On the event again (she answers at the new link), she sees it again.
    assert.equal((await una.put(`/api/v1/events/${r.data.event.id}/rsvp`, { status: 'going' })).status, 200);
    [n] = await posts();
    assert.equal(n.event.id, r.data.event.id);
  });

  await t.test('a removal undone is invited again, with a fresh inbox', async () => {
    const e = await makeEvent(ana, { title: 'Third' });
    const E = `/api/v1/events/${e.id}`;
    await ana.post(`${E}/invites`, { personIds: [P.dee.id] });
    await ana.put(`${E}/removed/${P.dee.id}`);
    assert.equal((await ana.del(`${E}/removed/${P.dee.id}`)).status, 200);
    const inv = (await dee.get('/api/v1/me/events/invitations')).data.events;
    assert.ok(inv.some((x) => x.id === e.id), 'back in her invitations, as before');
  });
});

test("a push carries the event's link only to someone on the event", () => {
  const sent = [];
  const store = {
    addNotifications: (type, ids) => ids.map((personId, i) => ({ notification: { id: i + 1, personId }, isNew: true })),
    getEvent: () => ({ id: 'internal0001', publicId: 'NewLink00001', title: 'Rooftop dinner' }),
    isOnEvent: (eventId, personId) => personId === 'on',
    unreadCount: () => 1
  };
  const notify = createNotifier({ store, push: { queue: (personId, message) => sent.push({ personId, message }) } });
  notify('event_changed', { to: ['on', 'off'], actorId: 'host', eventId: 'internal0001', details: { changed: ['time'] } });
  const to = Object.fromEntries(sent.map((s) => [s.personId, s.message]));
  assert.equal(to.on.eventId, 'NewLink00001');
  assert.equal(to.on.eventTitle, 'Rooftop dinner');
  assert.equal(to.off.eventId, null);
  assert.equal(to.off.eventTitle, null);
});
