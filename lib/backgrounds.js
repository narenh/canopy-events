// Backgrounds: film and TV backdrops a host can choose as an event's
// cover instead of uploading a photo, curated by the owner on TMDB (The
// Movie Database). Choosing one makes it an ordinary cover
// (routes/covers.js downloads it and runs it through the same pipeline as
// an upload); this file is the curated set.
//
// **Where the set comes from**, in this order:
//
//   1. config/backgrounds.json (BACKGROUNDS_FILE overrides the path; set
//      it empty for none): exact backdrops the owner picked by hand on
//      TMDB's website, in the owner's order. Each entry is
//      { type: "movie"|"tv", tmdbId, title, filePath: "/abc123.jpg" }
//      (and optionally year). References only: no image data is in the
//      repo. These need no TMDB_TOKEN: the images are on TMDB's public
//      image CDN, and nothing here asks TMDB's API about them.
//   2. With TMDB_TOKEN (a v4 read-access token) and TMDB_LIST_ID: a TMDB
//      list of films and shows. For each title, up to PER_TITLE of its
//      best textless backdrops (no language: no title text burned in),
//      falling back to the others when it has none.
//
// The same backdrop twice is kept once (the first). With neither source
// the feature is off: the set is empty and the API says `enabled: false`.
//
// **The token never leaves this file.** It's sent to TMDB's API as
// `Authorization: Bearer`, and nowhere else: not in an answer, a page or a
// log line.
//
// **Cached in memory**, loaded at startup and again every REFRESH_MS (a
// day) in the background. A refresh that fails (TMDB down, a title's
// images unreachable) keeps what the last good one had, and tries again
// sooner (RETRY_MS). Each backdrop's thumbnail is fetched once (w300,
// small) to work out its shape and the hue that matches it
// (`hue`/`grayscale`, lib/coverImage.js measureThumb, in the cover
// worker), so the editor and the apps can match the event's colour
// without a canvas; a backdrop whose thumbnail can't be fetched is left
// out until it can.
//
// **No SSRF.** A host chooses by `id`, which has to be in the current set;
// the URL fetched is built here from the set's own file path (checked
// against FILE_PATH_RE whether it came from the manifest or from TMDB)
// and the image CDN's address, never from anything a request sent.
// Redirects are refused.
//
// TMDB_API_BASE and TMDB_IMAGE_BASE (and BACKGROUNDS_REFRESH_MS) point
// this at a fake TMDB for tests and local work. They're ignored with
// NODE_ENV=production.

const fs = require('fs');
const path = require('path');

const DAY = 24 * 60 * 60 * 1000;
const REFRESH_MS = DAY;
const RETRY_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;
const DOWNLOAD_TIMEOUT_MS = 20000;
// How long an answer waits for the very first load, right after a start,
// before saying what there is (possibly nothing yet).
const FIRST_LOAD_WAIT_MS = 5000;
const PER_TITLE = 3;
const MAX_LIST_PAGES = 10;
const MAX_TITLES = 200;
const CONCURRENCY = 4;
const MAX_THUMB_BYTES = 2 * 1024 * 1024;
// The same as an upload's (routes/covers.js MAX_UPLOAD).
const MAX_DOWNLOAD_BYTES = 15 * 1024 * 1024;
// The grid's thumbnail, the hero's preview, and what's downloaded when a
// host chooses one (the original, or the 1280 if that fails).
const THUMB_SIZE = 'w300';
const PREVIEW_SIZE = 'w780';
const DOWNLOAD_SIZES = ['original', 'w1280'];
// A TMDB image's file path: a slash, letters and digits, an image type.
const FILE_PATH_RE = /^\/[A-Za-z0-9]{8,64}\.(?:jpg|jpeg|png|webp)$/;
// A background's id: the file path, base64url.
const ID_RE = /^[A-Za-z0-9_-]{8,120}$/;
const LIST_ID_RE = /^[0-9]{1,12}$/;

const DEFAULT_API_BASE = 'https://api.themoviedb.org';
const DEFAULT_IMAGE_BASE = 'https://image.tmdb.org/t/p';
const DEFAULT_MANIFEST = path.join(__dirname, '..', 'config', 'backgrounds.json');

