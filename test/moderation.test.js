// Host moderation: removing a guest (and undoing it), and making a new
// link. A removed guest can't answer again, disappears for everyone else,
// and sees no more than someone signed out; a new link kills the old one
// and moves nobody.

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { startServer, client, makeEvent } = require('./harness');

test('removing a guest', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const P = server.people;
  const [ana, ben, cy, dee, eve, fay] = ['ana', 'ben', 'cy', 'dee', 'eve', 'fay'].map((n) => client(server, n));
  const rsvp = (who, id, status) => who.put(`/api/v1/events/${id}/rsvp`, { status });
  const remove = (who, id, personId) => who.put(`/api/v1/events/${id}/removed/${personId}`);
  const restore = (who, id, personId) => who.del(`/api/v1/events/${id}/removed/${personId}`);
  const guestIds = async (who, id, q = '') => (await who.get(`/api/v1/events/${id}/guests${q}`)).data.guests.map((g) => g.person.id);
  for (const who of [ana, ben, cy, dee, eve, fay]) await who.get('/api/v1/me');

  await t.test('a removed guest is off the list, the counts and the wall, and their spot goes to the waitlist', async () => {
    const e = await makeEvent(ana, { capacity: 2 });
    await rsvp(ben, e.id, 'going');
    await rsvp(cy, e.id, 'going');
    await rsvp(dee, e.id, 'going'); // waitlisted
    await ben.post(`/api/v1/events/${e.id}/wall`, { text: "Ben's post" });
    const r = await remove(ana, e.id, P.ben.id);
    assert.deepEqual(r.data, { ok: true });
    const ev = (await ana.get(`/api/v1/events/${e.id}`)).data.event;
    assert.equal(ev.counts.going, 2, 'Cy, and Dee off the waitlist');
    assert.equal(ev.counts.waitlisted, 0);
    assert.equal((await dee.get(`/api/v1/events/${e.id}`)).data.event.viewer.rsvp.status, 'going');
    // Off the list for everyone, hosts included unless they ask.
    assert.deepEqual(await guestIds(cy, e.id), [P.cy.id, P.dee.id]);
    assert.deepEqual(await guestIds(ana, e.id), [P.cy.id, P.dee.id]);
    assert.deepEqual(await guestIds(ana, e.id, '?status=removed'), [P.ben.id]);
    const nope = await cy.get(`/api/v1/events/${e.id}/guests?status=removed`);
    assert.equal(nope.status, 403);
    assert.equal(nope.data.reason, 'hosts_only');
    // Nothing of his on the wall.
    const wall = (await ana.get(`/api/v1/events/${e.id}/wall`)).data.entries;
    assert.ok(wall.every((w) => !w.person || w.person.id !== P.ben.id), JSON.stringify(wall));
    // Not in his lists.
    assert.ok(!(await ben.get('/api/v1/me/events/upcoming')).data.events.some((x) => x.id === e.id));
  });

  await t.test('they see what someone signed out sees, and can\'t answer, post or be invited', async () => {
    const e = await makeEvent(ana, { guestListVisibility: 'everyone' });
    await rsvp(ben, e.id, 'going');
    await rsvp(cy, e.id, 'going');
    server.setTimes(e.id, { startedAgoMs: -86400e3, overInMs: 2 * 86400e3 });
    await remove(ana, e.id, P.cy.id);
    const ev = (await cy.get(`/api/v1/events/${e.id}`)).data.event;
    assert.equal(ev.title, 'Rooftop dinner');
    assert.equal(ev.locationAddress, null);
    assert.equal(ev.locationAddressHidden, true);
    assert.equal(ev.friendsGoing, undefined);
    assert.deepEqual(ev.viewer, {
      role: null, canEdit: false, canSeeGuestList: false, canPost: false,
      rsvp: { status: 'removed', guests: 0, guestsOverLimit: false, invited: false, respondedAt: null }
    });
    assert.deepEqual((await cy.get(`/api/v1/events/${e.id}/guests`)).data.guests, []);
    assert.equal((await cy.get(`/api/v1/events/${e.id}/wall`)).data.wallVisible, false);
    for (const r of [await rsvp(cy, e.id, 'going'), await rsvp(cy, e.id, 'not_going'), await cy.del(`/api/v1/events/${e.id}/rsvp`)]) {
      assert.equal(r.status, 409);
      assert.equal(r.data.reason, 'removed');
    }
    assert.equal((await cy.post(`/api/v1/events/${e.id}/wall`, { text: 'hi' })).data.reason, 'answer_first');
    const inv = await ana.post(`/api/v1/events/${e.id}/invites`, { personIds: [P.cy.id] });
    assert.deepEqual(inv.data.skipped, [{ personId: P.cy.id, reason: 'removed' }]);
    // Not told about changes any more.
    await ana.patch(`/api/v1/events/${e.id}`, { locationName: 'Somewhere else' });
    const told = (await cy.get('/api/v1/me/notifications')).data.notifications.filter((n) => n.event && n.event.id === e.id);
    assert.ok(!told.some((n) => n.type === 'event_changed'));
    assert.ok((await ben.get('/api/v1/me/notifications')).data.notifications.some((n) => n.type === 'event_changed' && n.event.id === e.id));
  });

  await t.test('who may remove whom', async () => {
    const e = await makeEvent(ana);
    await ana.post(`/api/v1/events/${e.id}/cohosts`, { personId: P.fay.id });
    await rsvp(ben, e.id, 'maybe');
    // A co-host can; a guest can't; a host can't be removed.
    assert.equal((await remove(fay, e.id, P.ben.id)).status, 200);
    assert.equal((await remove(fay, e.id, P.ben.id)).status, 200, 'again is fine');
    let r = await remove(ben, e.id, P.cy.id);
    assert.equal(r.status, 403);
    assert.equal(r.data.reason, 'hosts_only');
    r = await remove(ana, e.id, P.fay.id);
    assert.equal(r.status, 409);
    assert.equal(r.data.reason, 'is_host');
    // Ahead of time: someone not on the list yet.
    assert.equal((await remove(ana, e.id, P.eve.id)).status, 200);
    assert.equal((await rsvp(eve, e.id, 'going')).data.reason, 'removed');
    r = await remove(ana, e.id, '00000000-0000-4000-8000-0000000000ff');
    assert.equal(r.status, 404);
    assert.equal(r.data.reason, 'person_not_found');
    assert.equal((await remove(ana, e.id, 'not-an-id')).data.reason, 'bad_person_id');
  });

  await t.test('undoing it leaves them invited, able to answer again', async () => {
    const e = await makeEvent(ana);
    await rsvp(dee, e.id, 'going');
    await remove(ana, e.id, P.dee.id);
    assert.equal((await rsvp(dee, e.id, 'going')).status, 409);
    assert.deepEqual((await restore(ana, e.id, P.dee.id)).data, { ok: true });
    const ev = (await dee.get(`/api/v1/events/${e.id}`)).data.event;
    assert.equal(ev.viewer.rsvp.status, 'invited');
    assert.equal(ev.viewer.rsvp.invited, true);
    assert.ok((await dee.get('/api/v1/me/events/invitations')).data.events.some((x) => x.id === e.id));
    assert.equal((await rsvp(dee, e.id, 'going')).status, 200);
    const r = await restore(ana, e.id, P.dee.id);
    assert.equal(r.status, 404);
    assert.equal(r.data.reason, 'not_removed');
    assert.equal((await restore(dee, e.id, P.dee.id)).data.reason, 'hosts_only');
  });
});

