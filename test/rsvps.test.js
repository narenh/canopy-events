// Answers, invitations and the guest list, end to end: the RSVP state
// machine, what's refused (hosts, cancelled and finished events), the
// visibility rule both ways, pagination, and former members.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, makeEvent, counts } = require('./harness');

test('answers, invitations and the guest list', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const P = server.people;
  const [ana, ben, cy, dee, eve, fay, una, gus] = ['ana', 'ben', 'cy', 'dee', 'eve', 'fay', 'una', 'gus'].map((n) => client(server, n));
  const anon = client(server, null);
  const rsvp = (who, id, status, extra) => who.put(`/api/v1/events/${id}/rsvp`, { status, ...extra });
  const guestIds = (r) => r.data.guests.map((g) => g.person.id);

  await t.test("answering and changing it; an answer can't be taken back", async () => {
    const e = await makeEvent(ana);
    let r = await rsvp(ben, e.id, 'going');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.event.viewer.rsvp.status, 'going');
    assert.equal(r.data.event.viewer.rsvp.invited, false);
    assert.equal(r.data.event.viewer.rsvp.guests, 0);
    assert.equal(r.data.event.counts.going, 1);
    r = await rsvp(ben, e.id, 'maybe');
    assert.deepEqual(r.data.event.counts, counts({ maybe: 1, invited: null }), 'how many are invited is for hosts');
    r = await rsvp(ben, e.id, 'not_going');
    assert.equal(r.data.event.counts.notGoing, 1);
    // Unverified people answer too.
    assert.equal((await rsvp(una, e.id, 'going')).status, 200);
    // There's no taking it back: the route is gone, like any unknown one
    // (JSON with a reason), for an answer and for none alike.
    for (const who of [ben, cy]) {
      r = await who.del(`/api/v1/events/${e.id}/rsvp`);
      assert.equal(r.status, 404, r.text);
      assert.equal(r.data.reason, 'not_found');
    }
    // Nor any other way back to no answer: "invited" isn't an answer, and
    // a host inviting him now changes nothing about it.
    assert.equal((await rsvp(ben, e.id, 'invited')).data.reason, 'bad_status');
    const invited = await ana.post(`/api/v1/events/${e.id}/invites`, { personIds: [P.ben.id] });
    assert.deepEqual(invited.data.skipped, [{ personId: P.ben.id, reason: 'already_on_list' }]);
    assert.equal((await ana.del(`/api/v1/events/${e.id}/invites/${P.ben.id}`)).data.reason, 'already_responded');
    r = await ben.get(`/api/v1/events/${e.id}`);
    assert.equal(r.data.event.viewer.rsvp.status, 'not_going');
    assert.equal(r.data.event.counts.notGoing, 1);
    assert.equal((await ben.get('/api/v1/me/events/invitations')).data.events.some((x) => x.id === e.id), false);
    // He can still change it, to any answer.
    assert.equal((await rsvp(ben, e.id, 'going')).data.event.viewer.rsvp.status, 'going');
  });

  await t.test('what an answer has to be', async () => {
    const e = await makeEvent(ana);
    for (const body of [{ status: 'invited' }, { status: 'waitlisted' }, { status: 'yes' }, {}]) {
      const r = await ben.put(`/api/v1/events/${e.id}/rsvp`, body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.data.reason, 'bad_status');
    }
    assert.equal((await rsvp(ben, e.id, 'going', { guests: -1 })).data.reason, 'bad_guests');
    assert.equal((await rsvp(ben, e.id, 'going', { guests: 1.5 })).data.reason, 'bad_guests');
    // Plus-ones are 0 until the host allows more.
    assert.equal((await rsvp(ben, e.id, 'going', { guests: 1 })).data.reason, 'too_many_guests');
    assert.equal((await rsvp(ben, e.id, 'going', { guests: 0 })).status, 200);
    assert.equal((await rsvp(anon, e.id, 'going')).status, 401);
  });

  await t.test('hosts do not answer their own event', async () => {
    const e = await makeEvent(ana);
    const r = await rsvp(ana, e.id, 'going');
    assert.equal(r.status, 409);
    assert.equal(r.data.reason, 'host_cannot_rsvp');
  });

  await t.test('a cancelled event takes no answers, and neither does one that is over', async () => {
    const e = await makeEvent(ana);
    await rsvp(ben, e.id, 'going');
    await ana.patch(`/api/v1/events/${e.id}`, { status: 'cancelled' });
    let r = await rsvp(cy, e.id, 'going');
    assert.equal(r.status, 409);
    assert.equal(r.data.reason, 'event_cancelled');
    assert.equal((await rsvp(ben, e.id, 'maybe')).data.reason, 'event_cancelled', 'no changing it either');
    assert.equal((await ana.post(`/api/v1/events/${e.id}/invites`, { personIds: [P.cy.id] })).data.reason, 'event_cancelled');

    const old = await makeEvent(ana);
    server.setTimes(old.id, { startedAgoMs: 10 * 3600e3, overInMs: -3600e3 });
    r = await rsvp(cy, old.id, 'going');
    assert.equal(r.status, 409);
    assert.equal(r.data.reason, 'event_over');
    // Started but not over yet: still open.
    const now = await makeEvent(ana);
    server.setTimes(now.id, { startedAgoMs: 3600e3, overInMs: 3600e3 });
    assert.equal((await rsvp(cy, now.id, 'going')).status, 200);
  });

  await t.test('invitations: a host invites by person id', async () => {
    const e = await makeEvent(ana, { title: 'Invite only-ish' });
    const unknown = '00000000-0000-4000-8000-0000000000ff';
    const r = await ana.post(`/api/v1/events/${e.id}/invites`, { personIds: [P.ben.id, P.una.id, P.ben.id, unknown, P.ana.id] });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.data.invited.map((p) => p.id).sort(), [P.ben.id, P.una.id].sort());
    assert.deepEqual(r.data.skipped.sort((a, b) => a.personId.localeCompare(b.personId)), [
      { personId: P.ana.id, reason: 'is_host' },
      { personId: unknown, reason: 'not_found' }
    ]);
    // Again: already on the list.
    const again = await ana.post(`/api/v1/events/${e.id}/invites`, { personIds: [P.ben.id] });
    assert.deepEqual(again.data, { invited: [], skipped: [{ personId: P.ben.id, reason: 'already_on_list' }] });
    assert.equal((await ana.get(`/api/v1/events/${e.id}`)).data.event.counts.invited, 2);

    // It's in Ben's invitations, as invited with no answer.
    const mine = await ben.get('/api/v1/me/events/invitations');
    assert.deepEqual(mine.data.events.map((x) => x.id), [e.id]);
    assert.deepEqual(mine.data.events[0].viewer.rsvp, { status: 'invited', guests: 0, guestsOverLimit: false, invited: true, respondedAt: null });

    // He answers: out of invitations, into upcoming.
    await rsvp(ben, e.id, 'maybe');
    assert.equal((await ben.get('/api/v1/me/events/invitations')).data.events.length, 0);
    assert.ok((await ben.get('/api/v1/me/events/upcoming')).data.events.some((x) => x.id === e.id));
    // There's no going back to invited: the answer stays an answer.
    assert.equal((await ben.del(`/api/v1/events/${e.id}/rsvp`)).status, 404);
    assert.equal((await ben.get(`/api/v1/events/${e.id}`)).data.event.viewer.rsvp.status, 'maybe');
    assert.equal((await ben.get('/api/v1/me/events/invitations')).data.events.length, 0);

    // Uninviting: only while there's no answer.
    await rsvp(ben, e.id, 'going');
    const kept = await ana.del(`/api/v1/events/${e.id}/invites/${P.ben.id}`);
    assert.equal(kept.status, 409);
    assert.equal(kept.data.reason, 'already_responded');
    assert.deepEqual((await ana.del(`/api/v1/events/${e.id}/invites/${P.una.id}`)).data, { ok: true });
    assert.equal((await una.get(`/api/v1/events/${e.id}`)).data.event.viewer.rsvp, null);
    assert.equal((await ana.del(`/api/v1/events/${e.id}/invites/${P.una.id}`)).data.reason, 'not_invited');

    // Someone who answered first and is invited after keeps the answer,
    // and is invited as well.
    await rsvp(cy, e.id, 'going');
    await ana.post(`/api/v1/events/${e.id}/invites`, { personIds: [P.cy.id] });
    const cys = (await cy.get(`/api/v1/events/${e.id}`)).data.event.viewer.rsvp;
    assert.deepEqual([cys.status, cys.invited], ['going', true]);
  });

  await t.test('invitations: only hosts, and only lists of person ids', async () => {
    const e = await makeEvent(ana);
    const no = await ben.post(`/api/v1/events/${e.id}/invites`, { personIds: [P.cy.id] });
    assert.equal(no.status, 403);
    assert.equal(no.data.reason, 'hosts_only');
    assert.equal((await ben.del(`/api/v1/events/${e.id}/invites/${P.cy.id}`)).data.reason, 'hosts_only');
    for (const body of [{}, { personIds: [] }, { personIds: 'x' }, { personIds: ['not-an-id'] }, { personIds: [1] },
      { personIds: Array.from({ length: 101 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`) }]) {
      const r = await ana.post(`/api/v1/events/${e.id}/invites`, body);
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
      assert.equal(r.data.reason, 'bad_person_ids');
    }
  });

  await t.test("guest list, 'everyone': names for anyone signed in, counts for everyone", async () => {
    const e = await makeEvent(ana, { guestListVisibility: 'everyone' });
    await rsvp(ben, e.id, 'going');
    await rsvp(cy, e.id, 'maybe');
    await rsvp(dee, e.id, 'not_going');
    await ana.post(`/api/v1/events/${e.id}/invites`, { personIds: [P.eve.id] });

    const asEve = await eve.get(`/api/v1/events/${e.id}/guests`);
    assert.equal(asEve.data.guestsVisible, true);
    assert.deepEqual(guestIds(asEve), [P.ben.id, P.cy.id, P.dee.id], 'answers in order, no one only invited');
    // How many are invited (and haven't answered) is the hosts' alone, like
    // who: null for a guest, an invitee, a stranger or someone signed out.
    assert.deepEqual(asEve.data.counts, counts({ going: 1, maybe: 1, notGoing: 1, invited: null }));
    assert.deepEqual((await ana.get(`/api/v1/events/${e.id}/guests`)).data.counts, counts({ going: 1, maybe: 1, notGoing: 1, invited: 1 }));
    assert.equal((await ana.get(`/api/v1/events/${e.id}`)).data.event.counts.invited, 1);
    for (const who of [ben, eve, fay, anon]) {
      assert.equal((await who.get(`/api/v1/events/${e.id}`)).data.event.counts.invited, null, who.person ? who.person.name : 'signed out');
    }
    assert.equal((await eve.get('/api/v1/me/events/invitations')).data.events.find((x) => x.id === e.id).counts.invited, null);
    assert.equal((await ana.get('/api/v1/me/events/hosting')).data.events.find((x) => x.id === e.id).counts.invited, 1);
    // Someone with no connection to it at all, too.
    assert.equal((await fay.get(`/api/v1/events/${e.id}/guests`)).data.guests.length, 3);
    // Hosts see who's invited as well.
    assert.deepEqual(guestIds(await ana.get(`/api/v1/events/${e.id}/guests`)), [P.ben.id, P.cy.id, P.dee.id, P.eve.id]);
    assert.deepEqual(guestIds(await ana.get(`/api/v1/events/${e.id}/guests?status=invited`)), [P.eve.id]);
    const notHost = await fay.get(`/api/v1/events/${e.id}/guests?status=invited`);
    assert.equal(notHost.status, 403);
    assert.equal(notHost.data.reason, 'hosts_only');
    assert.deepEqual(guestIds(await fay.get(`/api/v1/events/${e.id}/guests?status=going`)), [P.ben.id]);
    assert.equal((await fay.get(`/api/v1/events/${e.id}/guests?status=everyone`)).data.reason, 'bad_status');
    // Signed out: no list at all (the event itself has the counts).
    const out = await anon.get(`/api/v1/events/${e.id}/guests`);
    assert.equal(out.status, 401);
    assert.equal(out.data.reason, 'sign_in_required');
  });

  await t.test("guest list, 'responded': counts only until you've answered", async () => {
    const e = await makeEvent(ana, { guestListVisibility: 'responded' });
    await rsvp(ben, e.id, 'going');
    await ana.post(`/api/v1/events/${e.id}/invites`, { personIds: [P.cy.id] });

    const before = await fay.get(`/api/v1/events/${e.id}/guests`);
    assert.deepEqual(before.data, {
      guestsVisible: false, guests: [], counts: counts({ going: 1, invited: null }), nextCursor: null
    });
    assert.equal((await fay.get(`/api/v1/events/${e.id}`)).data.event.viewer.canSeeGuestList, false);
    // An invitation alone isn't an answer.
    assert.equal((await cy.get(`/api/v1/events/${e.id}/guests`)).data.guestsVisible, false);
    // Any answer is, even "can't go".
    await rsvp(fay, e.id, 'not_going');
    const after = await fay.get(`/api/v1/events/${e.id}/guests`);
    assert.equal(after.data.guestsVisible, true);
    assert.deepEqual(guestIds(after), [P.ben.id, P.fay.id]);
    // Hosts always.
    assert.equal((await ana.get(`/api/v1/events/${e.id}/guests`)).data.guests.length, 3);
    // And it stays an answer: changing it keeps the names, and there's no
    // taking it back to lose them.
    await rsvp(fay, e.id, 'maybe');
    assert.equal((await fay.del(`/api/v1/events/${e.id}/rsvp`)).status, 404);
    assert.equal((await fay.get(`/api/v1/events/${e.id}/guests`)).data.guestsVisible, true);
  });

  await t.test('the guest list, a page at a time', async () => {
    const e = await makeEvent(ana);
    const order = [ben, cy, dee, eve, fay, una];
    for (const who of order) await rsvp(who, e.id, 'going');
    const seen = [];
    let cursor = '';
    let pages = 0;
    do {
      const r = await ben.get(`/api/v1/events/${e.id}/guests?limit=4&cursor=${encodeURIComponent(cursor)}`);
      assert.equal(r.status, 200, r.text);
      assert.ok(r.data.guests.length <= 4);
      seen.push(...guestIds(r));
      cursor = r.data.nextCursor;
      pages++;
    } while (cursor);
    assert.equal(pages, 2);
    assert.deepEqual(seen, order.map((c) => c.person.id));
    assert.equal((await ben.get(`/api/v1/events/${e.id}/guests?cursor=garbage`)).data.reason, 'bad_cursor');
    assert.equal((await ben.get(`/api/v1/events/${e.id}/guests?limit=0`)).data.reason, 'bad_limit');
    assert.equal((await ben.get(`/api/v1/events/${e.id}/guests?limit=101`)).data.reason, 'bad_limit');
  });

  await t.test('someone deleted from Canopy shows as a former member', async () => {
    const e = await makeEvent(ana);
    await rsvp(gus, e.id, 'going');
    server.fake.deleted.add(P.gus.id);
    try {
      const r = await ben.get(`/api/v1/events/${e.id}/guests`);
      assert.deepEqual(r.data.guests[0].person, {
        id: P.gus.id, firstName: 'Former member', lastName: '', shortName: 'Former member', photoUrl: null
      });
      assert.equal(r.data.counts.going, 1, 'their answer still counts');
    } finally {
      server.fake.deleted.delete(P.gus.id);
    }
  });
});