class BackgroundUnavailable extends Error {}

// The settings, from the environment.
function settingsFrom(env) {
  const production = env.NODE_ENV === 'production';
  const dev = (name) => (!production && env[name] ? String(env[name]) : null);
  return {
    token: String(env.TMDB_TOKEN || '').trim() || null,
    listId: String(env.TMDB_LIST_ID || '').trim() || null,
    manifestFile: env.BACKGROUNDS_FILE !== undefined ? env.BACKGROUNDS_FILE : DEFAULT_MANIFEST,
    apiBase: (dev('TMDB_API_BASE') || DEFAULT_API_BASE).replace(/\/+$/, ''),
    imageBase: (dev('TMDB_IMAGE_BASE') || DEFAULT_IMAGE_BASE).replace(/\/+$/, ''),
    refreshMs: Number(dev('BACKGROUNDS_REFRESH_MS')) || REFRESH_MS
  };
}

// ---------------- The manifest ----------------

// The manifest's entries that are right, and a line about each that
// isn't: { entries: [{ type, tmdbId, title, year, filePath }], problems }.
// Entries of the same title are put together, where its first one is.
function validateManifest(raw) {
  const problems = [];
  if (!Array.isArray(raw)) return { entries: [], problems: ['it should be an array of entries'] };
  const seen = new Set();
  const good = [];
  raw.forEach((e, i) => {
    const where = `entry ${i}`;
    if (!e || typeof e !== 'object' || Array.isArray(e)) return problems.push(`${where}: not an object`);
    if (e.type !== 'movie' && e.type !== 'tv') return problems.push(`${where}: type is "movie" or "tv"`);
    if (!Number.isSafeInteger(e.tmdbId) || e.tmdbId < 1) return problems.push(`${where}: tmdbId is a whole number`);
    if (typeof e.title !== 'string' || !e.title.trim() || e.title.length > 200) return problems.push(`${where}: title is the film's or show's name`);
    if (typeof e.filePath !== 'string' || !FILE_PATH_RE.test(e.filePath)) return problems.push(`${where}: filePath is a TMDB image path, like "/kXfqcdQKsToO0OUXHcrrNCHDBzO.jpg"`);
    if (e.year !== undefined && e.year !== null && !(Number.isInteger(e.year) && e.year >= 1870 && e.year <= 2200)) return problems.push(`${where}: year is a year, or left out`);
    if (seen.has(e.filePath)) return problems.push(`${where}: ${e.filePath} is already in it`);
    seen.add(e.filePath);
    good.push({ type: e.type, tmdbId: e.tmdbId, title: e.title.trim(), year: Number.isInteger(e.year) ? e.year : null, filePath: e.filePath });
  });
  // Each title's entries together, in the order titles first appear.
  const order = [];
  const groups = new Map();
  good.forEach((e) => {
    const key = `${e.type}:${e.tmdbId}`;
    if (!groups.has(key)) { groups.set(key, []); order.push(key); }
    groups.get(key).push(e);
  });
  return { entries: order.flatMap((k) => groups.get(k)), problems };
}

// The manifest's good entries, logging what's wrong with the rest. No
// file is an empty manifest.
function readManifest(file, log) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') log.warn(`[canopy-events] backgrounds: ${path.basename(file)} couldn't be read (${e.code || 'not JSON'}), so it's left out`);
    return [];
  }
  const { entries, problems } = validateManifest(raw);
  problems.forEach((p) => log.warn(`[canopy-events] backgrounds: ${path.basename(file)} ${p}; skipped`));
  return entries;
}

// ---------------- Fetching ----------------

// `items`, `limit` at a time.
async function eachLimited(items, limit, fn) {
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

// The bytes at `url`, at most `max` of them, or a throw. No redirects.
async function fetchBytes(url, { max, timeoutMs }) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  if (!res.ok) throw new Error(`the image CDN answered ${res.status}`);
  if (Number(res.headers.get('content-length')) > max) throw new Error('the image is too big');
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > max) throw new Error('the image is too big');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function idOf(filePath) {
  return Buffer.from(filePath, 'utf8').toString('base64url');
}