test('making a new link', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const P = server.people;
  const [ana, ben, fay] = ['ana', 'ben', 'fay'].map((n) => client(server, n));
  const anon = client(server, null);
  for (const who of [ana, ben, fay]) await who.get('/api/v1/me');

  await t.test('the old link stops working; everyone keeps their place', async () => {
    const e = await makeEvent(ana, { title: 'Leaked' });
    await ana.post(`/api/v1/events/${e.id}/cohosts`, { personId: P.fay.id });
    await ben.put(`/api/v1/events/${e.id}/rsvp`, { status: 'going' });
    await ben.post(`/api/v1/events/${e.id}/wall`, { text: 'See you there' });
    const png = await sharp({ create: { width: 40, height: 20, channels: 3, background: '#0A3800' } }).png().toBuffer();
    const cover = (await ana.upload('PUT', `/api/v1/events/${e.id}/cover`, png)).data.event.coverImageUrl;

    // A co-host can't; the creator can.
    let r = await fay.post(`/api/v1/events/${e.id}/new-link`);
    assert.equal(r.status, 403);
    assert.equal(r.data.reason, 'creator_only');
    r = await ana.post(`/api/v1/events/${e.id}/new-link`);
    assert.equal(r.status, 200, r.text);
    const fresh = r.data.event;
    assert.match(fresh.id, /^[0-9A-Za-z]{12}$/);
    assert.notEqual(fresh.id, e.id);
    assert.equal(fresh.url, `${server.base}/e/${fresh.id}`);

    // The old link is a 404 like any other, everywhere.
    for (const [who, method, url] of [[anon, 'get', `/api/v1/events/${e.id}`], [ben, 'get', `/api/v1/events/${e.id}`],
      [ben, 'get', `/api/v1/events/${e.id}/guests`], [ben, 'get', `/api/v1/events/${e.id}/wall`], [ana, 'patch', `/api/v1/events/${e.id}`]]) {
      const res = await who[method](url, method === 'patch' ? { title: 'x' } : undefined);
      assert.equal(res.status, 404, `${method} ${url}`);
      assert.equal(res.data.reason, 'event_not_found');
    }
    assert.equal((await ben.put(`/api/v1/events/${e.id}/rsvp`, { status: 'maybe' })).status, 404);

    // Under the new one, everything is where it was.
    const asBen = (await ben.get(`/api/v1/events/${fresh.id}`)).data.event;
    assert.equal(asBen.title, 'Leaked');
    assert.equal(asBen.viewer.rsvp.status, 'going');
    assert.deepEqual(asBen.hosts.map((h) => h.role), ['creator', 'cohost']);
    assert.equal(asBen.coverImageUrl, cover);
    assert.equal((await fetch(cover.replace(/^https?:\/\/[^/]+/, server.base))).status, 200);
    assert.ok((await ben.get(`/api/v1/events/${fresh.id}/wall`)).data.entries.some((w) => w.text === 'See you there'));
    assert.deepEqual((await ben.get('/api/v1/me/events/upcoming')).data.events.map((x) => x.id), [fresh.id]);
    assert.deepEqual((await fay.get('/api/v1/me/events/hosting')).data.events.map((x) => x.id), [fresh.id]);
    // Notifications from before point at it by its new id.
    const n = (await ana.get('/api/v1/me/notifications')).data.notifications.find((x) => x.type === 'rsvp');
    assert.equal(n.event.id, fresh.id);
    assert.equal(n.event.url, fresh.url);

    // Again: the one in between dies too.
    const third = (await ana.post(`/api/v1/events/${fresh.id}/new-link`)).data.event;
    assert.equal((await ben.get(`/api/v1/events/${fresh.id}`)).status, 404);
    assert.equal((await ben.get(`/api/v1/events/${e.id}`)).status, 404);
    assert.equal((await ben.get(`/api/v1/events/${third.id}`)).data.event.viewer.rsvp.status, 'going');
    assert.equal((await ben.post(`/api/v1/events/${third.id}/new-link`)).data.reason, 'creator_only');
  });
});
