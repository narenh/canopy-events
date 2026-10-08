#!/usr/bin/env node
// Fills real events with test guests, and takes them off again.
//
// Test people are made-up Canopy Accounts the account service's admin
// creates (Account Manager > People > Test people), and "Get tokens" there
// downloads canopy-test-tokens.json: a signed-in bearer token for each.
// This script acts as each of them through the ordinary API, so what it
// makes is exactly what real guests would make. See "Seeding test guests"
// in the README for the steps, and docs/decision-log.md ("Test people and
// seeding") for the calls made here.
//
//   node scripts/seed-guests.js friends --tokens canopy-test-tokens.json --friend-link <your friend link> [--photos] [--history <n>]
//   node scripts/seed-guests.js seed    --tokens canopy-test-tokens.json --event <link or id> [--event ...] [--friend-link <link>] [--updates]
//   node scripts/seed-guests.js cleanup --tokens canopy-test-tokens.json [--event <link or id> ...]
//
// Plain Node 22 (fetch, FormData), no dependencies. Bearer tokens, so the
// Origin check doesn't apply. A few requests at a time with a short pause
// after each, and a 429 is waited out.

'use strict';

const fs = require('fs');
const path = require('path');

const USAGE = `Usage:
  node scripts/seed-guests.js friends --tokens <file> [--friend-link <link>] [--photos] [--history <n>]
  node scripts/seed-guests.js seed    --tokens <file> --event <link or id> [--event ...] [--friend-link <link>] [--updates] [--answers <n>]
  node scripts/seed-guests.js cleanup --tokens <file> [--event <link or id> ...]

Options:
  --tokens <file>        the file "Get tokens" downloads (canopy-test-tokens.json)
  --event <link or id>   an event to fill (seed), or to also clean up (cleanup); repeatable
  --friend-link <link>   your friend link (events: Friends > your link); every test person says yes to it
  --updates              (seed) a few test people post a short update on each event
  --answers <n>          (seed) how many test people answer each event (default: 60 to 85% of them)
  --photos               (friends, seed) give test people without a photo an avatar
  --history <n>          (friends) make n past events, hosted by test people, with other test people there (at most 20)
  --base <url>           the events site (default https://events.canopysf.com, or an event link's own site)
  --account-url <url>    the account service, for --photos (default https://account.canopysf.com)
  --avatar-url <url>     where avatars come from, {id} for the person's id (default https://i.pravatar.cc/400?u={id})
  --state <file>         where the events this touched are remembered, for cleanup (default: next to the tokens file)
  --concurrency <n>      requests at once (default 3)
  --delay <ms>           pause after each request (default 150)
  --dry-run              read, but change nothing: print what it would do`;

const DEFAULT_BASE = 'https://events.canopysf.com';
const DEFAULT_ACCOUNT = 'https://account.canopysf.com';
const DEFAULT_AVATAR = 'https://i.pravatar.cc/400?u={id}';
const EVENT_ID_RE = /^[0-9A-Za-z]{12}$/;
const FRIEND_CODE_RE = /^[0-9A-Za-z]{12}$/;
// An event with no end time is over this long after it starts (lib/rules.js).
const OVER_AFTER_MS = 6 * 60 * 60 * 1000;
// At most this many test people's updates on one event, however many
// times the script runs.
const UPDATES_PER_EVENT = 4;
const MAX_HISTORY = 20;

// Short, friendly, about nothing in particular: they read as a guest's
// note on any event.
const UPDATES = [
  "Can't wait!",
  'See everyone there!',
  'So excited for this.',
  "Who's bringing snacks? Happy to grab some.",
  'Anyone want to carpool? I have room for two.',
  "First time coming, can't wait to meet everyone.",
  'Is there anything I should bring?',
  'Might be ten minutes late, save me a spot!',
  'This is going to be so much fun.',
  "I'll bring something to share.",
  'Counting down the days!',
  'Thanks for putting this together!'
];