function yearOf(date) {
  const m = /^(\d{4})-/.exec(String(date || ''));
  return m ? Number(m[1]) : null;
}

// ---------------- The set ----------------

// `measure(buf)` is { width, height, hue, grayscale } for a thumbnail
// (lib/coverImage.js measureThumb). `log` is console, or a stand-in.
function createBackgrounds({ token = null, listId = null, manifestFile = null, apiBase = DEFAULT_API_BASE, imageBase = DEFAULT_IMAGE_BASE, refreshMs = REFRESH_MS, retryMs = RETRY_MS, measure, log = console } = {}) {
  const manifest = manifestFile ? readManifest(manifestFile, log) : [];
  if (listId && !LIST_ID_RE.test(listId)) {
    log.warn('[canopy-events] backgrounds: TMDB_LIST_ID is a list\'s number (the digits in its address on themoviedb.org); ignored');
    listId = null;
  }
  if (listId && !token) log.warn('[canopy-events] backgrounds: TMDB_LIST_ID is set without TMDB_TOKEN, so the list is left out');
  const useList = !!(token && listId);
  const configured = manifest.length > 0 || useList;

  let items = [];
  let byId = new Map();
  // The list's backdrops from the last time it loaded, kept when it can't.
  let listBackdrops = null;
  // A title's best backdrops, from the last time they loaded.
  const titleBackdrops = new Map();
  // filePath -> { width, height, hue, grayscale }, from its thumbnail.
  const measured = new Map();
  let loading = null;
  let loaded = false;
  let started = false;
  let timer = null;

  // GET from TMDB's API, as JSON. Errors say the path, never the token.
  async function tmdb(pathAndQuery) {
    const res = await fetch(apiBase + pathAndQuery, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'error'
    });
    if (!res.ok) throw new Error(`TMDB answered ${res.status} for ${pathAndQuery.split('?')[0]}`);
    return res.json();
  }

  // The list's titles, in its order: [{ type, id, title, year }].
  async function loadList() {
    const titles = [];
    let page = 1;
    let pages = 1;
    do {
      const d = await tmdb(`/4/list/${encodeURIComponent(listId)}?page=${page}`);
      pages = Math.min(Number.isInteger(d.total_pages) ? d.total_pages : 1, MAX_LIST_PAGES);
      for (const r of Array.isArray(d.results) ? d.results : []) {
        const type = r && r.media_type;
        if ((type !== 'movie' && type !== 'tv') || !Number.isSafeInteger(r.id)) continue;
        const title = String((type === 'movie' ? r.title : r.name) || r.title || r.name || '').trim().slice(0, 200);
        if (!title) continue;
        titles.push({ type, id: r.id, title, year: yearOf(type === 'movie' ? r.release_date : r.first_air_date) });
      }
      page++;
    } while (page <= pages);
    return titles.slice(0, MAX_TITLES);
  }

  // A title's best backdrops' file paths: textless first (by votes, then
  // width), the others only when it has no textless one.
  async function bestBackdrops(type, id) {
    const pick = (d, textless) => (Array.isArray(d && d.backdrops) ? d.backdrops : [])
      .filter((b) => b && FILE_PATH_RE.test(String(b.file_path)) && (!textless || b.iso_639_1 == null))
      .sort((a, b) => ((Number(b.vote_average) || 0) - (Number(a.vote_average) || 0)) || ((Number(b.width) || 0) - (Number(a.width) || 0)))
      .slice(0, PER_TITLE)
      .map((b) => b.file_path);
    let paths = pick(await tmdb(`/3/${type}/${id}/images?include_image_language=null`), true);
    if (!paths.length) paths = pick(await tmdb(`/3/${type}/${id}/images`), false);
    return paths;
  }

  function imageUrl(size, filePath) {
    return `${imageBase}/${size}${filePath}`;
  }

  // Loads the set again. Answers whether anything failed (so the next try
  // comes sooner); what failed keeps what it had.
  async function refresh() {
    let failed = false;
    const candidates = manifest.map((e) => ({ filePath: e.filePath, title: e.title, year: e.year }));
    if (useList) {
      try {
        const titles = await loadList();
        await eachLimited(titles, CONCURRENCY, async (t) => {
          const key = `${t.type}:${t.id}`;
          try {
            titleBackdrops.set(key, await bestBackdrops(t.type, t.id));
          } catch (e) {
            failed = true;
          }
          t.paths = titleBackdrops.get(key) || [];
        });
        listBackdrops = titles.flatMap((t) => t.paths.map((filePath) => ({ filePath, title: t.title, year: t.year })));
      } catch (e) {
        failed = true;
        log.warn(`[canopy-events] backgrounds: the TMDB list couldn't be loaded (${e.message}); keeping the last one`);
      }
      if (listBackdrops) candidates.push(...listBackdrops);
    }
    const seen = new Set();
    const unique = candidates.filter((c) => !seen.has(c.filePath) && seen.add(c.filePath));
    let unmeasured = 0;
    await eachLimited(unique.filter((c) => !measured.has(c.filePath)), CONCURRENCY, async (c) => {
      try {
        const info = await measure(await fetchBytes(imageUrl(THUMB_SIZE, c.filePath), { max: MAX_THUMB_BYTES, timeoutMs: REQUEST_TIMEOUT_MS }));
        measured.set(c.filePath, { width: info.width, height: info.height, hue: info.hue, grayscale: !!info.grayscale });
      } catch (e) {
        failed = true;
        unmeasured++;
      }
    });
    if (unmeasured) log.warn(`[canopy-events] backgrounds: ${unmeasured} thumbnail(s) couldn't be fetched; left out until they can be`);
    // Forget what's no longer in the set.
    for (const p of measured.keys()) if (!seen.has(p)) measured.delete(p);
    const next = unique.filter((c) => measured.has(c.filePath)).map((c) => ({ ...c, ...measured.get(c.filePath), id: idOf(c.filePath) }));
    items = next;
    byId = new Map(next.map((b) => [b.id, b]));
    return failed;
  }

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(run, ms);
    timer.unref();
  }

  function run() {
    if (loading) return loading;
    loading = refresh()
      .then((failed) => schedule(failed ? Math.min(retryMs, refreshMs) : refreshMs), (err) => {
        log.warn(`[canopy-events] backgrounds: ${err && err.message}`);
        schedule(Math.min(retryMs, refreshMs));
      })
      .finally(() => { loaded = true; loading = null; });
    return loading;
  }

  // Starts loading (once), when there's anything to load.
  function start() {
    if (!configured || started) return;
    started = true;
    run();
  }

  // The set, in order. Waits a little for the first load.
  async function list() {
    if (!configured) return [];
    start();
    if (!loaded && loading) {
      let t;
      await Promise.race([loading, new Promise((resolve) => { t = setTimeout(resolve, FIRST_LOAD_WAIT_MS); t.unref(); })]);
      clearTimeout(t);
    }
    return items;
  }

  // The background with this id in the current set, or null.
  async function find(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return null;
    await list();
    return byId.get(id) || null;
  }

  // A chosen background's image, to make into a cover: the original, or
  // the 1280 if that can't be had. BackgroundUnavailable when neither.
  async function download(item) {
    if (!item || !FILE_PATH_RE.test(item.filePath)) throw new BackgroundUnavailable('not a background');
    for (const size of DOWNLOAD_SIZES) {
      try {
        return await fetchBytes(imageUrl(size, item.filePath), { max: MAX_DOWNLOAD_BYTES, timeoutMs: DOWNLOAD_TIMEOUT_MS });
      } catch (e) {}
    }
    throw new BackgroundUnavailable("that background couldn't be fetched from TMDB");
  }

  // A background as the API shows it.
  function view(b) {
    return {
      id: b.id,
      title: b.title,
      year: b.year,
      thumbUrl: imageUrl(THUMB_SIZE, b.filePath),
      previewUrl: imageUrl(PREVIEW_SIZE, b.filePath),
      width: b.width,
      height: b.height,
      hue: b.hue,
      grayscale: b.grayscale
    };
  }

  return { start, list, find, download, view, configured };
}

module.exports = { createBackgrounds, settingsFrom, validateManifest, readManifest, BackgroundUnavailable, FILE_PATH_RE, PER_TITLE, DEFAULT_MANIFEST };
