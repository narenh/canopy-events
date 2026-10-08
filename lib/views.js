// Rows -> what the API answers with. Every event the API returns, alone or
// in a list, comes from eventViews(), so it reads the same everywhere and
// the rules about who sees what are applied in one place.
//
// What a signed-out caller sees of an event: everything a link preview or
// a "sign in to answer" page needs, and no one's name but the hosts'.
// That's the title, description, times, time zone, place name, the hosts,
// the status and the counts. Not the street address (locationAddress is
// null and locationAddressHidden is true), and never the guest list.
// Link previews are fetched by machines (Slack, iMessage, crawlers), which
// keep what they fetch, and a home address shouldn't end up in one of
// their caches. Anyone who signs in, even with a quick account, sees it.

const { personFrom, loadPeople } = require('./people');
const { isHost, canSeeGuestNames, canPost, canDeleteWallEntry } = require('./rules');
const { publicBase } = require('./domain');

// At most this many friends' names on an event; the count says how many
// there are in all.
const FRIENDS_GOING_SHOWN = 12;

function iso(ms) {
  return ms == null ? null : new Date(ms).toISOString();
}

// The viewer's own answer: what they said, or that they're invited and
// haven't said.
//
// guestsOverLimit: the host lowered guestsAllowed below the plus-ones this
// answer already brings. The answer is kept as it was (nobody's plus-one
// is dropped behind their back); the next change to it has to fit.
function rsvpView(rsvp, event) {
  if (!rsvp) return null;
  return {
    status: rsvp.status,
    guests: rsvp.guests,
    guestsOverLimit: rsvp.guests > event.guestsAllowed,
    invited: !!rsvp.invitedBy,
    respondedAt: iso(rsvp.respondedAt)
  };
}

// One person on the guest list, of `event`.
function guestView(rsvp, people, event) {
  return {
    person: personFrom(people, rsvp.personId),
    status: rsvp.status,
    guests: rsvp.guests,
    guestsOverLimit: rsvp.guests > event.guestsAllowed,
    respondedAt: iso(rsvp.respondedAt)
  };
}

// `events` are store records, as req.person (the signed-in caller, or
// null) sees them. `ctx` is { store, canopy }. With `friendsGoing` (one
// event on its own), each view also says which of the caller's friends
// are going.
async function eventViews(ctx, req, events, { friendsGoing = false } = {}) {
  const { store, canopy } = ctx;
  const person = req.person || null;
  const base = publicBase(req);
  const ids = events.map((e) => e.id);
  const hosts = store.hostsOf(ids);
  const counts = store.countsFor(ids);
  const mine = person ? store.rsvpsFor(ids, person.id) : new Map();

  const friends = new Map();
  if (friendsGoing && person) {
    events.forEach((e) => friends.set(e.id, store.friendsGoingTo(e.id, person.id)));
  }

  const wanted = [];
  hosts.forEach((list) => list.forEach((h) => wanted.push(h.personId)));
  friends.forEach((list) => wanted.push(...list.slice(0, FRIENDS_GOING_SHOWN)));
  const people = await loadPeople(canopy, wanted);

  return events.map((e) => {
    const eventHosts = hosts.get(e.id);
    const role = person ? (eventHosts.find((h) => h.personId === person.id) || {}).role || null : null;
    const rsvp = mine.get(e.id) || null;
    const seesNames = canSeeGuestNames(e, { person, role, rsvp });
    const view = {
      id: e.id,
      url: `${base}/e/${e.id}`,
      title: e.title,
      description: e.description,
      startsAt: iso(e.startsAt),
      endsAt: iso(e.endsAt),
      timeZone: e.timeZone,
      locationName: e.locationName,
      locationAddress: person ? e.locationAddress : null,
      locationAddressHidden: !person && !!e.locationAddress,
      guestListVisibility: e.guestListVisibility,
      guestsAllowed: e.guestsAllowed,
      capacity: e.capacity,
      // People-plus-plus-ones still to go before the cap (0 when full, and
      // past it after the host lowered the capacity); null with no cap.
      spotsLeft: e.capacity == null ? null : Math.max(0, e.capacity - counts.get(e.id).total.going),
      // Public, for link previews (lib/coverStore.js).
      coverImageUrl: e.coverKey ? `${base}/covers/${e.coverKey}.jpg?v=${e.coverImageAt}` : null,
      status: e.status,
      cancelledAt: iso(e.cancelledAt),
      createdAt: iso(e.createdAt),
      updatedAt: iso(e.updatedAt),
      hosts: eventHosts.map((h) => ({ person: personFrom(people, h.personId), role: h.role })),
      counts: counts.get(e.id),
      viewer: person
        ? { role, rsvp: rsvpView(rsvp, e), canEdit: isHost(role), canSeeGuestList: seesNames, canPost: canPost(role, rsvp) }
        : null
    };
    if (friendsGoing && person) {
      const going = friends.get(e.id);
      view.friendsGoing = {
        count: going.length,
        // Names only for someone who may see the guest list's names;
        // otherwise the count alone, like the rest of the list.
        people: seesNames ? going.slice(0, FRIENDS_GOING_SHOWN).map((id) => personFrom(people, id)) : []
      };
    }
    return view;
  });
}