// Titles for the past events --history makes.
const HISTORY_TITLES = [
  'Dumpling night', 'Sunday hike', 'Board game night', 'Birthday drinks', 'Picnic in the park',
  'Movie night', 'Taco Tuesday', 'Book club', 'Rooftop sunset', 'Brunch', 'Karaoke night',
  'Beach bonfire', 'Potluck dinner', 'Trivia night', 'Farmers market morning', 'Housewarming',
  'Pizza and a movie', 'Climbing session', 'Wine and cheese', 'Game day'
];

// ---------------- Arguments ----------------

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = {
    command, events: [], tokens: null, friendLink: null, updates: false, photos: false, history: 0, answers: null,
    base: null, accountUrl: DEFAULT_ACCOUNT, avatarUrl: DEFAULT_AVATAR, state: null, concurrency: 3, delay: 150, dryRun: false
  };
  const value = (i, name) => {
    if (i >= rest.length || String(rest[i]).startsWith('--')) throw new Error(`${name} needs a value`);
    return rest[i];
  };
  const count = (v, name, min, max) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} is a whole number from ${min} to ${max}`);
    return n;
  };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    switch (arg) {
      case '--tokens': opts.tokens = value(++i, arg); break;
      case '--event': opts.events.push(value(++i, arg)); break;
      case '--friend-link': opts.friendLink = value(++i, arg); break;
      case '--updates': opts.updates = true; break;
      case '--photos': opts.photos = true; break;
      case '--history': opts.history = count(value(++i, arg), arg, 0, MAX_HISTORY); break;
      case '--answers': opts.answers = count(value(++i, arg), arg, 0, 10000); break;
      case '--base': opts.base = value(++i, arg).replace(/\/+$/, ''); break;
      case '--account-url': opts.accountUrl = value(++i, arg).replace(/\/+$/, ''); break;
      case '--avatar-url': opts.avatarUrl = value(++i, arg); break;
      case '--state': opts.state = value(++i, arg); break;
      case '--concurrency': opts.concurrency = count(value(++i, arg), arg, 1, 10); break;
      case '--delay': opts.delay = count(value(++i, arg), arg, 0, 60000); break;
      case '--dry-run': opts.dryRun = true; break;
      case '--help': case '-h': opts.command = 'help'; break;
      default: throw new Error(`unknown option ${arg}`);
    }
  }
  return opts;
}

// An event id from its link (https://events.canopysf.com/e/<id>) or the
// id itself; and the link's own site, if it was a link.
function parseEvent(raw) {
  const s = String(raw).trim();
  if (EVENT_ID_RE.test(s)) return { id: s, origin: null };
  try {
    const u = new URL(s);
    const m = /\/e\/([0-9A-Za-z]{12})(?:\/|$)/.exec(u.pathname);
    if (m) return { id: m[1], origin: u.origin };
  } catch (e) {}
  throw new Error(`${raw} isn't an event link or id`);
}

function parseFriendLink(raw) {
  const s = String(raw).trim();
  if (FRIEND_CODE_RE.test(s)) return { code: s, origin: null };
  try {
    const u = new URL(s);
    const m = /\/f\/([0-9A-Za-z]{12})(?:\/|$)/.exec(u.pathname);
    if (m) return { code: m[1], origin: u.origin };
  } catch (e) {}
  throw new Error(`${raw} isn't a friend link`);
}

// The test people from the tokens file: { people: [{ id, firstName,
// lastName, token }] }, as the Account Manager downloads it (a bare list
// is fine too).
function readTokens(file) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`couldn't read ${file}: ${e.message}`);
  }
  const people = Array.isArray(data) ? data : data && data.people;
  if (!Array.isArray(people) || !people.length) throw new Error(`${file} has no test people in it`);
  for (const p of people) {
    if (!p || typeof p.id !== 'string' || typeof p.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(p.token)) {
      throw new Error(`${file} isn't a tokens file from the Account Manager's "Get tokens"`);
    }
  }
  return people.map((p) => ({ id: p.id, token: p.token, name: `${p.firstName || ''} ${p.lastName || ''}`.trim() || p.id }));
}

