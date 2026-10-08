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

  // The same, with the values named in `strong` (escaped) in bold: "<b>Ana
  // Lima</b> is going." The sentence is escaped first, with markers where
  // they go, so nothing in a value or the copy can become markup.
  function txStrong(path, vars, strong) {
    const marked = Object.assign({}, vars);
    strong.forEach((k, i) => { marked[k] = '\u0001' + i + '\u0002'; });
    let html = esc(t(path, marked));
    strong.forEach((k, i) => { html = html.replace('\u0001' + i + '\u0002', '<strong>' + esc(vars[k]) + '</strong>'); });
    return html;
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

  // ---------------- Time zones, by friendly name ----------------
  //
  // A zone is named the way people say it: "Pacific Time", "Central
  // European Time", "Arizona", "London". The name is the browser's own
  // generic name (Intl's timeZoneName: 'longGeneric'), with a few
  // overrides where that name is clumsy ("Hawaii-Aleutian Standard Time",
  // "United Kingdom Time") or wrong for what people mean (Phoenix is
  // "Mountain Standard Time", but nobody in Arizona follows Mountain
  // Time's clock changes). A zone that shares a generic name with one of
  // the main zones below but not its clock (Mexico City is "Central
  // Standard Time", but has no summer time) goes by its city, as does any
  // zone the browser has no name for. The stored value is always the IANA
  // id; these are only labels.

  // The main zones, west to east: the ones the time zone menu offers
  // first. When two of them read the same at a moment (Phoenix and Los
  // Angeles in summer), the one listed first stands for that offset.
  const MAIN_ZONES = [
    'Pacific/Honolulu', 'America/Anchorage', 'America/Los_Angeles', 'America/Denver', 'America/Phoenix',
    'America/Chicago', 'America/Mexico_City', 'America/New_York', 'America/Halifax', 'America/St_Johns',
    'America/Sao_Paulo', 'America/Argentina/Buenos_Aires', 'Europe/London', 'Africa/Lagos', 'Europe/Paris',
    'Africa/Johannesburg', 'Europe/Athens', 'Europe/Moscow', 'Africa/Nairobi', 'Asia/Jerusalem', 'Asia/Dubai',
    'Asia/Karachi', 'Asia/Kolkata', 'Asia/Bangkok', 'Asia/Shanghai', 'Asia/Singapore', 'Asia/Tokyo', 'Asia/Seoul',
    'Australia/Perth', 'Australia/Adelaide', 'Australia/Brisbane', 'Australia/Sydney', 'Pacific/Auckland'
  ];
  const ZONE_NAMES = {
    'Pacific/Honolulu': 'Hawaii Time',
    'America/Phoenix': 'Arizona',
    'America/Mexico_City': 'Mexico City',
    'America/Sao_Paulo': 'Brasília Time',
    'America/Argentina/Buenos_Aires': 'Argentina Time',
    'America/Buenos_Aires': 'Argentina Time',
    'Europe/London': 'London',
    'Africa/Johannesburg': 'South Africa Time',
    'Europe/Moscow': 'Moscow Time',
    'Asia/Dubai': 'Gulf Time',
    'Asia/Karachi': 'Pakistan Time',
    'Asia/Kolkata': 'India Time',
    'Asia/Calcutta': 'India Time',
    'Asia/Shanghai': 'China Time',
    'Asia/Singapore': 'Singapore Time',
    'Asia/Tokyo': 'Japan Time',
    'Asia/Seoul': 'Korea Time',
    'Australia/Perth': 'Western Australia Time',
    'Australia/Adelaide': 'Central Australia Time',
    'Australia/Brisbane': 'Brisbane',
    'Australia/Sydney': 'Eastern Australia Time',
    UTC: 'UTC',
    'Etc/UTC': 'UTC'
  };

  // Building an Intl.DateTimeFormat is slow next to using one; the menu's
  // full list asks for hundreds.
  const zoneFormats = {};
  function zoneFormat(zone, kind) {
    const key = kind + ' ' + zone;
    if (!(key in zoneFormats)) {
      try {
        zoneFormats[key] = kind === 'parts'
          ? new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
          : new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longGeneric' });
      } catch (e) {
        zoneFormats[key] = null;
      }
    }
    return zoneFormats[key];
  }

  // Minutes ahead of UTC in `zone` at `ms` (Los Angeles in July: -420).
  function zoneOffset(zone, ms) {
    const f = zoneFormat(zone, 'parts');
    if (!f) return 0;
    const p = {};
    f.formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
    const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute);
    return Math.round((wall - Math.floor(ms / 60000) * 60000) / 60000);
  }

  // "GMT−7", "GMT+5:30", "GMT".
  function offsetWords(minutes) {
    if (!minutes) return 'GMT';
    const a = Math.abs(minutes);
    return 'GMT' + (minutes < 0 ? '−' : '+') + Math.floor(a / 60) + (a % 60 ? ':' + String(a % 60).padStart(2, '0') : '');
  }

  // The browser's generic name, or null when it has none (only "GMT-7").
  function genericName(zone, ms) {
    const f = zoneFormat(zone, 'generic');
    if (!f) return null;
    try {
      const part = f.formatToParts(new Date(ms)).find((x) => x.type === 'timeZoneName');
      const name = part && part.value;
      return name && !/^(GMT|UTC)([+-−]|$)/.test(name) ? name.replace(/ Standard Time$/, ' Time') : null;
    } catch (e) {
      return null;
    }
  }

  // The same clock all year: the same offset in January and in July.
  function sameRules(a, b, ms) {
    const y = new Date(ms).getUTCFullYear();
    return [Date.UTC(y, 0, 15), Date.UTC(y, 6, 15)].every((at) => zoneOffset(a, at) === zoneOffset(b, at));
  }

  // The main zones' own names, by generic name: who owns "Central Time".
  let mainByName = null;
  function mainZoneNamed(name, ms) {
    if (!mainByName) {
      mainByName = {};
      MAIN_ZONES.forEach((z) => {
        const g = genericName(z, ms);
        if (g && !mainByName[g]) mainByName[g] = z;
      });
    }
    return mainByName[name] || null;
  }

  // A zone's friendly name: "Pacific Time", "Arizona", "Mexico City".
  // `ms` is when (for the generic name's season; it rarely matters).
  function zoneName(zone, ms) {
    zone = String(zone || 'UTC');
    ms = ms == null ? Date.now() : ms;
    if (ZONE_NAMES[zone]) return ZONE_NAMES[zone];
    const generic = genericName(zone, ms);
    if (generic) {
      const owner = mainZoneNamed(generic, ms);
      if (!owner || owner === zone) return generic;
      if (sameRules(owner, zone, ms)) return zoneName(owner, ms);
    }
    return zoneCity(zone);
  }

  function regionOf(zone) {
    return String(zone).split('/')[0];
  }

  // The time zone menu's first list: the zones within about three hours
  // of the viewer's own, at `ms` (the event's start, so summer time is
  // right for that day), one per offset, west to east. Each offset is
  // stood for by the first main zone with it, preferring the viewer's own
  // part of the world (Paris sees Athens for +3, not Nairobi). The
  // viewer's own zone and `selected` (the event's) are always there, as
  // their own lines unless a main zone has the same name. Answers [{
  // zone, name, offset, yours, selected }].
  const NEARBY_MINUTES = 180;
  function nearbyZones(viewer, ms, selected) {
    ms = ms == null ? Date.now() : ms;
    viewer = viewer || selected || 'UTC';
    const mine = zoneOffset(viewer, ms);
    const region = regionOf(viewer);
    const byOffset = {};
    MAIN_ZONES.forEach((zone, i) => {
      const offset = zoneOffset(zone, ms);
      if (Math.abs(offset - mine) > NEARBY_MINUTES) return;
      const rank = (regionOf(zone) === region ? 0 : 1000) + i;
      if (!byOffset[offset] || rank < byOffset[offset].rank) byOffset[offset] = { zone, offset, rank };
    });
    const list = Object.keys(byOffset).map((k) => byOffset[k]);
    // The viewer's and the event's own, when no main zone has their name.
    [viewer, selected].forEach((zone) => {
      if (!zone) return;
      const name = zoneName(zone, ms);
      if (list.some((x) => zoneName(x.zone, ms) === name)) return;
      const main = MAIN_ZONES.indexOf(zone);
      list.push({ zone, offset: zoneOffset(zone, ms), rank: main < 0 ? 999 : main });
    });
    const yours = zoneName(viewer, ms);
    const chosen = selected ? zoneName(selected, ms) : null;
    return list
      .sort((a, b) => a.offset - b.offset || a.rank - b.rank)
      .map((x) => {
        const name = zoneName(x.zone, ms);
        return { zone: x.zone, name, offset: x.offset, yours: name === yours, selected: name === chosen };
      });
  }

  // Every zone, for the menu's search: [{ zone, name, city, offset }],
  // west to east, then by name. `zones` is the browser's list
  // (Intl.supportedValuesOf('timeZone')).
  function allZones(zones, ms) {
    ms = ms == null ? Date.now() : ms;
    const seen = {};
    return zones.filter((z) => {
      if (seen[z] || !zoneFormat(z, 'parts')) return false;
      seen[z] = true;
      return true;
    }).map((zone) => ({ zone, name: zoneName(zone, ms), city: zoneCity(zone), offset: zoneOffset(zone, ms) }))
      .sort((a, b) => a.offset - b.offset || a.name.localeCompare(b.name) || a.city.localeCompare(b.city));
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
    const zoneNote = sameClock(s, z, viewerZone) ? null : t('event.zone', { zone: zoneName(z, s) });
    return { date, time, zoneNote };
  }

  // When, in one short line (the wall's "moved it to"): "Sat, Oct 31 ·
  // 7:30 PM", with the zone's friendly name when it isn't the viewer's.
  function whenShort(e, viewerZone) {
    const z = e.timeZone;
    const s = startMs(e);
    const thisYear = fmt(Date.now(), z, { year: 'numeric' });
    const showYear = fmt(s, z, { year: 'numeric' }) !== thisYear;
    let line = fmt(s, z, { weekday: 'short', month: 'short', day: 'numeric', year: showYear ? 'numeric' : undefined }) + ' · ' + timeOf(s, z);
    if (!sameClock(s, z, viewerZone)) line += ' ' + zoneName(z, s);
    return line;
  }

  // The words for a link preview: "Saturday, October 31, 7:30 PM PDT".
  // Always with the zone: whoever reads the preview could be anywhere.
  function whenPreview(e) {
    const w = when(e, null);
    return w.date + ', ' + w.time + ' ' + zoneAbbr(startMs(e), e.timeZone);
  }

  // The calendar day `ms` falls on in `zone`, as a whole number of days,
  // so two of them subtract to "how many days apart" on that clock.
  function dayNumber(ms, zone) {
    const p = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dayKey(ms, zone));
    return p ? Math.round(Date.UTC(+p[3], +p[1] - 1, +p[2]) / 86400000) : 0;
  }

  // When, as the top of the event page says it: { date, time, zoneNote }.
  // One day: "Saturday, October 10" and "7:30 PM – 11:30 PM". Over more
  // than one: "Fri, Oct 9 – Sun, Oct 11" and "7:30 PM – 11:00 AM".
  function whenHead(e, viewerZone) {
    const z = e.timeZone;
    const s = startMs(e);
    const end = endMs(e);
    const thisYear = fmt(Date.now(), z, { year: 'numeric' });
    const year = fmt(s, z, { year: 'numeric' }) !== thisYear ? 'numeric' : undefined;
    const zoneNote = sameClock(s, z, viewerZone) ? null : t('event.zone', { zone: zoneName(z, s) });
    if (end != null && dayKey(end, z) !== dayKey(s, z)) {
      const short = (ms) => fmt(ms, z, { weekday: 'short', month: 'short', day: 'numeric', year });
      return { date: short(s) + ' – ' + short(end), time: timeOf(s, z) + ' – ' + timeOf(end, z), zoneNote };
    }
    return {
      date: fmt(s, z, { weekday: 'long', month: 'long', day: 'numeric', year }),
      time: timeOf(s, z) + (end != null ? ' – ' + timeOf(end, z) : ''),
      zoneNote
    };
  }

  // When, for a list row, the line above the title: "Sat, Oct 10 · 7:30
  // PM" (with the zone's short name when it isn't the viewer's), or the
  // days for an event over more than one: "Fri, Oct 9 – Sun, Oct 11".
  function whenRow(e, viewerZone) {
    const z = e.timeZone;
    const s = startMs(e);
    const end = endMs(e);
    const year = fmt(s, z, { year: 'numeric' }) !== fmt(Date.now(), z, { year: 'numeric' }) ? 'numeric' : undefined;
    const day = (ms) => fmt(ms, z, { weekday: 'short', month: 'short', day: 'numeric', year });
    if (end != null && dayKey(end, z) !== dayKey(s, z)) return day(s) + ' – ' + day(end);
    return day(s) + ' · ' + timeOf(s, z) + (sameClock(s, z, viewerZone) ? '' : ' ' + zoneAbbr(s, z));
  }

  // "Sun, Oct 11 · 8:30 PM" as HTML that only breaks between its pieces,
  // never inside "8:30 PM".
  function unbroken(line) {
    return String(line).split(/( · | – )/).map((part, i) => (i % 2 ? esc(part) : '<span class="nw">' + esc(part) + '</span>')).join('');
  }

  // What people scan for: "Tonight", "Tomorrow", "This Saturday", "In 3
  // weeks", "Happening now", "Ended". Days are counted on the event's own
  // clock, from now. Empty for a cancelled event (it says so instead).
  // The server draws it, and the browser draws it again (events.js), since
  // a page can be opened long after it was sent.
  function relativeWhen(e, now) {
    now = now == null ? Date.now() : now;
    const phase = phaseOf(e, now);
    if (phase === 'cancelled') return '';
    if (phase === 'now') return t('status.now');
    if (phase === 'over') return t('status.over');
    const z = e.timeZone;
    const s = startMs(e);
    const startDay = dayNumber(s, z);
    const today = dayNumber(now, z);
    const days = startDay - today;
    const weekday = fmt(s, z, { weekday: 'long' });
    // Calendar weeks, Monday first (day 0 was a Thursday): "this
    // Saturday" is this week's, "next Tuesday" next week's.
    const weeks = Math.floor((startDay + 3) / 7) - Math.floor((today + 3) / 7);
    if (days <= 0) return Number(fmt(s, z, { hour: 'numeric', hourCycle: 'h23' })) >= 17 ? t('when.tonight') : t('when.today');
    if (days === 1) return t('when.tomorrow');
    if (weeks === 0) return t('when.thisWeekday', { day: weekday });
    if (weeks === 1) return t('when.nextWeekday', { day: weekday });
    if (days < 28) return t('when.inWeeks', { count: Math.max(2, Math.round(days / 7)) });
    const months = Math.round(days / 30.4);
    return months <= 1 ? t('when.inMonth') : t('when.inMonths', { count: months });
  }

  // The relative hint as a pill, with what the browser needs to draw it
  // again (events.js).
  function relativePill(e) {
    const words = relativeWhen(e);
    if (!words) return '';
    const off = phaseOf(e) === 'over';
    return '<span class="tag rel' + (off ? ' off' : '') + '" data-rel-start="' + esc(e.startsAt) + '" data-rel-end="' + esc(e.endsAt || '')
      + '" data-rel-zone="' + esc(e.timeZone) + '" data-rel-status="' + esc(e.status) + '">' + esc(words) + '</span>';
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
    where: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a8 8 0 0 1 8 8c0 5.4-6.2 11.2-7.3 12.1a1 1 0 0 1-1.4 0C10.2 21.2 4 15.4 4 10a8 8 0 0 1 8-8zm0 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg>',
    // Three dots on the box's centre line (the "⋯" character sits on the
    // text baseline, low and to one side, and its size follows the font).
    more: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><circle cx="5" cy="12" r="2.1" fill="currentColor"/><circle cx="12" cy="12" r="2.1" fill="currentColor"/><circle cx="19" cy="12" r="2.1" fill="currentColor"/></svg>'
  };

  // ---------------- The event page ----------------

  // The event's cover image (the API's coverImageUrl: public, at a random
  // address that changes with every upload), or null. The page's hero, the
  // home list's thumbnails and the link preview (lib/render.js) all ask
  // here.
  function coverUrl(e) {
    return safeUrl(e && e.coverImageUrl);
  }

  // Every size of the cover (the API's coverImages, narrowest first, all
  // JPEG) as an <img>'s srcset, so the browser downloads the one that
  // fits: '' when there are none, as for a cover from before sizes until
  // the server has made them (lib/coverBackfill.js), and then the <img>
  // has coverImageUrl alone, as before.
  function coverSrcset(e) {
    const list = (e && Array.isArray(e.coverImages)) ? e.coverImages : [];
    const parts = [];
    for (const c of list) {
      const url = safeUrl(c && c.url);
      if (!url || !(c.width > 0)) return '';
      parts.push(url + ' ' + Math.round(c.width) + 'w');
    }
    return parts.join(', ');
  }

  // How wide each place draws a cover, in CSS px, for `sizes`: [at 700px
  // and wider (public/events.css), narrower]. Every frame is 3:2.
  //   hero: the page's column, 680 wide; edge to edge on a phone.
  //   thumb: the list's thumbnail (.event-row .thumb).
  //   The editor's preview is the same hero, so it asks for 'hero' too.
  const COVER_DRAWN = {
    hero: ['680px', '100vw'],
    thumb: ['168px', '116px']
  };

  // `sizes` for a cover drawn at `place`. The frame is filled
  // object-fit: cover style, so a photo wider than 3:2 is drawn wider than
  // its frame (scaled to the frame's height): the width asked for grows
  // with it, or a panorama would come out soft.
  function coverSizes(e, place) {
    const list = (e && e.coverImages) || [];
    const full = list[list.length - 1];
    const stretch = full && full.height > 0 ? Math.max(1, (full.width / full.height) / 1.5) : 1;
    const k = Math.round(stretch * 100) / 100;
    const [wide, narrow] = COVER_DRAWN[place] || COVER_DRAWN.hero;
    const scale = (v) => {
      if (k === 1) return /^\(/.test(v) ? 'calc' + v : v;
      return /^\(/.test(v) ? 'calc(' + v + ' * ' + k + ')' : Math.round(parseFloat(v) * k) + v.replace(/^[\d.]+/, '');
    };
    return '(min-width: 700px) ' + scale(wide) + ', ' + scale(narrow);
  }

  // An <img> of the cover for `place` (see COVER_DRAWN): src is the full
  // size (what a browser without srcset, or a cover with no sizes yet,
  // gets), srcset and sizes when there are sizes. `attrs` is more
  // attributes, as HTML.
  function coverImg(e, place, cls, attrs) {
    const url = coverUrl(e);
    if (!url) return '';
    const srcset = coverSrcset(e);
    return '<img class="' + cls + '"' + (attrs || '') + ' src="' + esc(url) + '"'
      + (srcset ? ' srcset="' + esc(srcset) + '" sizes="' + esc(coverSizes(e, place)) + '"' : '')
      + ' alt="" decoding="async">';
  }

  // ---------------- An event's colour ----------------
  //
  // A host can turn an event's page to any hue: the event's `themeHue`, in
  // degrees, or null for Canopy's own green. The page's mesh is defined in
  // OKLCH, a space where lightness is what the eye sees, with each glow's
  // lightness (L) and chroma (C) fixed at today's green and only its hue
  // turning. So every hue is exactly as dark as the green, and the contrast
  // worked out at the top of events.css holds for all of them (checked
  // round the whole wheel; docs/decision-log.md has the numbers). Each
  // glow keeps its own small offset from the theme hue, as today's greens
  // differ slightly (the base is a little bluer than the brightest glow).
  //
  // null draws today's hex values exactly. Canopy green is hue 161, so
  // themeHue 161 looks the same (to within a third of a degree). A colour
  // outside sRGB has its chroma lowered until it fits, keeping L and hue.
  // docs/api.md ("Event colours") says the same for the apps.
  const THEME_DEFAULT_HUE = 161;
  const THEME_MESH = {
    //        L       C       hue offset
    base: [0.1652, 0.0266, 6.4],
    m1: [0.3655, 0.0715, 1.4],
    m2: [0.3166, 0.0559, 9.8],
    m3: [0.4233, 0.0856, -0.4],
    m4: [0.2597, 0.0466, 5.8],
    m5: [0.3122, 0.0590, 1.9],
    card: [0.2150, 0.0537, -11.2]
  };

  function linToByte(c) {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, v)) * 255);
  }

  function oklchToLinear(L, C, h) {
    const a = C * Math.cos(h * Math.PI / 180);
    const b = C * Math.sin(h * Math.PI / 180);
    const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
    const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
    const s = Math.pow(L - 0.0894841775 * a - 1.2914855480 * b, 3);
    return [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
    ];
  }

  // An OKLCH colour as [r, g, b] bytes, its chroma lowered until it fits
  // sRGB.
  function oklchToRgb(L, C, h) {
    const fits = (c) => oklchToLinear(L, c, h).every((x) => x >= -0.0001 && x <= 1.0001);
    let c = C;
    if (!fits(c)) {
      let lo = 0;
      let hi = C;
      for (let i = 0; i < 20; i++) {
        const mid = (lo + hi) / 2;
        if (fits(mid)) lo = mid; else hi = mid;
      }
      c = lo;
    }
    return oklchToLinear(L, c, h).map(linToByte);
  }

  function hexOf(rgb) {
    return '#' + rgb.map((x) => x.toString(16).padStart(2, '0')).join('');
  }

  function rgbToOklch(hex) {
    const lin = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    const l = Math.cbrt(0.4122214708 * lin[0] + 0.5363325363 * lin[1] + 0.0514459929 * lin[2]);
    const m = Math.cbrt(0.2119034982 * lin[0] + 0.6806995451 * lin[1] + 0.1073969566 * lin[2]);
    const s = Math.cbrt(0.0883024619 * lin[0] + 0.2817188376 * lin[1] + 0.6299787005 * lin[2]);
    const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
    const B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
    return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, Math.hypot(A, B), (Math.atan2(B, A) * 180 / Math.PI + 360) % 360];
  }

  function isHue(hue) {
    return Number.isInteger(hue) && hue >= 0 && hue <= 359;
  }

  // An event's colour as one value: 'grey' (themeGrayscale: no colour at
  // all), a hue (themeHue), or null for Canopy green. Everything below
  // takes this "theme key".
  const GREY = 'grey';
  function themeKeyOf(e) {
    if (!e) return null;
    if (e.themeGrayscale) return GREY;
    return isHue(e.themeHue) ? e.themeHue : null;
  }

  // One OKLCH colour [L, C, hue] for a theme key: grey keeps L and drops
  // C to 0 (a neutral grey exactly as light); a hue keeps L and C.
  function themed(L, C, hue, key) {
    return key === GREY ? oklchToRgb(L, 0, 0) : oklchToRgb(L, C, (hue + 360) % 360);
  }

  // Any Canopy-green colour (#rrggbb) turned the same way: its offset from
  // Canopy green's hue kept, L kept, C fitted to sRGB (or 0, for grey).
  function turnHex(hex, key) {
    if (key !== GREY && !isHue(key)) return hex;
    const [L, C, h] = rgbToOklch(hex);
    return hexOf(themed(L, C, (key === GREY ? 0 : key) + h - THEME_DEFAULT_HUE, key));
  }

  // The mesh's colours for a theme key: { base, m1...m5, card } as
  // [r, g, b], or null for Canopy green.
  const themeCache = {};
  function themeColors(key) {
    if (key !== GREY && !isHue(key)) return null;
    if (!themeCache[key]) {
      const out = {};
      Object.keys(THEME_MESH).forEach((k) => {
        const [L, C, off] = THEME_MESH[k];
        out[k] = themed(L, C, (key === GREY ? 0 : key) + off, key);
      });
      themeCache[key] = out;
    }
    return themeCache[key];
  }

  // The CSS custom properties that turn a page to a theme key (events.css
  // reads them, falling back to Canopy green), or '' for the default.
  function themeStyle(key) {
    const c = themeColors(key);
    if (!c) return '';
    return '--theme-base:' + hexOf(c.base) + ';--theme-base-rgb:' + c.base.join(',')
      + ';--theme-1:' + hexOf(c.m1) + ';--theme-2:' + hexOf(c.m2) + ';--theme-3:' + hexOf(c.m3)
      + ';--theme-4:' + hexOf(c.m4) + ';--theme-5:' + hexOf(c.m5)
      + ';--theme-card:rgba(' + c.card.join(',') + ',0.30);--theme-card-solid:' + hexOf(c.card)
      // The accent follows the event too (the photo ring, the "how soon"
      // pill, icons, links, the main button), so the whole page is one
      // colour: Canopy green's accents turned like everything else,
      // lightness kept. Checked at every hue and grey: dark text on the
      // accent at least 6.8:1, links on the base at least 14.5:1, the
      // accent against the base at least 7:1.
      + ';--accent:' + turnHex('#2ec44f', key) + ';--on-accent:' + turnHex('#03190a', key) + ';--accent-text:' + turnHex('#b6f5c3', key);
  }

  // The hue that matches a photo: the server works it out when a cover is
  // uploaded (lib/coverImage.js, as `coverHue`) and the editor does the
  // same for a photo just picked, with this one function, so they agree.
  //
  // `data` is RGB or RGBA bytes (`channels` 3 or 4) of the photo shrunk to
  // about 64×64. Each pixel goes to OKLCH; near-greys (C < 0.04), and very
  // dark (L < 0.2) or very light (L > 0.93) ones, are left out. The rest
  // vote for their hue, weighted by chroma, into 360 one-degree bins,
  // smoothed over ±12°; the peak wins, refined to the chroma-weighted mean
  // hue within 12° of it. Fewer than 4% of pixels voting is a greyscale
  // photo: null.
  function hueFromPixels(data, channels) {
    const bins = new Float64Array(360);
    let voters = 0;
    const n = Math.floor(data.length / channels);
    const lin = (b) => { const c = b / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    for (let i = 0; i < n; i++) {
      const r = lin(data[i * channels]);
      const g = lin(data[i * channels + 1]);
      const b = lin(data[i * channels + 2]);
      const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
      const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
      const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
      const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
      const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
      const B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
      const C = Math.hypot(A, B);
      if (C < 0.04 || L < 0.2 || L > 0.93) continue;
      bins[Math.floor((Math.atan2(B, A) * 180 / Math.PI + 360) % 360)] += C;
      voters++;
    }
    if (!n || voters / n < 0.04) return null;
    const W = 12;
    let best = -1;
    let bestSum = -1;
    for (let h = 0; h < 360; h++) {
      let sum = 0;
      for (let d = -W; d <= W; d++) sum += bins[(h + d + 360) % 360];
      if (sum > bestSum) { bestSum = sum; best = h; }
    }
    let x = 0;
    let y = 0;
    for (let d = -W; d <= W; d++) {
      const h = (best + d + 360) % 360;
      x += bins[h] * Math.cos((h + 0.5) * Math.PI / 180);
      y += bins[h] * Math.sin((h + 0.5) * Math.PI / 180);
    }
    return Math.round((Math.atan2(y, x) * 180 / Math.PI + 360) % 360) % 360;
  }

  // The editor's colour slider runs 0 to SLIDER_MAX: the first SLIDER_GREY
  // steps are grey (no colour), then the hues 0 to 359. A theme key to a
  // slider position and back; untouched, a new event's slider sits on
  // Canopy green's hue.
  const SLIDER_GREY = 30;
  const SLIDER_MAX = SLIDER_GREY + 359;
  function sliderOf(key) {
    if (key === GREY) return Math.floor(SLIDER_GREY / 2);
    return SLIDER_GREY + (isHue(key) ? key : THEME_DEFAULT_HUE);
  }
  function keyOfSlider(value) {
    const v = Math.round(Number(value));
    return v < SLIDER_GREY ? GREY : Math.min(359, v - SLIDER_GREY);
  }

  // The slider's track: grey, then the wheel at a lightness you can see
  // on a dark page (the mesh itself is too dark to tell hues apart on a
  // thin track). The grey is exactly as light as the colours.
  function hueTrack() {
    const grey = hexOf(oklchToRgb(0.68, 0, 0));
    const at = (v) => (v / SLIDER_MAX * 100).toFixed(2) + '%';
    const stops = [grey + ' 0%', grey + ' ' + at(SLIDER_GREY - 1)];
    for (let h = 0; h <= 360; h += 30) stops.push(hexOf(oklchToRgb(0.68, 0.15, h % 360)) + ' ' + at(SLIDER_GREY + Math.min(h, 359)));
    return 'linear-gradient(to right, ' + stops.join(', ') + ')';
  }

  // An event with no cover gets a picture anyway, so every event page has
  // the same hero: soft glows in Canopy greens on the page's own dark
  // base, placed and coloured by the event's id (the same event always
  // looks the same, on the server and in the browser). No words in it.
  const ART_GREENS = [
    ['#145c3e', '#2ec44f', '#0f5a5a'],
    ['#0f4a33', '#7fbf3f', '#145c3e'],
    ['#0a3b2e', '#3fa86b', '#b6f5c3'],
    ['#1f7a4d', '#0c3a28', '#9be0a8'],
    ['#0f5a5a', '#2ec44f', '#0a3b2e'],
    ['#145c3e', '#d7e86b', '#0f4a33']
  ];

  function seedOf(text) {
    let h = 2166136261;
    for (const c of String(text || '')) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    return h >>> 0;
  }

  // The generated picture's colours and placement, as its style (the
  // editor sets it again as its colour slider moves).
  function coverArtStyle(e) {
    const h = seedOf(e && e.id);
    const part = (n, shift) => (h >>> shift) % n;
    // In the event's colour, when it has one.
    const key = themeKeyOf(e);
    const [c1, c2, c3] = ART_GREENS[part(ART_GREENS.length, 0)].map((hex) => turnHex(hex, key));
    return '--c0:' + turnHex('#03120c', key) + ';--c1:' + c1 + ';--c2:' + c2 + ';--c3:' + c3
      + ';--x1:' + (8 + part(45, 3)) + '%;--y1:' + (10 + part(40, 9)) + '%'
      + ';--x2:' + (50 + part(45, 14)) + '%;--y2:' + (35 + part(50, 20)) + '%'
      + ';--a:' + (90 + part(180, 25)) + 'deg';
  }

  function coverArt(e, cls, attrs) {
    return '<span class="cover-art' + (cls ? ' ' + cls : '') + '"' + (attrs || '') + ' style="' + esc(coverArtStyle(e)) + '" aria-hidden="true"></span>';
  }

  // The event's picture at `place` (see COVER_DRAWN): its cover, or the
  // generated one.
  function coverMedia(e, place, imgAttrs) {
    return coverImg(e, place, 'cover', imgAttrs) || coverArt(e);
  }

  function isOpen(phase) {
    return phase === 'upcoming' || phase === 'now';
  }

  // "+2 guests": plus-ones, wherever they're counted.
  function plusGuests(n) {
    return n === 1 ? t('event.plusGuest') : t('event.plusGuests', { count: n });
  }

  // "3 spots left", "Full...": for an event with a capacity that's still
  // on. Empty otherwise.
  function spotsLine(e, phase) {
    if (e.capacity == null || e.spotsLeft == null || !isOpen(phase)) return '';
    if (e.spotsLeft === 0) return t('event.full');
    return e.spotsLeft === 1 ? t('event.spotLeft') : t('event.spotsLeft', { count: e.spotsLeft });
  }

  // "4 going +2 guests · 1 maybe": people, and the plus-ones they bring.
  function countsLine(e, isHost) {
    const c = e.counts || {};
    const g = c.guests || {};
    const bits = [];
    const add = (n, status, guests) => {
      if (n) bits.push(n + ' ' + t('status.' + status).toLowerCase() + (guests ? ' ' + plusGuests(guests) : ''));
    };
    add(c.going, 'going', g.going);
    add(c.maybe, 'maybe', g.maybe);
    add(c.notGoing, 'not_going', 0);
    add(c.waitlisted, 'waitlisted', g.waitlisted);
    if (isHost) add(c.invited, 'invited', 0);
    return bits.join(' · ');
  }

  // The event itself, as one card: the hero (its cover, or the generated
  // picture, at 3:2, fading into the page) on top, the title and when on
  // the fade, then where, who's hosting, spots and the description.
  function details(e, d, o, phase) {
    const signedIn = !!d.me;
    const w = whenHead(e, o.viewerZone);
    const tag = phase === 'cancelled' ? '<span class="tag danger">' + tx('status.cancelled') + '</span>' : relativePill(e);
    let h = '<section class="event-head' + (phase === 'cancelled' ? ' is-cancelled' : '') + (coverUrl(e) ? ' has-cover' : '') + '" id="details" data-section="details">';
    // The 3:2 frame: the picture, its fade, and how soon, low on the left
    // inside the top 2:1 (events.css has the geometry).
    h += '<div class="hero">' + coverMedia(e, 'hero') + (tag ? '<div class="tags">' + tag + '</div>' : '') + '</div>';
    // The title on the fade, then when: the two things a guest opening
    // the link needs at once. The place comes after, in the card.
    h += '<div class="head-text"><h1 class="event-title">' + esc(e.title) + '</h1>'
      + '<div class="when-big"><div class="when-date">' + esc(w.date) + '</div><div class="when-time">' + esc(w.time) + '</div>'
      + (w.zoneNote ? '<div class="zone-note">' + esc(w.zoneNote) + '</div>' : '') + '</div></div>';
    // The rest of the card: where, who's hosting, spots, the description.
    h += '<div class="details-card">';
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
    const spots = spotsLine(e, phase);
    if (spots) h += '<p class="spots' + (e.spotsLeft === 0 ? ' full' : '') + '">' + esc(spots) + '</p>';
    if (e.description) h += '<div class="description">' + esc(e.description) + '</div>';
    h += '</div></section>';
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

  const BRINGS_GUESTS = ['going', 'maybe', 'waitlisted'];

  // The plus-ones the RSVP's stepper shows: what their answer brings, or,
  // before they've answered, what they've picked so far (d.pendingGuests,
  // which the page keeps; it goes with the answer).
  function guestsShown(e, d) {
    const rsvp = e.viewer && e.viewer.rsvp;
    if (rsvp && BRINGS_GUESTS.includes(rsvp.status)) return rsvp.guests;
    return Math.min(Math.max(0, (d && d.pendingGuests) || 0), e.guestsAllowed || 0);
  }

  // Someone a host took off the event: a calm line, nothing to press.
  function removedSection() {
    return '<section class="card" id="rsvp" data-section="rsvp">'
      + '<p class="state-line">' + tx('event.removedHeading') + '</p>'
      + '<p class="small" style="margin:0">' + tx('event.removedHint') + '</p></section>';
  }

  // Signed in, not hosting: going / maybe / can't go, how many guests
  // they're bringing (when the host allows any), and taking it back.
  function rsvpSection(e, phase, d) {
    const rsvp = e.viewer && e.viewer.rsvp;
    const status = rsvp ? rsvp.status : null;
    if (status === 'removed') return removedSection();
    const answered = !!status && status !== 'invited';
    let h = '<section class="card" id="rsvp" data-section="rsvp">';
    if (phase === 'cancelled' || phase === 'over') {
      h += '<p class="state-line' + (phase === 'cancelled' ? ' danger' : '') + '">' + tx(phase === 'cancelled' ? 'event.cancelled' : 'event.over') + '</p>';
      if (answered) {
        h += '<p class="small" style="margin:0">' + tx('event.yourAnswer', { status: t('status.' + status) + (rsvp.guests ? ' ' + plusGuests(rsvp.guests) : '') }) + '</p>';
      }
      return h + '</section>';
    }
    h += '<h3>' + tx(status === 'invited' ? 'event.invitedQuestion' : 'event.question') + '</h3>';
    if (e.capacity != null && e.spotsLeft === 0 && status !== 'going' && status !== 'waitlisted') {
      h += '<p class="small full-hint">' + tx('event.fullHint') + '</p>';
    }
    h += '<div class="answers" role="group">';
    ANSWER_BUTTONS.forEach(([value, label]) => {
      const on = status === value || (value === 'going' && status === 'waitlisted');
      h += '<button type="button" data-action="answer" data-status="' + value + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + esc(label) + '</button>';
    });
    h += '</div>';
    const allowed = e.guestsAllowed || 0;
    const overLimit = !!(rsvp && rsvp.guestsOverLimit);
    if ((allowed > 0 || overLimit) && status !== 'not_going') {
      const n = guestsShown(e, d);
      h += '<div class="bringing"><div class="label">' + tx('event.bringing')
        + '<span class="sub">' + (allowed === 1 ? tx('event.bringingHintOne') : tx('event.bringingHint', { count: allowed })) + '</span></div>'
        + '<div class="stepper" role="group" aria-label="' + tx('event.bringing') + '">'
        + '<button type="button" class="secondary" data-action="guests" data-delta="-1" aria-label="' + tx('event.fewerGuest') + '"' + (n <= 0 ? ' disabled' : '') + '>−</button>'
        + '<output id="guestCount" aria-live="polite">' + esc(n) + '</output>'
        + '<button type="button" class="secondary" data-action="guests" data-delta="1" aria-label="' + tx('event.moreGuest') + '"' + (n >= allowed ? ' disabled' : '') + '>+</button>'
        + '</div></div>';
      if (overLimit) h += '<p class="small note">' + tx('event.overLimitNote', { allowed, guests: rsvp.guests }) + '</p>';
    }
    if (status === 'waitlisted') h += '<p class="small" style="margin:12px 0 0">' + tx('event.waitlisted') + '</p>';
    h += '<div class="under-answers"><span class="error" id="rsvpError" role="alert"></span>';
    if (answered) h += '<button type="button" class="link-btn" data-action="withdraw">' + tx('event.withdraw') + '</button>';
    h += '</div></section>';
    return h;
  }

  // Hosts: share the link and invite (while it's on), edit, and a ⋯ menu
  // for the rest. The creator's menu: co-hosts, a new link, cancel (or
  // bring back) and delete, last and in red. A co-host's: step down. (The
  // API says the same: creator_only.) `d.newLink` is set by the page just
  // after a new link was made, to show it with share and copy;
  // `d.showCohosts` once "Co-hosts…" is picked, to show the co-hosts.
  function hostSection(e, phase, d) {
    d = d || {};
    const open = isOpen(phase);
    const creator = e.viewer && e.viewer.role === 'creator';
    let h = '<section class="card" id="host" data-section="host">';
    h += '<h3>' + tx(creator ? 'event.hostingHeading' : 'event.cohostingHeading') + '</h3>';
    // Only a state worth saying (cancelled, over): no help text under the
    // heading. The buttons say what a host can do, and a co-host's menu
    // has only what they may.
    if (phase === 'cancelled') h += '<p class="state-line danger">' + tx(creator ? 'event.restoreHint' : 'event.restoreHintCohost') + '</p>';
    else if (phase === 'over') h += '<p class="state-line">' + tx('event.over') + '</p>';
    if (d.newLink) {
      h += '<div class="new-link" id="newLink"><p>' + tx('event.newLinkMade') + '</p>'
        + '<input type="text" readonly value="' + esc(e.url) + '" aria-label="' + tx('event.newLinkLabel') + '" data-action="select">'
        + '<div class="row"><button type="button" data-action="share" data-url="' + esc(e.url) + '" data-title="' + esc(e.title) + '">Share</button>'
        + '<button type="button" class="secondary" data-action="copy" data-url="' + esc(e.url) + '">Copy</button></div></div>';
    }
    h += '<div class="host-actions">';
    if (open) {
      h += '<button type="button" data-action="share" data-url="' + esc(e.url) + '" data-title="' + esc(e.title) + '">Share link</button>';
      h += '<a class="button secondary" href="/e/' + esc(e.id) + '/invite">Invite</a>';
    }
    // Edit, and the menu beside it.
    const items = [];
    if (creator) {
      items.push(['cohosts', 'Co-hosts…', '']);
      if (open) items.push(['new-link', 'Make a new link…', '']);
      if (phase === 'cancelled') items.push(['restore', 'Bring back event', '']);
      else if (open) items.push(['cancel', 'Cancel event', '']);
      items.push(['delete-event', 'Delete event…', 'danger']);
    } else {
      items.push(['step-down', 'Step down as co-host', '']);
    }
    h += '<div class="edit-row"><a class="button secondary" href="/e/' + esc(e.id) + '/edit">Edit</a>'
      + '<div class="menu-wrap"><button type="button" class="secondary more-btn" id="hostMenuBtn" data-action="host-menu" aria-haspopup="menu" aria-expanded="false" aria-controls="hostMenu" aria-label="' + tx('event.moreActions') + '">' + ICON.more + '</button>'
      + '<div class="menu" id="hostMenu" role="menu" aria-labelledby="hostMenuBtn" hidden>'
      + items.map(([action, label, cls]) => '<button type="button" role="menuitem" tabindex="-1" class="menu-item' + (cls ? ' ' + cls : '') + '" data-action="' + action + '">' + esc(label) + '</button>').join('')
      + '</div></div></div>';
    h += '</div><div class="notice" id="hostNotice" role="status"></div><div class="error" id="hostError" role="alert"></div>';
    if (creator && d.showCohosts) h += cohostsBlock(e, phase);
    h += '</section>';
    return h;
  }

  // The co-hosts, for the creator (opened from the menu): each with
  // "Remove", and "Add co-host".
  function cohostsBlock(e, phase) {
    const cohosts = (e.hosts || []).filter((x) => x.role === 'cohost');
    let h = '<div class="cohosts" id="cohosts">';
    h += '<div class="group-heading">' + tx('event.cohostsHeading') + (cohosts.length ? ' · ' + cohosts.length : '') + '</div>';
    if (cohosts.length) {
      h += '<ul class="people">' + cohosts.map((x) => personRow(x.person, '',
        '<button type="button" class="small-btn secondary" data-action="remove-cohost" data-person="' + esc(x.person.id) + '" data-name="' + esc(fullName(x.person)) + '">Remove</button>')).join('') + '</ul>';
    } else {
      h += '<p class="small" style="margin:6px 0 10px">' + tx('event.cohostsHint') + '</p>';
    }
    if (isOpen(phase)) h += '<a class="button secondary" href="/e/' + esc(e.id) + '/cohosts">Add co-host</a>';
    h += '<div class="error" id="cohostError" role="alert"></div>';
    return h + '</div>';
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
  const GROUP_LABELS = { invited: 'event.invitedGroup', waitlisted: 'event.waitlistGroup' };

  // One guest's line under their name: their plus-ones, and (hosts) that
  // they're bringing more than the host now allows.
  function guestSub(x) {
    if (!x.guests) return '';
    return plusGuests(x.guests) + (x.guestsOverLimit ? ' · ' + t('event.overLimit') : '');
  }

  // The guest list, as GET /events/{id}/guests answered: names when
  // they're visible to this viewer, grouped by answer; otherwise counts
  // and why. Hosts get "Remove" on each guest, and the people they've
  // removed (`removed`, from ?status=removed) with "Undo".
  // "4 Going · 2 Maybe · 1 Waitlist · +3 guests": people, as everywhere
  // else, with the plus-ones going and maybe bring after them. The
  // waitlist only when there is one.
  function attendSummary(e) {
    const c = e.counts || {};
    const g = c.guests || {};
    const bits = [t('attend.going', { count: c.going || 0 }), t('attend.maybe', { count: c.maybe || 0 })];
    if (c.waitlisted) bits.push(t('attend.waitlist', { count: c.waitlisted }));
    const guests = (g.going || 0) + (g.maybe || 0);
    if (guests) bits.push(plusGuests(guests));
    return bits.join(' · ');
  }

  // Who's in the avatar row, in order: friends going first, then going,
  // then maybe, the most recent answer first in each. The guest list
  // comes from the API in the order people answered, oldest first.
  function attendPeople(e, g) {
    const seen = {};
    const out = [];
    const add = (p) => { if (p && !seen[p.id]) { seen[p.id] = true; out.push(p); } };
    ((e.friendsGoing && e.friendsGoing.people) || []).forEach(add);
    ['going', 'maybe'].forEach((status) => {
      g.guests.filter((x) => x.status === status).slice().reverse().forEach((x) => add(x.person));
    });
    return out;
  }

  // How many circles fit in the row: the server draws for a phone, and
  // the page's script works it out from the row's width (views/event.html).
  const ATTEND_SLOTS = 5;

  // One row of big round photos, never overlapping, as many as fit
  // (`slots`), the last a "+N" for everyone else going or maybe.
  function attendRow(e, g, slots) {
    const c = e.counts || {};
    const people = attendPeople(e, g);
    const total = Math.max(people.length, (c.going || 0) + (c.maybe || 0));
    if (!total) return '';
    slots = Math.max(2, slots || ATTEND_SLOTS);
    const shown = total <= slots ? people.slice(0, slots) : people.slice(0, slots - 1);
    const rest = total - shown.length;
    let h = '<ul class="avatar-row" id="attendRow" style="--slots:' + slots + '">';
    h += shown.map((p) => '<li title="' + esc(fullName(p)) + '">' + avatar(p, 'big') + '</li>').join('');
    if (rest > 0) h += '<li class="more-circle" title="' + tx('attend.more', { count: rest }) + '"><span>+' + esc(rest) + '</span></li>';
    return h + '</ul>';
  }

  // The whole guest list, by answer, as it was before the row: behind
  // "View all". Hosts get "Remove" on each guest, and the people they've
  // removed (`removed`, from ?status=removed) with "Undo".
  function guestGroups(e, g, isHost, removed) {
    let h = '';
    const c = e.counts || {};
    GROUPS.forEach((status) => {
      const rows = g.guests.filter((x) => x.status === status);
      if (!rows.length) return;
      const total = c[status === 'not_going' ? 'notGoing' : status];
      const guests = (c.guests || {})[status];
      h += '<div class="group-heading">' + tx(GROUP_LABELS[status] || 'status.' + status)
        + (total ? ' · ' + esc(total) + (guests ? ' ' + esc(plusGuests(guests)) : '') : '') + '</div>';
      h += '<ul class="people">' + rows.map((x) => personRow(x.person, guestSub(x), isHost
        ? '<button type="button" class="small-btn secondary" data-action="remove-guest" data-person="' + esc(x.person.id) + '" data-name="' + esc(fullName(x.person)) + '">Remove</button>'
        : '')).join('') + '</ul>';
    });
    if (g.nextCursor) h += '<button type="button" class="secondary more" data-action="more-guests">' + tx('common.showMore') + '</button>';
    if (isHost && removed && removed.guests && removed.guests.length) {
      h += '<div class="removed-group" id="removedGroup"><div class="group-heading">' + tx('event.removedGroup') + ' · ' + esc(removed.guests.length + (removed.nextCursor ? '+' : '')) + '</div>';
      h += '<p class="small" style="margin:2px 0 4px">' + tx('event.removedGroupHint') + '</p>';
      h += '<ul class="people">' + removed.guests.map((x) => personRow(x.person, '',
        '<button type="button" class="small-btn secondary" data-action="undo-remove" data-person="' + esc(x.person.id) + '">Undo</button>')).join('') + '</ul></div>';
    }
    return h;
  }

  // Attending: the heading, the counts under it, "View all" on the right,
  // and one row of faces. "View all" opens the whole list, by answer, with
  // the host's tools; it stays open across redraws (d.showAll). Signed
  // out: the counts only. Names the viewer may not see yet: the counts,
  // how many friends are going, and why there are no faces.
  // `g` is GET /events/{id}/guests's answer, or null signed out.
  function guestsSection(e, g, isHost, removed, d) {
    d = d || {};
    const visible = !!(g && g.guestsVisible);
    const any = visible && (g.guests.length || (isHost && removed && removed.guests && removed.guests.length));
    let h = '<section class="card attend" id="guests" data-section="guests">';
    h += '<div class="attend-head"><div class="attend-titles"><h2>' + tx('attend.heading') + '</h2>'
      + '<p class="attend-sum">' + esc(attendSummary(e)) + '</p></div></div>';
    if (!g) return h + '</section>';
    if (!visible) {
      const f = e.friendsGoing;
      if (f && f.count) h += '<p class="attend-note">' + tx(f.count === 1 ? 'event.friendGoing' : 'event.friendsGoing', { count: f.count }) + '</p>';
      return h + '<p class="attend-note" style="margin:0">' + tx('event.hiddenList') + '</p></section>';
    }
    const row = attendRow(e, g, d.attendSlots);
    h += row || '<p class="attend-note" style="margin:0">' + tx('event.noAnswers') + '</p>';
    if (any) {
      h += '<details class="view-all" id="viewAll"' + (d.showAll ? ' open' : '') + '><summary class="pill-btn">'
        + '<span class="when-closed">' + tx('attend.viewAll') + '</span><span class="when-open">' + tx('attend.hide') + '</span></summary>'
        + '<div class="all-guests">' + guestGroups(e, g, isHost, removed) + '</div></details>';
    }
    h += '<div class="error" id="guestsError" role="alert"></div>';
    return h + '</section>';
  }

  // ---------------- The activity wall ----------------

  // When a wall entry happened: "just now", "5m", "3h", then the date (in
  // the viewer's zone, or the event's when the viewer's isn't known).
  function ago(iso, zone, now) {
    const ms = Date.parse(iso);
    const mins = Math.floor(((now == null ? Date.now() : now) - ms) / 60000);
    if (mins < 1) return t('wall.justNow');
    if (mins < 60) return t('wall.minutesAgo', { count: mins });
    if (mins < 24 * 60) return t('wall.hoursAgo', { count: Math.floor(mins / 60) });
    return fmt(ms, zone, { month: 'short', day: 'numeric' });
  }

  // The words for one of the server's entries, or null for a type this
  // doesn't know (the API may add some; they're left out).
  function wallSentence(x, o) {
    const name = x.person ? fullName(x.person) : t('common.formerMember');
    const d = x.details || {};
    switch (x.type) {
      case 'going': case 'off_waitlist': case 'cancelled': case 'uncancelled': case 'cohost_added':
        return txStrong('wall.entries.' + x.type, { name }, ['name']);
      case 'time_changed':
        if (!d.startsAt || !d.timeZone) return null;
        return txStrong('wall.entries.time_changed', { name, when: whenShort({ startsAt: d.startsAt, timeZone: d.timeZone }, o.viewerZone) }, ['name']);
      case 'place_changed': {
        const place = d.locationName || d.locationAddress;
        return place
          ? txStrong('wall.entries.place_changed', { name, place }, ['name', 'place'])
          : txStrong('wall.entries.place_cleared', { name }, ['name']);
      }
      default:
        return null;
    }
  }

  function wallEntry(x, e, o) {
    const zone = o.viewerZone || e.timeZone;
    const del = x.canDelete
      ? '<button type="button" class="link-btn quiet" data-action="delete-entry" data-entry="' + esc(x.id) + '" data-type="' + esc(x.type) + '">Delete</button>'
      : '';
    const when = '<span class="when">' + esc(ago(x.createdAt, zone, o.now)) + '</span>';
    if (x.type === 'post') {
      return '<li class="wall-entry post" data-entry="' + esc(x.id) + '">' + avatar(x.person || {})
        + '<div class="body"><div class="wall-meta"><span class="name">' + esc(x.person ? fullName(x.person) : t('common.formerMember')) + '</span>' + when + '</div>'
        + '<div class="wall-text">' + esc(x.text) + '</div></div>' + del + '</li>';
    }
    const words = wallSentence(x, o);
    if (!words) return '';
    return '<li class="wall-entry auto" data-entry="' + esc(x.id) + '">' + avatar(x.person || {}, 'small')
      + '<div class="body"><span class="wall-line">' + words + '</span> ' + when + '</div>' + del + '</li>';
  }

  // The wall, as GET /events/{id}/wall answered: the newest first, with
  // "show more"; a box to post in when the viewer may; and why there's
  // nothing when the host only shows it to people who've answered.
  function wallSection(e, w, o) {
    if (!w) return '';
    let h = '<section class="card" id="wall" data-section="wall"><h3>' + tx('wall.heading') + '</h3>';
    if (!w.wallVisible) return h + '<p style="margin:0">' + tx('wall.hidden') + '</p></section>';
    if (w.canPost) {
      h += '<form class="wall-form" id="wallForm" novalidate><textarea id="wallText" maxlength="1000" rows="2" placeholder="' + tx('wall.placeholder') + '" aria-label="' + tx('wall.placeholder') + '"></textarea>'
        + '<div class="wall-form-row"><span class="error" id="wallError" role="alert"></span><button type="submit" id="wallPost">Post</button></div></form>';
    }
    const rows = w.entries.map((x) => wallEntry(x, e, o)).join('');
    if (rows) h += '<ul class="wall-list" id="wallList">' + rows + '</ul>';
    else h += '<p class="empty" style="margin:' + (w.canPost ? '12px' : '0') + ' 0 0">' + tx(w.canPost ? 'wall.emptyCanPost' : 'wall.empty') + '</p>';
    if (w.nextCursor) h += '<button type="button" class="secondary more" data-action="more-wall">' + tx('common.showMore') + '</button>';
    return h + '</section>';
  }

  // Whether the viewer is someone a host took off this event.
  function isRemovedViewer(e) {
    return !!(e.viewer && e.viewer.rsvp && e.viewer.rsvp.status === 'removed');
  }

  // The whole event page's content. `d` is the page's data ({ event,
  // guests, removed, wall, me, links, newLink, pendingGuests }); `o` is
  // { viewerZone }. Someone a host removed gets the details and a calm
  // line, and nothing about who's coming (the API gives them nothing).
  function eventPage(d, o) {
    o = o || {};
    const e = d.event;
    const phase = phaseOf(e);
    const isHost = !!(e.viewer && e.viewer.canEdit);
    let h = details(e, d, o, phase);
    if (!d.me) h += signedOutSection(e, d, phase);
    else if (isHost) h += hostSection(e, phase, d);
    else h += rsvpSection(e, phase, d);
    // Attending: counts only signed out; nothing for someone removed.
    if (!d.me) h += guestsSection(e, null, false, null, d);
    else if (!isRemovedViewer(e)) h += guestsSection(e, d.guests, isHost, d.removed, d) + wallSection(e, d.wall, o);
    return h;
  }

  // ---------------- Lists of events (home) ----------------

  // An event in a list: a date tile, the title, when and where, and your
  // part in it.
  function eventRow(e, o, asCard, list) {
    const phase = phaseOf(e);
    const viewer = e.viewer || {};
    let tag = '';
    if (phase === 'cancelled') tag = '<span class="tag danger">' + tx('status.cancelled') + '</span>';
    else if (viewer.canEdit && list !== 'hosting') tag = '<span class="tag off">' + tx(viewer.role === 'cohost' ? 'status.cohosting' : 'status.hosting') + '</span>';
    else if (viewer.rsvp && !['invited', 'removed'].includes(viewer.rsvp.status)) tag = '<span class="tag' + (viewer.rsvp.status === 'going' ? '' : ' off') + '">' + tx('status.' + viewer.rsvp.status) + '</span>';
    // The cover (or the generated picture) as a 3:2 thumbnail; then when,
    // in a bold line above the title, as calendars do; the title; where.
    // An event with its own colour tints its card's glass with it.
    const theme = themeColors(themeKeyOf(e));
    const tint = theme ? ' style="--card:rgba(' + theme.card.join(',') + ',0.45)"' : '';
    return '<a class="event-row' + (asCard ? ' card' : '') + (phase === 'cancelled' ? ' is-cancelled' : '') + '" href="/e/' + esc(e.id) + '"' + (asCard ? tint : '') + '>'
      + '<span class="thumb">' + coverMedia(e, 'thumb', ' loading="lazy"') + '</span>'
      + '<span class="info"><span class="row-when">' + unbroken(whenRow(e, o.viewerZone)) + '</span>'
      + '<span class="title">' + esc(e.title) + '</span>'
      + (e.locationName ? '<span class="sub">' + esc(e.locationName) + '</span>' : '')
      + (tag ? '<span class="tags">' + tag + '</span>' : '') + '</span></a>';
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

  // "2 events together", or nothing with none in common (someone you
  // added).
  function together(f, prefix) {
    if (!f.eventsInCommon) return '';
    return f.eventsInCommon === 1 ? t(prefix + '.togetherOne') : t(prefix + '.together', { count: f.eventsInCommon });
  }

  // How a friend is in your list, under their name: the way in ("Friend
  // link", "Added") when there's one, then events together.
  function friendSub(f, prefix, withLast) {
    const how = f.source && f.source !== 'shared_events' ? t('friends.source.' + f.source) : '';
    const last = withLast && f.lastTogetherAt
      ? t('friends.lastTogether', { date: new Date(f.lastTogetherAt).toLocaleDateString(LOCALE, { month: 'short', day: 'numeric', year: 'numeric' }) })
      : '';
    return [how, together(f, prefix), last].filter(Boolean).join(' · ');
  }

  // Your friends, each with Remove (the page asks first).
  function friendRows(friends) {
    return friends.map((f) => {
      const p = f.person;
      return '<li class="person" data-id="' + esc(p.id) + '">' + avatar(p) + '<div class="who"><div class="name">' + esc(fullName(p)) + '</div>'
        + '<div class="sub">' + esc(friendSub(f, 'friends', true)) + '</div></div>'
        + '<button type="button" class="small-btn secondary" data-action="remove-friend" data-person="' + esc(p.id) + '" data-name="' + esc(fullName(p)) + '">Remove</button></li>';
    }).join('');
  }

  // Your friend link: the QR code (drawn by the server, lib/qr.js, and
  // passed in as `qr`, an SVG), the link, Copy, Share and Reset. `d` is
  // { link: { url, code } }.
  function friendLinkSection(d, qr) {
    const url = d.link.url;
    let h = '<section class="card" id="friendLink" data-section="friend-link"><h2>' + tx('friends.linkHeading') + '</h2>';
    h += '<p>' + tx('friends.linkHint') + '</p>';
    if (qr) h += '<div class="qr">' + qr + '</div>';
    h += '<input type="text" class="link-field" id="friendLinkUrl" readonly value="' + esc(url) + '" aria-label="' + tx('friends.linkHeading') + '" data-action="select">';
    h += '<div class="button-row">'
      + '<button type="button" data-action="share-link" data-url="' + esc(url) + '">Share</button>'
      + '<button type="button" class="secondary" data-action="copy-link" data-url="' + esc(url) + '">Copy</button></div>';
    h += '<div class="notice" id="linkNotice" role="status"></div><div class="error" id="linkError" role="alert"></div>';
    h += '<button type="button" class="link-btn quiet reset-link" data-action="reset-link">' + tx('friends.reset') + '</button>';
    return h + '</section>';
  }

  // The person a lookup on the friends page found: "Add friend", or that
  // they already are one.
  function friendFound(p, isFriend) {
    return '<ul class="people found"><li class="person">' + avatar(p) + '<div class="who"><div class="name">' + esc(fullName(p)) + '</div></div>'
      + (isFriend ? '<span class="tag">' + tx('friends.alreadyTag') + '</span>'
        : '<button type="button" class="small-btn" data-action="add-found" data-person="' + esc(p.id) + '" data-name="' + esc(fullName(p)) + '">Add friend</button>')
      + '</li></ul>';
  }

  // The friends page: your link, adding by phone or Instagram, and your
  // list. `d` is { me, link, friends, nextCursor, links }; `o.qr` the QR
  // code's SVG.
  function friendsPage(d, o) {
    let h = friendLinkSection(d, (o || {}).qr);
    h += lookupSection(d, 'friends');
    h += '<section class="card" id="friends" data-section="friends"><h2>' + tx('friends.heading') + '</h2>';
    h += '<p>' + tx('friends.hint') + '</p>';
    h += '<div class="error" id="friendsError" role="alert"></div>';
    h += '<ul class="people" id="friendList">' + friendRows(d.friends) + '</ul>';
    h += '<p class="empty' + (d.friends.length ? ' hidden' : '') + '" id="noFriends" style="margin:0">' + tx('friends.empty') + '</p>';
    if (d.nextCursor) h += '<button type="button" class="secondary more" data-action="more">' + tx('common.showMore') + '</button>';
    return h + '</section>';
  }

  // Someone's friend link, /f/<code>: who it is, and what you can do.
  // `d` is { me, person, viewer, links: { quickSignUp, signIn } }.
  function friendLinkPage(d) {
    const p = d.person;
    const first = p.firstName || fullName(p);
    let h = '<section class="card center friend-card" id="friendInvite">' + avatar(p, 'big');
    if (!d.me) {
      const links = d.links || {};
      h += '<h1>' + tx('friendLink.signedOutHeading', { name: fullName(p) }) + '</h1>';
      h += '<p class="center">' + tx('friendLink.signedOutHint', { first }) + '</p>';
      h += '<a class="button" href="' + esc(links.quickSignUp) + '">' + tx('friendLink.signUp', { first }) + '</a>';
      h += '<p class="cta-sub"><a class="link-btn" href="' + esc(links.signIn) + '">' + tx('friendLink.signIn') + '</a></p>';
      return h + '</section>';
    }
    const v = d.viewer || {};
    if (v.isYou) {
      h += '<h1>' + tx('friendLink.yoursHeading') + '</h1><p class="center">' + tx('friendLink.yoursHint') + '</p>';
      return h + '<a class="button secondary" href="/friends">' + tx('friendLink.toFriends') + '</a></section>';
    }
    if (v.isFriend) {
      h += '<h1>' + tx('friendLink.alreadyHeading', { first }) + '</h1>';
      return h + '<a class="button secondary" href="/friends">' + tx('friendLink.toFriends') + '</a></section>';
    }
    h += '<h1>' + tx('friendLink.confirm', { name: fullName(p) }) + '</h1>';
    h += '<p class="center">' + tx('friendLink.confirmHint', { first }) + '</p>';
    h += '<div class="error" id="acceptError" role="alert"></div>';
    h += '<button type="button" id="acceptBtn" data-action="accept">Add friend</button>';
    return h + '</section>';
  }

  // What someone already on the list said, as a tag.
  function statusTag(status) {
    return '<span class="tag' + (status === 'going' ? '' : ' off') + '">' + tx('status.' + status) + '</span>';
  }

  // A friend to invite: a checkbox, or what they've already said (or that
  // a host removed them: the host is the one looking).
  function inviteRow(f, onList) {
    const p = f.person;
    const status = onList[p.id];
    const sub = friendSub(f, 'invite');
    const right = status ? statusTag(status) : '<input type="checkbox" value="' + esc(p.id) + '" aria-label="' + esc(fullName(p)) + '">';
    return '<li class="person' + (status ? ' on-list' : '') + '" data-name="' + esc(fullName(p).toLowerCase()) + '">'
      + '<label style="display:contents">' + avatar(p) + '<div class="who"><div class="name">' + esc(fullName(p)) + '</div><div class="sub">' + esc(sub) + '</div></div>' + right + '</label></li>';
  }

  // Finding someone by their phone number or Instagram username: one
  // field, an exact match (the account service's lookup, through POST
  // /api/v1/people/lookup), and the person it finds, a name and a photo,
  // offered with "Invite" (the invite page) or "Add friend" (the friends
  // page; `prefix` 'friends' picks its words). Only for verified people
  // (the API's rule); anyone else is told how to get it.
  function lookupSection(d, prefix) {
    prefix = prefix || 'invite';
    let h = '<section class="card" id="lookup" data-section="lookup"><h3>' + tx(prefix + '.lookupHeading') + '</h3>';
    if (!d.me || !d.me.emailVerified) {
      const verify = d.links && safeUrl(d.links.verify);
      return h + '<p style="margin:0">' + (verify ? '<a href="' + esc(verify) + '">' + tx(prefix + '.lookupVerify') + '</a>' : tx(prefix + '.lookupVerify')) + '</p></section>';
    }
    h += '<p>' + tx(prefix + '.lookupHint') + '</p>';
    h += '<form class="lookup-row" id="lookupForm" novalidate>'
      + '<input type="text" id="lookupQuery" placeholder="' + tx('invite.lookupPlaceholder') + '" aria-label="' + tx(prefix + '.lookupHeading') + '" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="64">'
      + '<button type="submit" id="lookupBtn">Find</button></form>';
    h += '<div id="lookupResult"></div><div class="notice" id="lookupNotice" role="status"></div><div class="error" id="lookupError" role="alert"></div>';
    return h + '</section>';
  }

  // The person a lookup found: their name and photo, and "Invite", or
  // what they've already said.
  function lookupResult(p, onList) {
    const status = onList[p.id];
    return '<ul class="people found"><li class="person">' + avatar(p) + '<div class="who"><div class="name">' + esc(fullName(p)) + '</div></div>'
      + (status ? statusTag(status) : '<button type="button" class="small-btn" data-action="invite-found" data-person="' + esc(p.id) + '" data-name="' + esc(fullName(p)) + '">Invite</button>')
      + '</li></ul>';
  }

  // Inviting: finding someone by phone or Instagram, then a search box,
  // your friends with a checkbox each (or what they've already said), and
  // the button. `d` is { event, me, links, friends, onList: { personId:
  // status }, phase }.
  function invitePage(d) {
    const e = d.event;
    let h = '<a class="back-link" href="/e/' + esc(e.id) + '">‹ ' + esc(e.title) + '</a>';
    if (d.phase === 'cancelled' || d.phase === 'over') {
      h += '<section class="card" id="invite" data-section="invite"><h2>' + tx('invite.heading') + '</h2>';
      h += '<p class="state-line" style="margin:0">' + tx('invite.closed') + '</p>';
      return h + '</section>';
    }
    h += lookupSection(d);
    h += '<section class="card" id="invite" data-section="invite"><h2>' + tx('invite.heading') + '</h2>';
    h += '<p>' + tx('invite.hint') + '</p>';
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

  // ---------------- Adding co-hosts ----------------

  // A friend to make a co-host: "Add", or that they already are.
  function cohostRow(f, e) {
    const p = f.person;
    const role = ((e.hosts || []).find((x) => x.person.id === p.id) || {}).role;
    const right = role
      ? '<span class="tag off">' + tx(role === 'creator' ? 'status.hosting' : 'status.cohosting') + '</span>'
      : '<button type="button" class="small-btn" data-action="add-cohost" data-person="' + esc(p.id) + '" data-name="' + esc(fullName(p)) + '">Add</button>';
    return '<li class="person" data-id="' + esc(p.id) + '" data-name="' + esc(fullName(p).toLowerCase()) + '">' + avatar(p)
      + '<div class="who"><div class="name">' + esc(fullName(p)) + '</div><div class="sub">' + esc(friendSub(f, 'invite')) + '</div></div>' + right + '</li>';
  }

  // The creator picks co-hosts from their friends, the same way as
  // inviting: a search box and a row each. `d` is { event, friends, phase }.
  function cohostPage(d) {
    const e = d.event;
    let h = '<a class="back-link" href="/e/' + esc(e.id) + '">‹ ' + esc(e.title) + '</a>';
    h += '<section class="card" id="addCohosts" data-section="cohosts"><h2>' + tx('cohosts.heading') + '</h2>';
    if (d.phase === 'cancelled' || d.phase === 'over') {
      return h + '<p class="state-line" style="margin:0">' + tx('cohosts.closed') + '</p></section>';
    }
    h += '<p>' + tx('cohosts.hint') + '</p>';
    h += '<div class="error" id="cohostError" role="alert"></div>';
    if (!d.friends.length) return h + '<p class="empty" style="margin:0">' + tx('cohosts.noFriends') + '</p></section>';
    h += '<input type="search" id="search" placeholder="' + tx('invite.search') + '" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="' + tx('invite.search') + '">';
    h += '<ul class="people" id="pickList">' + d.friends.map((f) => cohostRow(f, e)).join('') + '</ul>';
    h += '<p class="hidden" id="noMatch" style="margin:10px 0 0">' + tx('cohosts.noMatch') + '</p>';
    return h + '</section>';
  }

  // ---------------- The editor ----------------
  //
  // The editor looks like the event page: the same card, with the cover
  // (or the generated picture) as its hero, a button on the photo to pick
  // one and a × to take it off, the title typed where the title goes, and
  // the date and time as big as the page shows them, each one tapped to
  // change. Then the place and the description in the card, the guest
  // settings and the colour. No help text: short labels, read out but
  // not shown where the field says what it is, and placeholders.

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

  // The editor's date and times, said as the page says them. They're the
  // wall-clock values typed ("2026-10-10", "19:30"), so no zone is
  // involved: "Saturday, October 10", "7:30 PM".
  function wallMs(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(String(value || ''));
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) : null;
  }
  function dayWords(date, now) {
    const ms = wallMs(date);
    if (ms == null) return '';
    const year = new Date(ms).getUTCFullYear() !== new Date(now == null ? Date.now() : now).getFullYear() ? 'numeric' : undefined;
    return fmt(ms, 'UTC', { weekday: 'long', month: 'long', day: 'numeric', year });
  }
  function clockWords(time) {
    const m = /^(\d{2}):(\d{2})/.exec(String(time || ''));
    return m ? fmt(Date.UTC(2000, 0, 1, +m[1], +m[2]), 'UTC', { hour: 'numeric', minute: '2-digit' }) : '';
  }
  // The end: its time on the start's day ("11:30 PM"), and with its day
  // otherwise ("Sun, Oct 11, 11:00 AM").
  function endWords(endLocal, startDate) {
    const ms = wallMs(endLocal);
    if (ms == null) return '';
    const time = clockWords(String(endLocal).slice(11));
    if (String(endLocal).slice(0, 10) === startDate) return time;
    return fmt(ms, 'UTC', { weekday: 'short', month: 'short', day: 'numeric' }) + ', ' + time;
  }

  const ICON_CAMERA = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M9.2 3a2 2 0 0 0-1.7.9L6.6 5.3H5a3 3 0 0 0-3 3V18a3 3 0 0 0 3 3h14a3 3 0 0 0 3-3V8.3a3 3 0 0 0-3-3h-1.6l-.9-1.4A2 2 0 0 0 14.8 3zM12 8.2a4.6 4.6 0 1 1 0 9.2 4.6 4.6 0 0 1 0-9.2zm0 2a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2z"/></svg>';
  const ICON_CLOSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>';

  // The cover, as the hero: the photo (or, with none, the generated
  // picture in the event's colour), and on it, top right, a button to
  // pick a photo and, when there's one, a × to take it off. Nothing is
  // sent until the form is saved (views/editor.html).
  function coverHero(e) {
    const url = coverUrl(e);
    return '<div class="hero" id="coverHero">' + coverArt(e, '', ' id="coverArt"')
      + (coverImg(e, 'hero', 'cover', ' id="coverPreview"') || '<img class="cover" id="coverPreview" alt="" decoding="async">')
      + '<p class="hero-note hidden" id="coverNoPreview">' + tx('editor.coverNoPreview') + '</p>'
      + '<div class="hero-tools">'
      + '<label class="hero-btn file-btn" title="' + tx(url ? 'editor.coverChange' : 'editor.coverAdd') + '">' + ICON_CAMERA
      + '<input type="file" id="coverFile" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif" aria-label="' + tx(url ? 'editor.coverChange' : 'editor.coverAdd') + '"></label>'
      + '<button type="button" class="hero-btn" id="coverRemove" data-action="remove-cover" aria-label="' + tx('editor.coverRemove') + '" title="' + tx('editor.coverRemove') + '"' + (url ? '' : ' hidden') + '>' + ICON_CLOSE + '</button>'
      + '</div></div>';
  }

  // One tappable piece of when: the words, big, with the browser's own
  // picker under them (see-through, so a tap anywhere on the words opens
  // it; views/editor.html opens it on a click where that needs asking).
  function pick(id, type, value, labelKey, words, placeholderKey) {
    return '<label class="pick' + (words ? '' : ' empty') + '" id="' + id + 'Pick"><span class="pick-text" id="' + id + 'Text" aria-hidden="true">'
      + esc(words || t(placeholderKey)) + '</span><input type="' + type + '" id="' + id + '" value="' + esc(value) + '" aria-label="' + tx(labelKey) + '"></label>';
  }

  // The time zone menu's first list (UI.nearbyZones), as menu items: the
  // event's zone ticked, the viewer's own marked. "Other time zones…"
  // last, which opens the search (views/editor.html).
  function zoneMenuItems(viewer, ms, selected) {
    return nearbyZones(viewer, ms, selected).map((z) => '<button type="button" role="menuitemradio" tabindex="-1" class="menu-item zone-item" aria-checked="' + (z.selected ? 'true' : 'false')
      + '" data-action="pick-zone" data-zone="' + esc(z.zone) + '"><span class="zone-tick" aria-hidden="true">' + (z.selected ? '✓' : '') + '</span><span class="zone-item-name">' + esc(z.name)
      + (z.yours ? '<span class="zone-yours">' + tx('editor.zoneYours') + '</span>' : '') + '</span><span class="zone-offset">' + esc(offsetWords(z.offset)) + '</span></button>').join('')
      + '<button type="button" role="menuitem" tabindex="-1" class="menu-item zone-other" data-action="zone-search">' + tx('editor.zoneOther') + '</button>';
  }

  // One line of the full list: friendly name, city (when it says more),
  // and the offset, small.
  function zoneRow(z, selected) {
    return '<li><button type="button" class="zone-row" data-action="pick-zone" data-zone="' + esc(z.zone) + '" aria-pressed="' + (z.zone === selected ? 'true' : 'false') + '">'
      + '<span class="zone-row-name">' + esc(z.name) + (z.city !== z.name ? '<span class="zone-row-city">' + esc(z.city) + '</span>' : '') + '</span>'
      + '<span class="zone-offset">' + esc(offsetWords(z.offset)) + '</span></button></li>';
  }

  // When: the day, then the start and end times, as big as on the page,
  // then the time zone by name, small, with "Change".
  function whenEditor(e, zone, viewer) {
    const start = localInput(e.startsAt, zone);
    const end = localInput(e.endsAt, zone);
    const date = start.slice(0, 10);
    const time = start.slice(11, 16);
    const at = e.startsAt ? Date.parse(e.startsAt) : Date.now();
    let h = '<div class="when-big when-edit">';
    h += '<div class="when-date">' + pick('startDate', 'date', date, 'editor.date', dayWords(date), 'editor.datePlaceholder') + '</div>';
    h += '<div class="when-time">' + pick('startTime', 'time', time, 'editor.startTime', clockWords(time), 'editor.startTime')
      + '<span class="end-part" id="endPart"' + (end ? '' : ' hidden') + '><span class="dash" aria-hidden="true">–</span>'
      + pick('endsAt', 'datetime-local', end, 'editor.endTime', endWords(end, date), 'editor.endTime')
      + '<button type="button" class="round-btn" id="endClear" data-action="clear-end" aria-label="' + tx('editor.removeEnd') + '" title="' + tx('editor.removeEnd') + '">' + ICON_CLOSE + '</button></span>'
      + '<button type="button" class="chip-btn" id="endAdd" data-action="add-end"' + (end ? ' hidden' : '') + '>' + tx('editor.addEnd') + '</button></div>';
    h += '<div class="error" id="startsAtError" role="alert"></div><div class="error" id="endsAtError" role="alert"></div>';
    // The zone: its name, and a menu to change it (the nearby zones,
    // then a search of all of them). The value sent is the IANA id.
    h += '<div class="zone-line"><span class="zone-name" id="zoneName">' + esc(zoneName(zone, at)) + '</span>'
      + '<div class="menu-wrap"><button type="button" class="chip-btn" id="zoneBtn" data-action="zone-menu" aria-haspopup="menu" aria-expanded="false" aria-controls="zoneMenu" aria-label="'
      + tx('editor.zoneChangeLabel') + '">' + tx('editor.zoneChange') + '</button>'
      + '<div class="menu zone-menu" id="zoneMenu" role="menu" aria-label="' + tx('editor.timeZone') + '" hidden>' + zoneMenuItems(viewer || zone, at, zone) + '</div></div></div>'
      + '<input type="hidden" id="timeZone" value="' + esc(zone) + '"><div class="error" id="timeZoneError" role="alert"></div>';
    return h + '</div>';
  }

  // "Other time zones…": every zone, searched, in a sheet over the page
  // (filled in by the page's script). At the form's level, outside the
  // event card, so it covers the whole screen.
  function zoneSheet() {
    return '<div class="zone-backdrop" id="zoneBackdrop" hidden></div><div class="zone-panel" id="zonePanel" role="dialog" aria-modal="true" aria-label="' + tx('editor.timeZone') + '" hidden>'
      + '<div class="zone-search-row"><input type="search" id="zoneSearch" placeholder="' + tx('editor.zoneSearch') + '" aria-label="' + tx('editor.zoneSearch') + '" aria-controls="zoneList" autocomplete="off" autocapitalize="off" spellcheck="false">'
      + '<button type="button" class="round-btn" data-action="zone-close" aria-label="' + tx('editor.zoneClose') + '">' + ICON_CLOSE + '</button></div>'
      + '<ul class="zone-list" id="zoneList"></ul><p class="zone-none hidden" id="zoneNoMatch">' + tx('editor.zoneNoMatch') + '</p></div>';
  }

  // Plus-ones a host may allow: the same as lib/eventInput.js's
  // MAX_GUESTS_ALLOWED (a test holds them together).
  const MAX_GUESTS_ALLOWED = 10;

  // A field with a short visible label, and its error under it.
  function field(id, labelKey, control) {
    return '<div class="field"><label class="field-label" for="' + id + '">' + tx(labelKey) + '</label>' + control
      + '<div class="error" id="' + id + 'Error" role="alert"></div></div>';
  }

  // The event's colour: a slider from grey round the wheel (dragging it
  // repaints this page, views/editor.html), sitting on Canopy green's hue
  // for a new event. "Match photo" sets it to the cover's hue (or grey),
  // and is there only once there's a photo to match.
  function themeField(e) {
    const key = themeKeyOf(e);
    const hasMatch = e.coverGrayscale || isHue(e.coverHue);
    return '<div class="field" id="themeField"><label class="field-label" for="themeHue">' + tx('editor.theme') + '</label>'
      + '<div class="hue-row"><input type="range" id="themeHue" min="0" max="' + SLIDER_MAX + '" step="1" value="' + sliderOf(key) + '"'
      + ' style="--track:' + esc(hueTrack()) + '" aria-valuetext="' + esc(themeWords(key)) + '">'
      + '<button type="button" class="secondary small-btn" id="themeMatch" data-action="theme-match"' + (hasMatch ? '' : ' hidden') + '>' + tx('editor.themeMatch') + '</button></div>'
      + '<div class="error" id="themeHueError" role="alert"></div></div>';
  }

  // The slider's position, said aloud.
  function themeWords(key) {
    if (key === GREY) return t('editor.themeGrey');
    return isHue(key) ? key + '°' : t('editor.themeDefault');
  }

  // The form for making an event (d.event null) or editing one. `o` is {
  // zone (a new event's: the viewer's), viewerZone (for the zone menu's
  // nearby list) }.
  function editorForm(d, o) {
    o = o || {};
    const e = d.event || {};
    const zone = e.timeZone || o.zone || 'UTC';
    const vis = e.guestListVisibility || 'everyone';
    let h = '<form class="stack editor" id="eventForm" novalidate>';
    h += '<h1 class="sr-only">' + tx(d.event ? 'editor.editHeading' : 'editor.newHeading') + '</h1>';

    // The event card, as the page draws it.
    h += '<section class="event-head editor-head' + (coverUrl(e) ? ' has-cover' : '') + '" id="details">';
    h += coverHero(e);
    h += '<div class="head-text"><div class="error" id="coverError" role="alert"></div>'
      + '<label class="sr-only" for="title">' + tx('editor.title') + '</label>'
      + '<textarea id="title" class="event-title title-input" rows="1" maxlength="120" required placeholder="' + tx('editor.titlePlaceholder') + '">' + esc(e.title || '') + '</textarea>'
      + '<div class="error" id="titleError" role="alert"></div>'
      + whenEditor(e, zone, o.viewerZone) + '</div>';
    h += '<div class="details-card">';
    h += '<div class="meta where">' + ICON.where + '<div class="what">'
      + '<label class="sr-only" for="locationName">' + tx('editor.locationName') + '</label>'
      + '<input type="text" id="locationName" class="soft place-input" maxlength="200" placeholder="' + tx('editor.locationNamePlaceholder') + '" value="' + esc(e.locationName || '') + '">'
      + '<div class="error" id="locationNameError" role="alert"></div>'
      + '<label class="sr-only" for="locationAddress">' + tx('editor.locationAddress') + '</label>'
      + '<textarea id="locationAddress" class="soft address-input" maxlength="500" rows="2" placeholder="' + tx('editor.locationAddressPlaceholder') + '">' + esc(e.locationAddress || '') + '</textarea>'
      + '<div class="error" id="locationAddressError" role="alert"></div></div></div>';
    h += '<div class="description-edit"><label class="sr-only" for="description">' + tx('editor.description') + '</label>'
      + '<textarea id="description" class="soft" maxlength="5000" rows="4" placeholder="' + tx('editor.descriptionPlaceholder') + '">' + esc(e.description || '') + '</textarea>'
      + '<div class="error" id="descriptionError" role="alert"></div></div>';
    h += '</div></section>';

    // Who's coming: who sees the list, plus-ones and capacity.
    h += '<section class="card editor-card" id="guestSettings"><h2 class="card-heading">' + tx('editor.guests') + '</h2>';
    h += '<div class="field" id="visibilityField" role="radiogroup" aria-labelledby="visibilityLabel"><span class="field-label" id="visibilityLabel">' + tx('editor.guestList') + '</span>';
    ['everyone', 'responded'].forEach((v) => {
      h += '<label class="choice"><input type="radio" name="guestListVisibility" value="' + v + '"' + (vis === v ? ' checked' : '') + '><span>' + tx('editor.' + v) + '</span></label>';
    });
    h += '<div class="error" id="guestListVisibilityError" role="alert"></div></div>';
    const allowed = e.guestsAllowed || 0;
    let options = '';
    for (let n = 0; n <= MAX_GUESTS_ALLOWED; n++) {
      options += '<option value="' + n + '"' + (n === allowed ? ' selected' : '') + '>' + (n ? n : tx('editor.noGuests')) + '</option>';
    }
    h += '<div class="field-row">';
    h += field('guestsAllowed', 'editor.guestsAllowed', '<select id="guestsAllowed">' + options + '</select>');
    h += field('capacity', 'editor.capacity', '<input type="number" id="capacity" inputmode="numeric" min="1" max="10000" step="1" placeholder="' + tx('editor.capacityPlaceholder') + '" value="' + esc(e.capacity == null ? '' : e.capacity) + '">');
    h += '</div></section>';

    h += '<section class="card editor-card" id="colour">' + themeField(e) + '</section>';

    // Save, always in reach.
    h += '<div class="save-bar"><div class="error" id="formError" role="alert"></div><div class="form-buttons">'
      + (d.event ? '<a class="button secondary" href="/e/' + esc(e.id) + '">Back</a>' : '')
      + '<button type="submit" id="saveBtn">' + (d.event ? 'Save' : 'Create event') + '</button></div></div>';
    h += zoneSheet();
    h += '</form>';
    return h;
  }

  return {
    esc, tx, txStrong, localInput, fromLocalInput, editorForm, safeUrl, fmt, when, whenShort, whenPreview, whenHead, whenRow, relativeWhen, phaseOf, zoneAbbr, zoneCity, sameClock,
    zoneName, zoneOffset, offsetWords, nearbyZones, allZones, MAIN_ZONES, zoneMenuItems, zoneRow, dayWords, clockWords, endWords,
    fullName, initials, avatar, personRow, coverUrl, coverSrcset, coverSizes, coverImg, coverArt, coverArtStyle, plusGuests, themeStyle, themeColors, themeKeyOf, themeWords, turnHex, isHue, hueFromPixels, sliderOf, keyOfSlider, THEME_DEFAULT_HUE, SLIDER_GREY, SLIDER_MAX, spotsLine, countsLine, guestsShown,
    eventPage, details, rsvpSection, hostSection, friendsGoingSection, guestsSection, attendSummary, attendPeople, attendRow, ATTEND_SLOTS, signedOutSection, wallSection, wallEntry, wallSentence, ago,
    eventRow, homeLists, homeList, friendRows, friendSub, friendsPage, friendLinkPage, friendFound, inviteRow, invitePage, lookupResult, cohostRow, cohostPage,
    ASSUMED_LENGTH_MS, HOME_LISTS, MAX_GUESTS_ALLOWED
  };
});