// One entry on the activity wall (lib/store/wall.js has the types), as
// `viewer` ({ person, role }) sees it. `person` is the author of a post,
// or who the entry is about; `details` holds the server's entries'
// structured fields, with times as ISO strings like everywhere else.
function wallEntryView(entry, people, viewer) {
  let details = null;
  if (entry.type === 'time_changed') {
    details = { startsAt: iso(entry.details.startsAt), endsAt: iso(entry.details.endsAt), timeZone: entry.details.timeZone };
  } else if (entry.type === 'place_changed') {
    details = { locationName: entry.details.locationName, locationAddress: entry.details.locationAddress };
  }
  return {
    id: String(entry.id),
    type: entry.type,
    createdAt: iso(entry.createdAt),
    person: entry.personId ? personFrom(people, entry.personId) : null,
    text: entry.type === 'post' ? entry.body : null,
    details,
    canDelete: canDeleteWallEntry(entry, viewer)
  };
}

// An event as a notification mentions it: enough to show the line and
// open the event.
function eventSummary(e, base) {
  return {
    id: e.publicId || e.id,
    url: `${base}/e/${e.publicId || e.id}`,
    title: e.title,
    startsAt: iso(e.startsAt),
    timeZone: e.timeZone,
    status: e.status,
    coverImageUrl: e.coverKey ? `${base}/covers/${e.coverKey}.jpg?v=${e.coverImageAt}` : null
  };
}

// The caller's notifications (lib/store/notifications.js has the types),
// with who did each and which event, in one call to the account service.
async function notificationViews(ctx, req, rows) {
  const base = publicBase(req);
  const people = await loadPeople(ctx.canopy, rows.map((n) => n.actorId));
  const events = new Map();
  rows.forEach((n) => {
    if (n.eventId && !events.has(n.eventId)) events.set(n.eventId, ctx.store.getEvent(n.eventId));
  });
  return rows.map((n) => {
    const e = n.eventId ? events.get(n.eventId) : null;
    return {
      id: String(n.id),
      type: n.type,
      // When it (or the latest of the ones folded into it) happened.
      createdAt: iso(n.updatedAt),
      read: n.readAt != null,
      actor: n.actorId ? personFrom(people, n.actorId) : null,
      event: e ? eventSummary(e, base) : null,
      details: n.details,
      count: n.count
    };
  });
}

async function eventView(ctx, req, event, opts) {
  return (await eventViews(ctx, req, [event], opts))[0];
}

module.exports = { eventViews, eventView, guestView, rsvpView, wallEntryView, notificationViews, iso, FRIENDS_GOING_SHOWN };
