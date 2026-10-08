// Drawing the pages' content, from the API's own answers, as HTML. The
// same file runs in two places:
//
//   - on the server (lib/render.js), which draws each page before sending
//     it, so it's there at once on a phone, a link preview has something
//     to read, and the page works before (or without) its script;
//   - in the browser, which draws the same parts again after a change
//     (an answer, a "show more"), from what the API answered.
//
// One set of drawing code, so the two can't drift apart. Everything here
// is a plain function from data to a string. Every value that came from a
// person (titles, names, descriptions) goes through esc(), and every
// sentence comes from copy.js through tx(), escaped the same way.
//
// Times are always shown in the event's own time zone: 7:30 PM means the
// host's 7:30 PM. When that zone isn't the viewer's, the page says so.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./copy.js').t);
  else root.UI = factory(t); // eslint-disable-line no-undef -- copy.js's t, inlined before this
})(typeof self !== 'undefined' ? self : this, function (t) {
  'use strict';

  const LOCALE = 'en-US';
  // An event with no end time counts as over this long after it starts.
  // The same number as lib/rules.js's ASSUMED_LENGTH_MS (a test holds
  // them together); the API doesn't send when an event is over.
  const ASSUMED_LENGTH_MS = 6 * 60 * 60 * 1000;

  // ---------------- Escaping ----------------

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // A sentence from copy.js, ready for HTML.
  function tx(path, vars) {
    return esc(t(path, vars));
  }

  // Only http(s) links make it into an href or src.
  function safeUrl(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
  }

  // ---------------- Times ----------------

  // Intl in newer engines puts a narrow no-break space before AM/PM; a
  // plain space reads the same and keeps server and browser identical.
  function fmt(ms, zone, opts) {
    return new Intl.DateTimeFormat(LOCALE, Object.assign({ timeZone: zone }, opts))
      .format(new Date(ms))
      .replace(/[\u202f\u2009\u00a0]/g, ' ');
  }

  function dayKey(ms, zone) {
    return fmt(ms, zone, { year: 'numeric', month: '2-digit', day: '2-digit' });
  }

  function timeOf(ms, zone) {
    return fmt(ms, zone, { hour: 'numeric', minute: '2-digit' });
  }

  // "PDT", "GMT+1": the zone's short name at that moment.
  function zoneAbbr(ms, zone) {
    const part = new Intl.DateTimeFormat(LOCALE, { timeZone: zone, timeZoneName: 'short' })
      .formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName');
    return part ? part.value : zone;
  }

  // "America/Los_Angeles" -> "Los Angeles".
  function zoneCity(zone) {
    return String(zone).split('/').pop().replace(/_/g, ' ');
  }

  // Whether a viewer in `viewerZone` reads the event's times the same:
  // the same wall clock at that moment. Two zones with the same offset
  // that day (Phoenix and Los Angeles in summer) need no label. With no
  // viewer zone known (the server, on a first visit), always label.
  function sameClock(ms, zone, viewerZone) {
    if (!viewerZone) return false;
    if (viewerZone === zone) return true;
    try {
      const opts = { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' };
      return fmt(ms, zone, opts) === fmt(ms, viewerZone, opts);
    } catch (e) {
      return false;
    }
  }

  function startMs(e) { return Date.parse(e.startsAt); }
  function endMs(e) { return e.endsAt ? Date.parse(e.endsAt) : null; }

  // When, for the event page: { date, time, zoneNote }. zoneNote is null
  // when the viewer's clock reads the same.
  function when(e, viewerZone) {
    const z = e.timeZone;
    const s = startMs(e);
    const end = endMs(e);
    const thisYear = fmt(Date.now(), z, { year: 'numeric' });
    const showYear = fmt(s, z, { year: 'numeric' }) !== thisYear;
    const date = fmt(s, z, { weekday: 'long', month: 'long', day: 'numeric', year: showYear ? 'numeric' : undefined });
    let time = timeOf(s, z);
    if (end != null) {
      time += ' – ' + (dayKey(end, z) === dayKey(s, z)
        ? timeOf(end, z)
        : fmt(end, z, { weekday: 'short', month: 'short', day: 'numeric' }) + ', ' + timeOf(end, z));
    }
    const zoneNote = sameClock(s, z, viewerZone) ? null : t('event.zone', { city: zoneCity(z), zone: zoneAbbr(s, z) });
    return { date, time, zoneNote };
  }

  // When, in one short line for a list: "Sat, Oct 31 · 7:30 PM", with the
  // zone's short name when it isn't the viewer's.
  function whenShort(e, viewerZone) {
    const z = e.timeZone;
    const s = startMs(e);
    const thisYear = fmt(Date.now(), z, { year: 'numeric' });
    const showYear = fmt(s, z, { year: 'numeric' }) !== thisYear;
    let line = fmt(s, z, { weekday: 'short', month: 'short', day: 'numeric', year: showYear ? 'numeric' : undefined }) + ' · ' + timeOf(s, z);
    if (!sameClock(s, z, viewerZone)) line += ' ' + zoneAbbr(s, z);
    return line;
  }

  // The words for a link preview: "Saturday, October 31, 7:30 PM PDT".
  // Always with the zone: whoever reads the preview could be anywhere.
  function whenPreview(e) {
    const w = when(e, null);
    return w.date + ', ' + w.time + ' ' + zoneAbbr(startMs(e), e.timeZone);
  }

  // cancelled, over, now (started, not over) or upcoming.
  function phaseOf(e, now) {
    now = now == null ? Date.now() : now;
    if (e.status === 'cancelled') return 'cancelled';
    const s = startMs(e);
    const end = endMs(e);
    const overAt = end != null ? end : s + ASSUMED_LENGTH_MS;
    if (overAt <= now) return 'over';
    if (s <= now) return 'now';
    return 'upcoming';
  }

  // ---------------- People ----------------

  function fullName(p) {
    return [p.firstName, p.lastName].filter(Boolean).join(' ') || p.shortName || '';
  }

  function initials(p) {
    const letters = [p.firstName, p.lastName].filter(Boolean).map((s) => Array.from(String(s))[0] || '');
    return (letters.join('') || '?').toUpperCase();
  }

  // Their photo, or their initials (and events.js swaps in the initials
  // if the photo won't load).
  function avatar(p, size) {
    const url = safeUrl(p && p.photoUrl);
    const cls = 'avatar' + (size ? ' ' + size : '');
    return '<span class="' + cls + '" data-initials="' + esc(initials(p)) + '">'
      + (url ? '<img src="' + esc(url) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' : esc(initials(p)))
      + '</span>';
  }

  function personRow(p, sub, extra) {
    return '<li class="person">' + avatar(p) + '<div class="who"><div class="name">' + esc(fullName(p)) + '</div>'
      + (sub ? '<div class="sub">' + esc(sub) + '</div>' : '') + '</div>' + (extra || '') + '</li>';
  }

  function joinNames(names) {
    if (names.length <= 1) return names.join('');
    return t('event.and', { first: names.slice(0, -1).join(', '), last: names[names.length - 1] });
  }

  // ---------------- Icons ----------------

  const ICON = {
    when: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7 2a1 1 0 0 1 1 1v1h8V3a1 1 0 1 1 2 0v1h1a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h1V3a1 1 0 0 1 1-1zM4 10v9a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-9zm1-4a1 1 0 0 0-1 1v1h16V7a1 1 0 0 0-1-1z"/></svg>',
    where: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a8 8 0 0 1 8 8c0 5.4-6.2 11.2-7.3 12.1a1 1 0 0 1-1.4 0C10.2 21.2 4 15.4 4 10a8 8 0 0 1 8-8zm0 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg>'
  };

  // ---------------- The event page ----------------

  // A cover image, once events have one (v1 scope 4, being built
  // separately). Point this at the field the API gives it; the page and
  // the link preview (lib/render.js) both ask here.
  function coverUrl(e) {
    return safeUrl(e && e.coverImageUrl);
  }

  function statusTags(e, phase) {
    if (phase === 'cancelled') return '<span class="tag danger">' + tx('status.cancelled') + '</span>';
    if (phase === 'over') return '<span class="tag off">' + tx('status.over') + '</span>';
    if (phase === 'now') return '<span class="tag">' + tx('status.now') + '</span>';
    return '';
  }

  function countsLine(e, isHost) {
    const c = e.counts || {};
    const bits = [];
    if (c.going) bits.push(c.going + ' ' + t('status.going').toLowerCase());
    if (c.maybe) bits.push(c.maybe + ' ' + t('status.maybe').toLowerCase());
    if (c.notGoing) bits.push(c.notGoing + ' ' + t('status.not_going').toLowerCase());
    if (c.waitlisted) bits.push(c.waitlisted + ' ' + t('status.waitlisted').toLowerCase());
    if (isHost && c.invited) bits.push(c.invited + ' ' + t('status.invited').toLowerCase());
    return bits.join(' · ');
  }

  // The event itself: title, when, where, who's hosting, the description.
  function details(e, d, o, phase) {
    const signedIn = !!d.me;
    const w = when(e, o.viewerZone);
    const tags = statusTags(e, phase);
    const cover = coverUrl(e);
    let h = '<section class="card event-head' + (phase === 'cancelled' ? ' is-cancelled' : '') + '" id="details" data-section="details">';
    if (cover) h += '<img class="cover" src="' + esc(cover) + '" alt="">';
    if (tags) h += '<div class="tags">' + tags + '</div>';
    h += '<h1 class="event-title">' + esc(e.title) + '</h1>';
    h += '<div class="meta when">' + ICON.when + '<div class="what">' + esc(w.date) + '<span class="sub">' + esc(w.time) + '</span>'
      + (w.zoneNote ? '<span class="sub zone-note">' + esc(w.zoneNote) + '</span>' : '') + '</div></div>';
    if (e.locationName || e.locationAddress || e.locationAddressHidden) {
      h += '<div class="meta where">' + ICON.where + '<div class="what">';
      if (e.locationName) h += '<span class="place">' + esc(e.locationName) + '</span>';
      if (e.locationAddress) {
        h += '<span class="sub address">' + esc(e.locationAddress) + '</span>'
          + '<span class="sub"><a href="https://maps.apple.com/?q=' + esc(encodeURIComponent(e.locationAddress)) + '" target="_blank" rel="noopener noreferrer">'
          + tx('event.openMap') + '</a></span>';
      } else if (e.locationAddressHidden && !signedIn) {
        h += '<span class="sub">' + tx('event.addressHidden') + '</span>';
      }
      h += '</div></div>';
    }
    const hosts = (e.hosts || []).map((x) => x.person);
    if (hosts.length) {
      h += '<div class="hosted-by"><span class="faces">' + hosts.slice(0, 3).map((p) => avatar(p, 'small')).join('') + '</span>'
        + '<span>' + tx('event.hostedBy', { names: joinNames(hosts.map(fullName)) }) + '</span></div>';
    }
    const counts = countsLine(e, !!(e.viewer && e.viewer.canEdit));
    if (counts) h += '<p class="counts">' + esc(counts) + '</p>';
    if (e.description) h += '<div class="description">' + esc(e.description) + '</div>';
    h += '</section>';
    return h;
  }

  // Signed out: a big "RSVP" to the quick sign-up, and a smaller way in
  // for people who already have a Canopy account. Both come back here.
  function signedOutSection(e, d, phase) {
    const links = d.links || {};
    let h = '<section class="card" id="rsvp" data-section="rsvp">';
    if (phase === 'cancelled' || phase === 'over') {
      h += '<p class="state-line' + (phase === 'cancelled' ? ' danger' : '') + '">' + tx(phase === 'cancelled' ? 'event.cancelled' : 'event.over') + '</p>';
      h += '<p class="cta-sub"><a class="link-btn" href="' + esc(links.signIn) + '">' + tx('event.haveAccount') + '</a></p>';
    } else {
      h += '<a class="button cta" href="' + esc(links.quickSignUp) + '">RSVP</a>';
      h += '<p class="cta-hint">' + tx('event.rsvpHint') + '</p>';
      h += '<p class="cta-sub"><a class="link-btn" href="' + esc(links.signIn) + '">' + tx('event.haveAccount') + '</a></p>';
    }
    h += '</section>';
    return h;
  }

  const ANSWER_BUTTONS = [['going', 'Going'], ['maybe', 'Maybe'], ['not_going', "Can't go"]];

  // Signed in, not hosting: going / maybe / can't go, and taking it back.
  function rsvpSection(e, phase) {
    const rsvp = e.viewer && e.viewer.rsvp;
    const status = rsvp ? rsvp.status : null;
    const answered = !!status && status !== 'invited';
    let h = '<section class="card" id="rsvp" data-section="rsvp">';
    if (phase === 'cancelled' || phase === 'over') {
      h += '<p class="state-line' + (phase === 'cancelled' ? ' danger' : '') + '">' + tx(phase === 'cancelled' ? 'event.cancelled' : 'event.over') + '</p>';
      if (answered) h += '<p class="small" style="margin:0">' + tx('event.yourAnswer', { status: t('status.' + status) }) + '</p>';
      return h + '</section>';
    }
    h += '<h3>' + tx(status === 'invited' ? 'event.invitedQuestion' : 'event.question') + '</h3>';
    h += '<div class="answers" role="group">';
    ANSWER_BUTTONS.forEach(([value, label]) => {
      const on = status === value || (value === 'going' && status === 'waitlisted');
      h += '<button type="button" data-action="answer" data-status="' + value + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + esc(label) + '</button>';
    });
    h += '</div>';
    if (status === 'waitlisted') h += '<p class="small" style="margin:12px 0 0">' + tx('event.waitlisted') + '</p>';
    h += '<div class="under-answers"><span class="error" id="rsvpError" role="alert"></span>';
    if (answered) h += '<button type="button" class="link-btn" data-action="withdraw">' + tx('event.withdraw') + '</button>';
    h += '</div></section>';
    return h;
  }

  // Hosts: share the link, invite friends, edit, cancel (or bring back).
  // Co-hosts, plus-ones, capacity and the rest join this area later.
  function hostSection(e, phase) {
    const open = phase === 'upcoming' || phase === 'now';
    let h = '<section class="card" id="host" data-section="host">';
    h += '<h3>' + tx('event.hostingHeading') + '</h3>';
    if (phase === 'cancelled') h += '<p class="state-line danger">' + tx('event.restoreHint') + '</p>';
    else if (phase === 'over') h += '<p class="state-line">' + tx('event.over') + '</p>';
    else h += '<p>' + tx('event.hostingHint') + '</p>';
    h += '<div class="host-actions">';
    if (open) {
      h += '<button type="button" class="wide" data-action="share" data-url="' + esc(e.url) + '" data-title="' + esc(e.title) + '">Share link</button>';
      h += '<a class="button secondary" href="/e/' + esc(e.id) + '/invite">Invite friends</a>';
    }
    h += '<a class="button secondary" href="/e/' + esc(e.id) + '/edit">Edit</a>';
    if (phase === 'cancelled') h += '<button type="button" class="secondary" data-action="restore">Bring back</button>';
    else if (open) h += '<button type="button" class="danger wide" data-action="cancel">Cancel event</button>';
    h += '</div><div class="notice" id="hostNotice" role="status"></div><div class="error" id="hostError" role="alert"></div>';
    h += '</section>';
    return h;
  }

  // Which of your friends are going: the count always, the names when you
  // may see the guest list's names (the API leaves them out otherwise).
  function friendsGoingSection(e) {
    const f = e.friendsGoing;
    if (!f || !f.count) return '';
    let h = '<section class="card" id="friends-going" data-section="friends-going">';
    h += '<h3>' + (f.count === 1 ? tx('event.friendGoing') : tx('event.friendsGoing', { count: f.count })) + '</h3>';
    if (f.people && f.people.length) {
      h += '<div class="chips">' + f.people.map((p) => '<span class="chip">' + avatar(p, 'small') + esc(p.shortName || fullName(p)) + '</span>').join('') + '</div>';
    } else {
      h += '<p style="margin:0">' + tx('event.friendsGoingHidden') + '</p>';
    }
    return h + '</section>';
  }

  const GROUPS = ['going', 'maybe', 'waitlisted', 'not_going', 'invited'];

  // The guest list, as GET /events/{id}/guests answered: names when
  // they're visible to this viewer, grouped by answer; otherwise counts
  // and why.
  function guestsSection(e, g, isHost) {
    if (!g) return '';
    const counts = countsLine(e, isHost);
    let h = '<section class="card" id="guests" data-section="guests">';
    h += '<h3>' + tx('event.guestsHeading') + '</h3>';
    if (!g.guestsVisible) {
      if (counts) h += '<p class="counts" style="margin:0 0 10px">' + esc(counts) + '</p>';
      h += '<p style="margin:0">' + tx('event.hiddenList') + '</p>';
      return h + '</section>';
    }
    if (!g.guests.length) {
      h += '<p style="margin:0">' + tx('event.noAnswers') + '</p>';
      return h + '</section>';
    }
    GROUPS.forEach((status) => {
      const rows = g.guests.filter((x) => x.status === status);
      if (!rows.length) return;
      const label = status === 'invited' ? t('event.invitedGroup') : t('status.' + status);
      const total = (e.counts || {})[status === 'not_going' ? 'notGoing' : status];
      h += '<div class="group-heading">' + esc(label) + (total ? ' · ' + esc(total) : '') + '</div>';
      h += '<ul class="people">' + rows.map((x) => personRow(x.person, x.guests ? '+' + x.guests : '')).join('') + '</ul>';
    });
    if (g.nextCursor) h += '<button type="button" class="secondary more" data-action="more-guests">' + tx('common.showMore') + '</button>';
    return h + '</section>';
  }

  // The whole event page's content. `d` is the page's data ({ event,
  // guests, me, links }); `o` is { viewerZone }.
  function eventPage(d, o) {
    o = o || {};
    const e = d.event;
    const phase = phaseOf(e);
    const isHost = !!(e.viewer && e.viewer.canEdit);
    let h = details(e, d, o, phase);
    if (!d.me) h += signedOutSection(e, d, phase);
    else if (isHost) h += hostSection(e, phase);
    else h += rsvpSection(e, phase);
    if (d.me) h += friendsGoingSection(e) + guestsSection(e, d.guests, isHost);
    return h;
  }

  // ---------------- Lists of events (home) ----------------

  // An event in a list: a date tile, the title, when and where, and your
  // part in it.
  function eventRow(e, o, asCard, list) {
    const z = e.timeZone;
    const s = startMs(e);
    const phase = phaseOf(e);
    const viewer = e.viewer || {};
    let tag = '';
    if (phase === 'cancelled') tag = '<span class="tag danger">' + tx('status.cancelled') + '</span>';
    else if (viewer.canEdit && list !== 'hosting') tag = '<span class="tag off">' + tx('status.hosting') + '</span>';
    else if (viewer.rsvp && viewer.rsvp.status !== 'invited') tag = '<span class="tag' + (viewer.rsvp.status === 'going' ? '' : ' off') + '">' + tx('status.' + viewer.rsvp.status) + '</span>';
    const sub = [whenShort(e, o.viewerZone), e.locationName].filter(Boolean).join(' · ');
    return '<a class="event-row' + (asCard ? ' card' : '') + (phase === 'cancelled' ? ' is-cancelled' : '') + '" href="/e/' + esc(e.id) + '">'
      + '<span class="when-tile"><span class="mon">' + esc(fmt(s, z, { month: 'short' })) + '</span><span class="day">' + esc(fmt(s, z, { day: 'numeric' })) + '</span></span>'
      + '<span class="info"><span class="title">' + esc(e.title) + '</span><span class="sub">' + esc(sub) + '</span></span>'
      + tag + '</a>';
  }

  // An invitation: the event, and going / can't go right there.
  function invitationCard(e, o) {
    return '<div class="card invite-card" data-event="' + esc(e.id) + '">' + eventRow(e, o, false)
      + '<div class="reply"><button type="button" data-action="reply" data-status="going">Going</button>'
      + '<button type="button" class="secondary" data-action="reply" data-status="not_going">Can\'t go</button></div>'
      + '<div class="error" role="alert"></div></div>';
  }

  const HOME_LISTS = ['invitations', 'hosting', 'upcoming', 'past'];

  // One of your lists, with its heading, or nothing when it's empty.
  function homeList(name, list, o) {
    if (!list || !list.events.length) return '';
    let h = '<section class="home-list" id="list-' + name + '" data-section="' + name + '">';
    h += '<div class="section-heading"><h2>' + tx('home.' + name) + '</h2></div>';
    h += '<div class="event-list">';
    h += list.events.map((e) => (name === 'invitations' ? invitationCard(e, o) : eventRow(e, o, true, name))).join('');
    h += '</div>';
    if (list.nextCursor) h += '<button type="button" class="secondary more" data-action="more" data-list="' + name + '">' + tx('common.showMore') + '</button>';
    return h + '</section>';
  }

  // Your events, signed in: invitations first (they want an answer), then
  // what you're hosting, what's coming up, and what's past.
  function homeLists(d, o) {
    o = o || {};
    const lists = d.lists || {};
    const h = HOME_LISTS.map((name) => homeList(name, lists[name], o)).join('');
    if (h) return h;
    return '<div class="card"><p class="empty">' + tx(d.me && d.me.emailVerified ? 'home.emptyHost' : 'home.empty') + '</p></div>';
  }

  // ---------------- Friends ----------------

  function together(f, prefix) {
    return f.eventsInCommon === 1 ? t(prefix + '.togetherOne') : t(prefix + '.together', { count: f.eventsInCommon });
  }

  function friendRows(friends) {
    return friends.map((f) => {
      const last = f.lastTogetherAt
        ? t('friends.lastTogether', { date: new Date(f.lastTogetherAt).toLocaleDateString(LOCALE, { month: 'short', day: 'numeric', year: 'numeric' }) })
        : '';
      return personRow(f.person, [together(f, 'friends'), last].filter(Boolean).join(' · '));
    }).join('');
  }

  // A friend to invite: a checkbox, or what they've already said.
  function inviteRow(f, onList) {
    const p = f.person;
    const status = onList[p.id];
    const sub = together(f, 'invite');
    const right = status
      ? '<span class="tag' + (status === 'going' ? '' : ' off') + '">' + tx('status.' + status) + '</span>'
      : '<input type="checkbox" value="' + esc(p.id) + '" aria-label="' + esc(fullName(p)) + '">';
    return '<li class="person' + (status ? ' on-list' : '') + '" data-name="' + esc(fullName(p).toLowerCase()) + '">'
      + '<label style="display:contents">' + avatar(p) + '<div class="who"><div class="name">' + esc(fullName(p)) + '</div><div class="sub">' + esc(sub) + '</div></div>' + right + '</label></li>';
  }

  // Inviting friends: a search box, your friends with a checkbox each
  // (or what they've already said), and the button. `d` is { event,
  // friends, onList: { personId: status }, phase }.
  function invitePage(d) {
    const e = d.event;
    let h = '<a class="back-link" href="/e/' + esc(e.id) + '">‹ ' + esc(e.title) + '</a>';
    h += '<section class="card" id="invite" data-section="invite"><h2>' + tx('invite.heading') + '</h2>';
    h += '<p>' + tx('invite.hint') + '</p>';
    // Finding people by phone number or Instagram goes here, once the
    // account service's lookup is open to events (docs/decisions.md,
    // "Later"): one field, an exact match, and the person it finds
    // offered like a friend below. The API's invites already take any
    // person id.
    if (d.phase === 'cancelled' || d.phase === 'over') {
      h += '<p class="state-line" style="margin:0">' + tx('invite.closed') + '</p>';
      return h + '</section>';
    }
    if (!d.friends.length) {
      h += '<p class="empty" style="margin:0">' + tx('invite.noFriends') + '</p>';
      return h + '</section>';
    }
    h += '<input type="search" id="search" placeholder="' + tx('invite.search') + '" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="' + tx('invite.search') + '">';
    h += '<ul class="people pick" id="pickList">' + d.friends.map((f) => inviteRow(f, d.onList || {})).join('') + '</ul>';
    h += '<p class="hidden" id="noMatch" style="margin:10px 0 0">' + tx('invite.noMatch') + '</p>';
    h += '</section>';
    h += '<div class="sticky-send"><div class="card" style="padding:12px">'
      + '<div class="notice" id="inviteNotice" role="status"></div><div class="error" id="inviteError" role="alert"></div>'
      + '<button type="button" id="sendBtn" data-action="send" disabled>Invite</button></div></div>';
    return h;
  }

  // ---------------- The editor ----------------

  // An instant as a datetime-local field's value ("2026-10-31T19:30"),
  // on the clock in `zone`.
  function localInput(iso, zone) {
    if (!iso) return '';
    const parts = {};
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date(iso)).forEach((p) => { parts[p.type] = p.value; });
    return parts.year + '-' + parts.month + '-' + parts.day + 'T' + parts.hour + ':' + parts.minute;
  }

  // A datetime-local value read on the clock in `zone`, as an ISO
  // instant; '' for an empty or unreadable one. The zone's offset is
  // looked up for that moment (twice, so a time near a daylight-saving
  // change lands on the right side of it).
  function fromLocalInput(value, zone) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(value || ''));
    if (!m) return '';
    const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    const offset = (ms) => {
      const local = localInput(new Date(ms).toISOString(), zone);
      const p = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local);
      return Date.UTC(+p[1], +p[2] - 1, +p[3], +p[4], +p[5]) - Math.floor(ms / 60000) * 60000;
    };
    let ms = wall - offset(wall);
    ms = wall - offset(ms);
    return new Date(ms).toISOString();
  }

  function field(id, labelKey, control, hintKey) {
    return '<div class="field"><label class="field-label" for="' + id + '">' + tx(labelKey) + '</label>' + control
      + (hintKey ? '<p class="field-hint">' + tx(hintKey) + '</p>' : '')
      + '<div class="error" id="' + id + 'Error" role="alert"></div></div>';
  }

  // The form for making an event (d.event null) or editing one. Grouped
  // in fieldsets so the fields still to come have a place: the cover
  // image (What), co-hosts, plus-ones and capacity (Guests).
  function editorForm(d, o) {
    o = o || {};
    const e = d.event || {};
    const zone = e.timeZone || o.zone || 'UTC';
    const vis = e.guestListVisibility || 'everyone';
    let h = '';
    if (d.event) h += '<a class="back-link" href="/e/' + esc(e.id) + '">‹ ' + esc(e.title) + '</a>';
    h += '<form class="card form-card" id="eventForm" novalidate>';
    h += '<h2>' + tx(d.event ? 'editor.editHeading' : 'editor.newHeading') + '</h2>';

    h += '<fieldset><legend>' + tx('editor.what') + '</legend>';
    h += field('title', 'editor.title', '<input type="text" id="title" maxlength="120" required value="' + esc(e.title || '') + '">');
    h += field('description', 'editor.description', '<textarea id="description" maxlength="5000" placeholder="' + tx('editor.descriptionPlaceholder') + '">' + esc(e.description || '') + '</textarea>');
    h += '</fieldset>';

    h += '<fieldset><legend>' + tx('editor.when') + '</legend>';
    h += '<div class="field-row">';
    h += field('startsAt', 'editor.starts', '<input type="datetime-local" id="startsAt" required value="' + esc(localInput(e.startsAt, zone)) + '">');
    h += field('endsAt', 'editor.ends', '<input type="datetime-local" id="endsAt" value="' + esc(localInput(e.endsAt, zone)) + '">');
    h += '</div>';
    // The full list is filled in by the page's script, from the browser's
    // own list of zones; the server only knows which one is chosen.
    h += field('timeZone', 'editor.timeZone', '<select id="timeZone"><option value="' + esc(zone) + '" selected>' + esc(zone.replace(/_/g, ' ')) + '</option></select>', 'editor.timeZoneHint');
    h += '</fieldset>';

    h += '<fieldset><legend>' + tx('editor.where') + '</legend>';
    h += field('locationName', 'editor.locationName', '<input type="text" id="locationName" maxlength="200" placeholder="' + tx('editor.locationNamePlaceholder') + '" value="' + esc(e.locationName || '') + '">');
    h += field('locationAddress', 'editor.locationAddress', '<textarea id="locationAddress" maxlength="500" rows="2" style="min-height:0">' + esc(e.locationAddress || '') + '</textarea>', 'editor.locationAddressHint');
    h += '</fieldset>';

    h += '<fieldset><legend>' + tx('editor.guests') + '</legend>';
    h += '<div class="field" id="visibilityField"><span class="field-label">' + tx('editor.guestList') + '</span>';
    ['everyone', 'responded'].forEach((v) => {
      h += '<label class="choice"><input type="radio" name="guestListVisibility" value="' + v + '"' + (vis === v ? ' checked' : '') + '><span>' + tx('editor.' + v) + '</span></label>';
    });
    h += '<p class="field-hint">' + tx('editor.hostsSeeAll') + '</p>';
    h += '<div class="error" id="guestListVisibilityError" role="alert"></div></div>';
    h += '</fieldset>';

    h += '<div class="error" id="formError" role="alert"></div>';
    h += '<div class="form-buttons">'
      + (d.event ? '<a class="button secondary" href="/e/' + esc(e.id) + '">Back</a>' : '')
      + '<button type="submit" id="saveBtn">' + (d.event ? 'Save' : 'Create event') + '</button></div>';
    h += '</form>';
    return h;
  }

  return {
    esc, tx, localInput, fromLocalInput, editorForm, safeUrl, fmt, when, whenShort, whenPreview, phaseOf, zoneAbbr, zoneCity, sameClock,
    fullName, initials, avatar, personRow, coverUrl,
    eventPage, details, rsvpSection, hostSection, friendsGoingSection, guestsSection, signedOutSection,
    eventRow, homeLists, homeList, friendRows, inviteRow, invitePage,
    ASSUMED_LENGTH_MS, HOME_LISTS
  };
});