function statePathFor(opts) {
  if (opts.state) return opts.state;
  const parsed = path.parse(opts.tokens);
  return path.join(parsed.dir, `${parsed.name}.state.json`);
}

function readState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { events: Array.isArray(s.events) ? s.events : [], history: Array.isArray(s.history) ? s.history : [] };
  } catch (e) {
    return { events: [], history: [] };
  }
}

// ---------------- Helpers ----------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const between = (lo, hi) => lo + Math.random() * (hi - lo);
const randomInt = (lo, hi) => Math.floor(between(lo, hi + 1));

// fn over items, `limit` at a time, results in order.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Requests to one site as one of the test people: { status, data }.
// Changes are only printed on a dry run. A 429 is waited out (its
// Retry-After, or longer each time), a dropped connection retried.
function makeClient({ base, delay, dryRun, log }) {
  async function request(token, method, url, { body, form, absolute = false } = {}) {
    const write = method !== 'GET';
    const target = absolute ? url : `${base}/api/v1${url}`;
    if (write && dryRun) {
      log(`  [dry run] ${method} ${target.replace(base, '')}${body ? ' ' + JSON.stringify(body) : ''}`);
      return { status: 0, data: null, dry: true };
    }
    let wait = 5000;
    for (let attempt = 0; ; attempt++) {
      const headers = { Accept: 'application/json', Authorization: `Bearer ${token}` };
      let payload;
      if (form) payload = form;
      else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
      let res;
      try {
        res = await fetch(target, { method, headers, body: payload });
      } catch (e) {
        if (attempt >= 3) throw new Error(`${method} ${target} failed: ${e.message}`);
        await sleep(1000 * (attempt + 1));
        continue;
      }
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch (e) {}
      if (delay) await sleep(delay);
      if (res.status === 429 && attempt < 8) {
        const after = Number(res.headers.get('retry-after'));
        const ms = Number.isFinite(after) && after > 0 ? after * 1000 : wait;
        log(`  rate limited on ${method} ${target.replace(base, '')}; waiting ${Math.round(ms / 1000)}s`);
        await sleep(ms);
        wait = Math.min(wait * 2, 60000);
        continue;
      }
      return { status: res.status, data, text };
    }
  }

  // Every item of a paged list (`key` names the array).
  async function all(token, url, key) {
    const items = [];
    let cursor = null;
    for (let page = 0; page < 100; page++) {
      const sep = url.includes('?') ? '&' : '?';
      const r = await request(token, 'GET', `${url}${sep}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      if (r.status !== 200) break;
      items.push(...(r.data[key] || []));
      cursor = r.data.nextCursor;
      if (!cursor) break;
    }
    return items;
  }

  return { request, all };
}

function isOver(event, now = Date.now()) {
  const end = event.endsAt ? Date.parse(event.endsAt) : Date.parse(event.startsAt) + OVER_AFTER_MS;
  return end <= now;
}

const describe = (e) => `"${e.title}" (${e.id})`;

// ---------------- Friend link ----------------

// Every test person says yes to the owner's link, so they're in each
// other's lists (a link works both ways).
async function acceptFriendLink(ctx, rawLink) {
  const { client, people, opts, log } = ctx;
  const { code } = parseFriendLink(rawLink);
  const owner = await client.request(people[0].token, 'GET', `/friend-links/${code}`);
  if (owner.status !== 200) throw new Error(`that friend link doesn't work (${owner.status} ${owner.data && owner.data.reason})`);
  const ownerName = `${owner.data.person.firstName} ${owner.data.person.lastName}`;
  log(`Friend link: ${ownerName}'s. Every test person says yes to it.`);
  const tally = { added: 0, already: 0, own: 0, failed: 0 };
  await mapLimit(people, opts.concurrency, async (p) => {
    const seen = await client.request(p.token, 'GET', `/friend-links/${code}`);
    if (seen.status === 200 && seen.data.viewer && seen.data.viewer.isYou) { tally.own++; return; }
    if (seen.status === 200 && seen.data.viewer && seen.data.viewer.isFriend) { tally.already++; return; }
    const r = await client.request(p.token, 'POST', `/friend-links/${code}/accept`);
    if (r.dry || r.status === 200) tally.added++;
    else { tally.failed++; log(`  ${p.name} couldn't: ${r.status} ${r.data && r.data.reason}`); }
  });
  log(`  ${tally.added} ${opts.dryRun ? 'would say yes' : 'said yes'}, ${tally.already} already friends${tally.failed ? `, ${tally.failed} failed` : ''}.`);
  return { owner: ownerName, ...tally };
}

// ---------------- Photos ----------------

// An avatar for each test person who has no photo: a JPEG from the avatar
// service, uploaded to their Canopy Account the way an app uploads one. If
// either service can't be reached, no photos, and nothing else changes.
async function givePhotos(ctx) {
  const { people, opts, log } = ctx;
  const account = makeClient({ base: opts.accountUrl, delay: opts.delay, dryRun: opts.dryRun, log });
  const nativeMe = `${opts.accountUrl}/api/native/v1/me`;
  log(`Photos: from ${opts.avatarUrl.replace('{id}', '<id>')}, uploaded to ${opts.accountUrl}.`);
  try {
    const first = await account.request(people[0].token, 'GET', nativeMe, { absolute: true });
    if (first.status !== 200) {
      log(`  skipped: the account service answered ${first.status} (${(first.data && first.data.reason) || 'no reason'}).`);
      return { given: 0, had: 0, skipped: people.length };
    }
  } catch (e) {
    log(`  skipped: couldn't reach the account service (${e.message}).`);
    return { given: 0, had: 0, skipped: people.length };
  }
  const tally = { given: 0, had: 0, skipped: 0 };
  let avatarsDown = false;
  await mapLimit(people, opts.concurrency, async (p) => {
    if (avatarsDown) { tally.skipped++; return; }
    const me = await account.request(p.token, 'GET', nativeMe, { absolute: true });
    if (me.status !== 200) { tally.skipped++; return; }
    if (me.data.person && me.data.person.photoUrl) { tally.had++; return; }
    let jpeg;
    try {
      const res = await fetch(opts.avatarUrl.replace('{id}', encodeURIComponent(p.id)), { redirect: 'follow' });
      const buf = Buffer.from(await res.arrayBuffer());
      if (!res.ok || !/^image\/jpe?g/i.test(res.headers.get('content-type') || '') || buf[0] !== 0xff || buf[1] !== 0xd8) {
        throw new Error(`answered ${res.status} ${res.headers.get('content-type') || ''}, not a JPEG`);
      }
      jpeg = buf;
    } catch (e) {
      if (!avatarsDown) log(`  skipped the rest: the avatar service ${e.message}.`);
      avatarsDown = true;
      tally.skipped++;
      return;
    }
    const form = new FormData();
    form.append('photo', new Blob([jpeg], { type: 'image/jpeg' }), 'photo.jpg');
    const r = await account.request(p.token, 'POST', `${nativeMe}/photo`, { form, absolute: true });
    if (r.dry || r.status === 200) tally.given++;
    else { tally.skipped++; log(`  ${p.name}'s photo wasn't taken: ${r.status} ${r.data && r.data.reason}`); }
  });
  log(`  ${tally.given} ${opts.dryRun ? 'would get' : 'got'} a photo, ${tally.had} had one${tally.skipped ? `, ${tally.skipped} skipped` : ''}.`);
  return tally;
}

// ---------------- History ----------------

// `n` past events, each hosted by a test person with a handful of other
// test people going, on different days over the last few months: events
// in common, and a "last together", among the test people. Made the only
// way the API allows (an event that's over takes no answers): it starts
// in the past and ends in a few minutes, everyone answers, then the host
// moves its end back to a few hours after the start, which makes it over.
async function makeHistory(ctx, n, state) {
  const { client, people, opts, log } = ctx;
  if (people.length < 3) { log('History: needs at least 3 test people; skipped.'); return []; }
  log(`History: ${n} past event(s) among the test people.`);
  const titles = shuffle(HISTORY_TITLES);
  const made = [];
  for (let i = 0; i < n; i++) {
    const [host, ...others] = shuffle(people);
    const daysAgo = randomInt(5, 150);
    const start = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    start.setUTCHours(randomInt(1, 4), [0, 30][randomInt(0, 1)], 0, 0);
    const title = titles[i % titles.length];
    const going = others.slice(0, Math.min(others.length, randomInt(3, 10)));
    const maybe = others.slice(going.length, going.length + randomInt(0, 2));
    if (opts.dryRun) {
      log(`  [dry run] ${host.name} hosts "${title}" ${daysAgo} days ago, ${going.length} going, ${maybe.length} maybe`);
      continue;
    }
    const created = await client.request(host.token, 'POST', '/events', {
      body: {
        title, startsAt: start.toISOString(), endsAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        timeZone: 'America/Los_Angeles', description: 'Made by the seeding script (a test event).'
      }
    });
    if (created.status !== 201) { log(`  couldn't make "${title}": ${created.status} ${created.data && created.data.reason}`); continue; }
    const ev = created.data.event;
    state.history.push(ev.id);
    saveState(ctx, state);
    await mapLimit([...going.map((p) => [p, 'going']), ...maybe.map((p) => [p, 'maybe'])], opts.concurrency, ([p, status]) => (
      client.request(p.token, 'PUT', `/events/${ev.id}/rsvp`, { body: { status } })
    ));
    const ended = await client.request(host.token, 'PATCH', `/events/${ev.id}`, {
      body: { endsAt: new Date(start.getTime() + 3 * 60 * 60 * 1000).toISOString() }
    });
    if (ended.status !== 200) log(`  couldn't end "${title}": ${ended.status} ${ended.data && ended.data.reason}`);
    made.push(ev.id);
    log(`  ${host.name} hosted "${title}" ${daysAgo} days ago: ${going.length} going, ${maybe.length} maybe.`);
  }
  return made;
}

// ---------------- Seeding an event ----------------

// How many of each answer, for `n` people: mostly going, some maybe, a few
// can't go (at least one each once there are enough).
function answerMix(n) {
  let going = Math.round(n * between(0.6, 0.72));
  let maybe = Math.round(n * between(0.14, 0.24));
  if (n >= 5) going = Math.min(going, n - 1);
  if (going + maybe > n) maybe = n - going;
  if (n >= 5 && going + maybe === n && maybe > 0) maybe--;
  return { going, maybe, notGoing: n - going - maybe };
}

async function seedEvent(ctx, raw, state) {
  const { client, people, opts, log } = ctx;
  const { id } = parseEvent(raw);
  const first = await client.request(people[0].token, 'GET', `/events/${id}`);
  if (first.status !== 200) {
    log(`Event ${id}: skipped (${first.status} ${(first.data && first.data.reason) || ''}).`);
    return { id, skipped: true };
  }
  const event = first.data.event;
  if (event.status === 'cancelled') { log(`${describe(event)}: skipped, it's cancelled.`); return { id, skipped: true }; }
  if (isOver(event)) { log(`${describe(event)}: skipped, it's over.`); return { id, skipped: true }; }
  if (!state.events.includes(event.id)) { state.events.push(event.id); saveState(ctx, state); }

  // Where each test person stands on it now.
  const standing = await mapLimit(people, opts.concurrency, async (p) => {
    const r = await client.request(p.token, 'GET', `/events/${event.id}`);
    const viewer = r.status === 200 ? r.data.event.viewer : null;
    return { p, role: viewer && viewer.role, rsvp: viewer && viewer.rsvp };
  });
  const hosts = standing.filter((s) => s.role);
  const answered = standing.filter((s) => !s.role && s.rsvp && ['going', 'maybe', 'not_going', 'waitlisted'].includes(s.rsvp.status));
  const removed = standing.filter((s) => s.rsvp && s.rsvp.status === 'removed');
  const free = shuffle(standing.filter((s) => !s.role && (!s.rsvp || s.rsvp.status === 'invited')));

  // How many test people answer in all, counting those who already have:
  // re-running tops up to it rather than adding more each time.
  const eligible = people.length - hosts.length - removed.length;
  const target = Math.min(eligible, opts.answers != null ? opts.answers : Math.round(eligible * between(0.6, 0.85)));
  const newcomers = free.slice(0, Math.max(0, target - answered.length));
  const mix = answerMix(newcomers.length);
  const statuses = [
    ...Array(mix.going).fill('going'), ...Array(mix.maybe).fill('maybe'), ...Array(mix.notGoing).fill('not_going')
  ];
  // Plus-ones, when the event takes them: about a quarter of those coming
  // bring one (now and then two), at least one person when anyone's coming.
  const coming = statuses.filter((s) => s !== 'not_going').length;
  const bringing = event.guestsAllowed > 0 && coming ? Math.max(1, Math.round(coming * between(0.18, 0.3))) : 0;
  const plans = newcomers.map((s, i) => ({ p: s.p, status: statuses[i], guests: 0 }));
  shuffle(plans.filter((x) => x.status !== 'not_going')).slice(0, bringing).forEach((x) => {
    x.guests = event.guestsAllowed >= 2 && Math.random() < 0.2 ? 2 : 1;
  });

  const tally = { going: 0, waitlisted: 0, maybe: 0, notGoing: 0, guests: 0, failed: 0 };
  await mapLimit(plans, opts.concurrency, async (plan) => {
    const body = { status: plan.status, ...(plan.guests ? { guests: plan.guests } : {}) };
    let r = await client.request(plan.p.token, 'PUT', `/events/${event.id}/rsvp`, { body });
    if (r.status === 409 && r.data && r.data.reason === 'no_room') {
      r = await client.request(plan.p.token, 'PUT', `/events/${event.id}/rsvp`, { body: { status: plan.status } });
      plan.guests = 0;
    }
    if (!r.dry && r.status !== 200) {
      tally.failed++;
      log(`  ${plan.p.name} couldn't answer: ${r.status} ${r.data && r.data.reason}`);
      return;
    }
    plan.waitlisted = !!(r.data && r.data.waitlisted);
    plan.done = true;
    if (plan.status === 'going') tally[plan.waitlisted ? 'waitlisted' : 'going']++;
    else if (plan.status === 'maybe') tally.maybe++;
    else tally.notGoing++;
    tally.guests += plan.guests;
  });

  // Updates: a few of those coming each post one line, at most
  // UPDATES_PER_EVENT from test people on the event however often this
  // runs, and never two from one person.
  let posted = 0;
  if (opts.updates) {
    const canPost = [
      ...answered.filter((s) => s.rsvp.status !== 'not_going').map((s) => s.p),
      ...plans.filter((x) => x.done && x.status !== 'not_going').map((x) => x.p)
    ];
    const ids = new Set(people.map((p) => p.id));
    const reader = canPost[0];
    let already = [];
    if (reader && !opts.dryRun) {
      already = (await client.all(reader.token, `/events/${event.id}/wall`, 'entries'))
        .filter((w) => w.type === 'post' && w.person && ids.has(w.person.id));
    }
    const postedBy = new Set(already.map((w) => w.person.id));
    const usedLines = new Set(already.map((w) => w.text));
    const room = Math.max(0, Math.min(UPDATES_PER_EVENT - already.length, randomInt(2, UPDATES_PER_EVENT)));
    const posters = shuffle(canPost.filter((p) => !postedBy.has(p.id))).slice(0, room);
    const lines = shuffle(UPDATES.filter((l) => !usedLines.has(l)));
    for (const [i, p] of posters.entries()) {
      if (!lines[i]) break;
      const r = await client.request(p.token, 'POST', `/events/${event.id}/wall`, { body: { text: lines[i] } });
      if (r.dry || r.status === 201) posted++;
      else log(`  ${p.name} couldn't post: ${r.status} ${r.data && r.data.reason}`);
    }
  }

  const verb = opts.dryRun ? 'would answer' : 'answered';
  log(`${describe(event)}: ${newcomers.length} ${verb} (${tally.going} going${tally.waitlisted ? `, ${tally.waitlisted} on the waitlist` : ''}, `
    + `${tally.maybe} maybe, ${tally.notGoing} can't go, ${tally.guests} plus-one(s))`
    + `${answered.length ? `; ${answered.length} had already` : ''}${hosts.length ? `; ${hosts.length} hosting` : ''}`
    + `${opts.updates ? `; ${posted} update(s)` : ''}${tally.failed ? `; ${tally.failed} failed` : ''}.`);
  return { id: event.id, title: event.title, newcomers: newcomers.length, ...tally, already: answered.length, posted };
}

// ---------------- Cleanup ----------------

// One test person off everything: their updates deleted, off every event
// they're on (an event they made is deleted; a co-host steps down first),
// and everyone out of their friends list.
async function cleanPerson(ctx, p, extraIds) {
  const { client, log } = ctx;
  const tally = { left: 0, deletedEvents: 0, posts: 0, friends: 0 };
  const listed = [];
  for (const list of ['all', 'past', 'declined']) {
    listed.push(...(await client.all(p.token, `/me/events/${list}`, 'events')).map((e) => e.id));
  }
  const ids = [...new Set([...listed, ...extraIds])];
  for (const id of ids) {
    const r = await client.request(p.token, 'GET', `/events/${id}`);
    if (r.status !== 200 || !r.data.event.viewer) continue;
    const { viewer } = r.data.event;
    if (viewer.role === 'creator') {
      const d = await client.request(p.token, 'DELETE', `/events/${id}`);
      if (d.dry || d.status === 200) tally.deletedEvents++;
      continue;
    }
    if (viewer.role === 'cohost') await client.request(p.token, 'DELETE', `/events/${id}/cohosts/${p.id}`);
    // Their own updates, while they can still read the wall.
    const wall = await client.all(p.token, `/events/${id}/wall`, 'entries');
    for (const w of wall.filter((x) => x.type === 'post' && x.person && x.person.id === p.id)) {
      const d = await client.request(p.token, 'DELETE', `/events/${id}/wall/${w.id}`);
      if (d.dry || d.status === 200) tally.posts++;
    }
    if (viewer.role === 'cohost' || (viewer.rsvp && viewer.rsvp.status !== 'removed')) {
      const l = await client.request(p.token, 'POST', `/events/${id}/leave`);
      if (l.dry || l.status === 200) tally.left++;
      else if (l.status !== 409) log(`  ${p.name} couldn't leave ${id}: ${l.status} ${l.data && l.data.reason}`);
    }
  }
  for (const f of await client.all(p.token, '/me/friends', 'friends')) {
    const d = await client.request(p.token, 'DELETE', `/me/friends/${f.person.id}`);
    if (d.dry || d.status === 200) tally.friends++;
  }
  return tally;
}

// ---------------- Commands ----------------

function saveState(ctx, state) {
  if (ctx.opts.dryRun) return;
  fs.writeFileSync(ctx.statePath, JSON.stringify(state, null, 2) + '\n');
}

async function run(argv, { log = console.log } = {}) {
  const opts = parseArgs(argv);
  if (!opts.command || opts.command === 'help') { log(USAGE); return 0; }
  if (!['seed', 'friends', 'cleanup'].includes(opts.command)) throw new Error(`unknown command ${opts.command}\n\n${USAGE}`);
  if (!opts.tokens) throw new Error(`--tokens is needed\n\n${USAGE}`);
  const events = opts.events.map(parseEvent);
  // The site: --base, or the first link's own site, or Canopy's.
  const linkOrigin = (events.find((e) => e.origin) || {}).origin
    || (opts.friendLink && (() => { try { return parseFriendLink(opts.friendLink).origin; } catch (e) { return null; } })());
  opts.base = opts.base || linkOrigin || DEFAULT_BASE;
  const people = readTokens(opts.tokens);
  const statePath = statePathFor(opts);
  const state = readState(statePath);
  const client = makeClient({ base: opts.base, delay: opts.delay, dryRun: opts.dryRun, log });
  const ctx = { client, people, opts, log, statePath };
  log(`${people.length} test people, on ${opts.base}${opts.dryRun ? ' (dry run: nothing will change)' : ''}.`);

  if (opts.command === 'friends') {
    if (!opts.friendLink && !opts.photos && !opts.history) throw new Error(`friends needs --friend-link, --photos or --history\n\n${USAGE}`);
    if (opts.friendLink) await acceptFriendLink(ctx, opts.friendLink);
    if (opts.photos) await givePhotos(ctx);
    if (opts.history) await makeHistory(ctx, opts.history, state);
    log('\nDone. Your friends list and invite picker have them now (a photo can take a minute to show).');
    log(`Later: node scripts/seed-guests.js cleanup --tokens ${opts.tokens}`);
    return 0;
  }

  if (opts.command === 'seed') {
    if (!events.length) throw new Error(`seed needs at least one --event\n\n${USAGE}`);
    if (opts.friendLink) await acceptFriendLink(ctx, opts.friendLink);
    if (opts.photos) await givePhotos(ctx);
    const results = [];
    for (const e of opts.events) results.push(await seedEvent(ctx, e, state));
    const done = results.filter((r) => !r.skipped);
    const sum = (k) => done.reduce((n, r) => n + (r[k] || 0), 0);
    log(`\nSummary: ${done.length} event(s) seeded${results.length > done.length ? `, ${results.length - done.length} skipped` : ''}; `
      + `${sum('newcomers')} new answers (${sum('going')} going, ${sum('waitlisted')} waitlisted, ${sum('maybe')} maybe, ${sum('notGoing')} can't go), `
      + `${sum('guests')} plus-ones${opts.updates ? `, ${sum('posted')} updates` : ''}.`);
    log(`Later: node scripts/seed-guests.js cleanup --tokens ${opts.tokens}`);
    return 0;
  }

  // cleanup
  const extra = [...new Set([...state.events, ...state.history, ...events.map((e) => e.id)])];
  log(`Cleaning up: every event each test person is on${extra.length ? ` (and ${extra.length} remembered or named)` : ''}, their updates, and their friends.`);
  const tallies = await mapLimit(people, opts.concurrency, (p) => cleanPerson(ctx, p, extra));
  const sum = (k) => tallies.reduce((n, t) => n + t[k], 0);
  log(`\nSummary${opts.dryRun ? ' (what it would do)' : ''}: left ${sum('left')} event(s), deleted ${sum('posts')} update(s) `
    + `and ${sum('deletedEvents')} event(s) they hosted, and removed ${sum('friends')} friendship(s) from their side.`);
  if (!opts.dryRun) { try { fs.unlinkSync(statePath); } catch (e) {} }
  log('\nNow delete the test people: Account Manager > People > "Delete all test people". That also takes them out of your friends list.');
  return 0;
}

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
    console.error(`seed-guests: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { run, parseArgs, parseEvent, parseFriendLink, answerMix, readTokens };
