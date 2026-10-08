// Co-hosts and plus-ones. Co-hosts: verified only (as far as events has
// seen), added and taken off by the creator alone, able to edit and
// invite but not cancel, and what happens to an answer they had. Plus-
// ones: the host's guestsAllowed, answers that bring guests, the counts,
// and lowering the allowance under answers that already bring more.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, makeEvent, counts } = require('./harness');

test('co-hosts', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const P = server.people;
  const [ana, ben, cy, dee, eve, una] = ['ana', 'ben', 'cy', 'dee', 'eve', 'una'].map((n) => client(server, n));
  const anon = client(server, null);
  const add = (who, id, personId) => who.post(`/api/v1/events/${id}/cohosts`, { personId });
  const drop = (who, id, personId) => who.del(`/api/v1/events/${id}/cohosts/${personId}`);
  const hostIds = (e) => e.hosts.map((h) => [h.person.id, h.role]);

  // Everyone opens events once, so it has seen who's verified.
  for (const who of [ana, ben, cy, dee, eve, una]) await who.get('/api/v1/me');

  await t.test('the creator adds a verified co-host, who can then edit and invite', async () => {
    const e = await makeEvent(ana);
    const r = await add(ana, e.id, P.ben.id);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(hostIds(r.data.event), [[P.ana.id, 'creator'], [P.ben.id, 'cohost']]);
    const asBen = (await ben.get(`/api/v1/events/${e.id}`)).data.event;
    assert.equal(asBen.viewer.role, 'cohost');
    assert.equal(asBen.viewer.canEdit, true);
    assert.equal(asBen.viewer.canSeeGuestList, true);
    // Edits.
    const edit = await ben.patch(`/api/v1/events/${e.id}`, { title: 'Ben moved it', guestsAllowed: 2 });
    assert.equal(edit.status, 200, edit.text);
    assert.equal(edit.data.event.title, 'Ben moved it');
    // Invites, and sees who's invited.
    assert.equal((await ben.post(`/api/v1/events/${e.id}/invites`, { personIds: [P.cy.id] })).data.invited.length, 1);
    assert.equal((await ben.get(`/api/v1/events/${e.id}/guests?status=invited`)).data.guests.length, 1);
    // Doesn't answer their own event.
    assert.equal((await ben.put(`/api/v1/events/${e.id}/rsvp`, { status: 'going' })).data.reason, 'host_cannot_rsvp');
    // It's in their hosting list.
    assert.ok((await ben.get('/api/v1/me/events/hosting')).data.events.some((x) => x.id === e.id));
    // Adding them again changes nothing.
    assert.deepEqual(hostIds((await add(ana, e.id, P.ben.id)).data.event), [[P.ana.id, 'creator'], [P.ben.id, 'cohost']]);
  });

  await t.test('only the creator cancels, or manages co-hosts', async () => {
    const e = await makeEvent(ana);
    await add(ana, e.id, P.ben.id);
    let r = await ben.patch(`/api/v1/events/${e.id}`, { status: 'cancelled' });
    assert.equal(r.status, 403);
    assert.equal(r.data.reason, 'creator_only');
    // Sending the status it already has isn't a change.
    assert.equal((await ben.patch(`/api/v1/events/${e.id}`, { status: 'active' })).status, 200);
    r = await add(ben, e.id, P.cy.id);
    assert.equal(r.status, 403);
    assert.equal(r.data.reason, 'creator_only');
    assert.equal((await add(cy, e.id, P.dee.id)).data.reason, 'creator_only');
    await add(ana, e.id, P.cy.id);
    assert.equal((await drop(ben, e.id, P.cy.id)).data.reason, 'creator_only');
    assert.equal((await add(anon, e.id, P.cy.id)).status, 401);
    // The creator can cancel.
    assert.equal((await ana.patch(`/api/v1/events/${e.id}`, { status: 'cancelled' })).data.event.status, 'cancelled');
  });

  await t.test('co-hosts are verified: an unverified or never-seen person is refused, without a verify link', async () => {
    const e = await makeEvent(ana);
    let r = await add(ana, e.id, P.una.id);
    assert.equal(r.status, 403);
    assert.equal(r.data.reason, 'email_unverified');
    assert.equal(r.data.verify, undefined, "the link is for the caller's own email, and this isn't about that");
    assert.match(r.data.error, /verified email/);
    // Fay is verified but has never opened events.
    const fay = client(server, 'fay');
    r = await add(ana, e.id, P.fay.id);
    assert.equal(r.data.reason, 'email_unverified');
    // Once she has, she can be.
    await fay.get(`/api/v1/events/${e.id}`);
    assert.equal((await add(ana, e.id, P.fay.id)).status, 200);
    // Someone the account service doesn't have, a malformed id, yourself.
    assert.equal((await add(ana, e.id, '00000000-0000-4000-8000-0000000000ff')).data.reason, 'person_not_found');
    assert.equal((await add(ana, e.id, 'nope')).data.reason, 'bad_person_id');
    assert.equal((await add(ana, e.id, P.ana.id)).data.reason, 'is_creator');
  });

  await t.test('becoming a co-host replaces your answer; stepping down leaves you invited', async () => {
    const e = await makeEvent(ana, { guestsAllowed: 2 });
    await cy.put(`/api/v1/events/${e.id}/rsvp`, { status: 'going', guests: 2 });
    assert.deepEqual((await ana.get(`/api/v1/events/${e.id}`)).data.event.counts, counts({ going: 1 }, { going: 2 }));
    await add(ana, e.id, P.cy.id);
    let ev = (await cy.get(`/api/v1/events/${e.id}`)).data.event;
    assert.deepEqual(ev.counts, counts(), 'hosts are not counted, plus-ones went with the answer');
    assert.equal(ev.viewer.rsvp, null);
    // Cy steps down: invited, by Ana.
    const r = await drop(cy, e.id, P.cy.id);
    assert.equal(r.status, 200, r.text);
    ev = r.data.event;
    assert.equal(ev.viewer.role, null);
    assert.deepEqual(ev.viewer.rsvp, { status: 'invited', guests: 0, guestsOverLimit: false, invited: true, respondedAt: null });
    assert.ok((await cy.get('/api/v1/me/events/invitations')).data.events.some((x) => x.id === e.id));
    // The creator takes one off the same way; twice is a 404.
    await add(ana, e.id, P.dee.id);
    assert.equal((await drop(ana, e.id, P.dee.id)).data.event.hosts.length, 1);
    const again = await drop(ana, e.id, P.dee.id);
    assert.equal(again.status, 404);
    assert.equal(again.data.reason, 'not_cohost');
    // The creator isn't a co-host to take off.
    assert.equal((await drop(ana, e.id, P.ana.id)).data.reason, 'not_cohost');
  });

  await t.test('at most 10 co-hosts, and none on a cancelled event', async () => {
    const e = await makeEvent(ana);
    // Ten more verified people, each seen by events once.
    for (let i = 0; i < 10; i++) {
      const p = server.fake.addPerson(100 + i, `extra${i}`, `Extra${i}`, 'Person');
      await client(server, p.name).get('/api/v1/me');
      assert.equal((await add(ana, e.id, p.id)).status, 200);
    }
    const r = await add(ana, e.id, P.ben.id);
    assert.equal(r.status, 409);
    assert.equal(r.data.reason, 'too_many_cohosts');
    const off = await makeEvent(ana);
    await ana.patch(`/api/v1/events/${off.id}`, { status: 'cancelled' });
    assert.equal((await add(ana, off.id, P.ben.id)).data.reason, 'event_cancelled');
  });

  await t.test('co-hosts are friends with the people at the event, like any host', async () => {
    const e = await makeEvent(ana);
    await add(ana, e.id, P.eve.id);
    await dee.put(`/api/v1/events/${e.id}/rsvp`, { status: 'going' });
    server.setTimes(e.id, { startedAgoMs: 3600e3, overInMs: 3600e3 });
    assert.ok((await eve.get('/api/v1/me/friends')).data.friends.some((f) => f.person.id === P.dee.id));
  });
});

test('plus-ones', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const [ana, ben, cy, dee] = ['ana', 'ben', 'cy', 'dee'].map((n) => client(server, n));
  const rsvp = (who, id, status, guests) => who.put(`/api/v1/events/${id}/rsvp`, guests === undefined ? { status } : { status, guests });

  await t.test('the host sets guestsAllowed, 0 to 10', async () => {
    const e = await makeEvent(ana, { guestsAllowed: 3 });
    assert.equal(e.guestsAllowed, 3);
    for (const bad of [-1, 11, 1.5, '2', null]) {
      const r = await ana.patch(`/api/v1/events/${e.id}`, { guestsAllowed: bad });
      assert.equal(r.status, 400, String(bad));
      assert.equal(r.data.reason, 'bad_guests_allowed');
    }
    assert.equal((await ana.post('/api/v1/events', { title: 'x', startsAt: '2030-01-01T20:00:00Z', timeZone: 'UTC', guestsAllowed: 11 })).data.reason, 'bad_guests_allowed');
    assert.equal((await ana.patch(`/api/v1/events/${e.id}`, { guestsAllowed: 10 })).data.event.guestsAllowed, 10);
  });

  await t.test('answers bring guests up to the allowance; counts give people, guests and the total', async () => {
    const e = await makeEvent(ana, { guestsAllowed: 2 });
    let r = await rsvp(ben, e.id, 'going', 2);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.event.viewer.rsvp.guests, 2);
    assert.equal((await rsvp(cy, e.id, 'going', 3)).data.reason, 'too_many_guests');
    await rsvp(cy, e.id, 'maybe', 1);
    await rsvp(dee, e.id, 'not_going', 2);
    r = await ana.get(`/api/v1/events/${e.id}`);
    assert.deepEqual(r.data.event.counts, counts({ going: 1, maybe: 1, notGoing: 1 }, { going: 2, maybe: 1 }));
    assert.equal(r.data.event.counts.total.going, 3);
    // Not going brings nobody.
    const list = (await ana.get(`/api/v1/events/${e.id}/guests`)).data.guests;
    assert.deepEqual(list.map((g) => [g.person.firstName, g.status, g.guests]), [['Ben', 'going', 2], ['Cy', 'maybe', 1], ['Dee', 'not_going', 0]]);
    // Changing the answer without guests brings none.
    assert.equal((await rsvp(ben, e.id, 'maybe')).data.event.viewer.rsvp.guests, 0);
  });

  await t.test('lowering guestsAllowed keeps existing answers, flagged; the next change has to fit', async () => {
    const e = await makeEvent(ana, { guestsAllowed: 3 });
    await rsvp(ben, e.id, 'going', 3);
    await rsvp(cy, e.id, 'going', 1);
    const r = await ana.patch(`/api/v1/events/${e.id}`, { guestsAllowed: 1 });
    assert.equal(r.data.event.guestsAllowed, 1);
    assert.equal(r.data.event.counts.guests.going, 4, 'nobody was changed');
    const guests = (await ana.get(`/api/v1/events/${e.id}/guests`)).data.guests;
    assert.deepEqual(guests.map((g) => [g.person.firstName, g.guests, g.guestsOverLimit]), [['Ben', 3, true], ['Cy', 1, false]]);
    const mine = (await ben.get(`/api/v1/events/${e.id}`)).data.event.viewer.rsvp;
    assert.equal(mine.guestsOverLimit, true);
    // Ben re-sending the same is a change, and has to fit now.
    assert.equal((await rsvp(ben, e.id, 'going', 3)).data.reason, 'too_many_guests');
    const fixed = await rsvp(ben, e.id, 'going', 1);
    assert.equal(fixed.data.event.viewer.rsvp.guestsOverLimit, false);
  });
});
