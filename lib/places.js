// Places: finding where an event is with Apple Maps (the Maps Server API),
// for the editor's Location field and the apps. routes/places.js is the
// API around it.
//
// **Settings**, all from the environment:
//
//   APPLE_MAPS_TEAM_ID      the Apple Developer team's 10-character id
//   APPLE_MAPS_KEY_ID       the Maps key's 10-character id
//   APPLE_MAPS_PRIVATE_KEY  the key's .p8 file, as text. Coolify's values
//                           are one line, so "\n" escapes are turned back
//                           into line breaks; the BEGIN/END lines may be
//                           left off.
//   APPLE_MAPS_URL          where the Maps Server API is (tests point it at
//                           test/fakeAppleMaps.js); https://maps-api.apple.com
//   PLACES_DEFAULT_NEAR     "lat,lng" to bias suggestions toward when the
//                           caller doesn't say where they are; San Francisco
//
// With any of the first three missing (or a key that doesn't read), places
// are off: `enabled` is false, nothing is asked of Apple, and the field is
// plain text.
//
// **Signing in to Apple** is two steps. A JWT signed with the key (ES256:
// header { alg, kid, typ }, claims { iss: team id, iat, exp, scope:
// "server_api" }, as Apple's "Creating and using tokens with Maps Server
// API" says) is traded at GET /v1/token for an access token that lasts 30
// minutes. That one is kept and used until a minute before it runs out,
// or until Apple answers 401, when it's traded for a new one and the call
// is made once more. The key and both tokens never leave this file: not in
// an answer, a page or a log line.
//
// **What it answers**: autocomplete(q) is Apple's searchAutocomplete,
// mapped to { id, name, address, kind } ('poi' or 'address'), at most
// MAX_RESULTS. An `id` is the suggestion's `completionUrl` (a /v1/search
// URL with Apple's opaque metadata), base64url: Apple's suggestions carry
// no place id, and the completion URL is how Apple says to get the whole
// place. resolve(id) checks it's one of those (only /v1/search, only q
// and metadata, so an id can't send this server anywhere else) and asks
// Apple for the place: { name, address, addressLines, lat, lng,
// applePlaceId, kind }.
//
// **Kept a while**, in memory: a suggestion list for CACHE_MS, a place
// for PLACE_CACHE_MS, by what was asked (the text, folded, near to two
// decimals, and the language).
//
// **Logs** say what went wrong with Apple (a status), never what someone
// typed, and never who.

const crypto = require('crypto');

const DEFAULT_URL = 'https://maps-api.apple.com';
// San Francisco.
const DEFAULT_NEAR = { lat: 37.7749, lng: -122.4194 };
const MAX_RESULTS = 8;
const MAX_QUERY = 200;
const REQUEST_TIMEOUT_MS = 5000;
// The JWT is made fresh for each trade, so it needn't last.
const JWT_LIFETIME_S = 30 * 60;
// Trade for a new access token this long before the old one runs out.
const REFRESH_EARLY_MS = 60 * 1000;
const CACHE_MS = 10 * 60 * 1000;
const PLACE_CACHE_MS = 60 * 60 * 1000;
const CACHE_MAX = 2000;
// Apple allows 25,000 calls a day per team, shared with MapKit JS: past
// this many in a day, places say they're unavailable rather than use up
// what the apps' maps need.
const DAILY_BUDGET = 20000;

const LANG_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;
const ID_RE = /^[A-Za-z0-9_-]{8,3000}$/;

class PlacesError extends Error {}

// "\n" escapes back into line breaks, and the PEM lines around a bare key.
function readPrivateKey(raw) {
  if (!raw) return null;
  let pem = String(raw).trim().replace(/\\n/g, '\n').replace(/\r\n/g, '\n');
  if (!pem.includes('-----BEGIN')) {
    const body = pem.replace(/\s+/g, '');
    pem = `-----BEGIN PRIVATE KEY-----\n${body.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`;
  }
  try {
    const key = crypto.createPrivateKey(pem);
    if (key.asymmetricKeyType !== 'ec') return null;
    return key;
  } catch (e) {
    return null;
  }
}

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

// The JWT Apple trades for an access token. `now` in ms.
function signJwt({ teamId, keyId, key }, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const header = { alg: 'ES256', kid: keyId, typ: 'JWT' };
  const claims = { iss: teamId, iat, exp: iat + JWT_LIFETIME_S, scope: 'server_api' };
  const input = `${b64url(header)}.${b64url(claims)}`;
  // JWS wants r || s (64 bytes), not DER.
  const sig = crypto.sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
  return `${input}.${sig.toString('base64url')}`;
}

// "lat,lng" -> { lat, lng }, or null.
function parseNear(raw) {
  if (typeof raw !== 'string') return null;
  const m = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(raw);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) return null;
  return { lat, lng };
}

// The first language in Accept-Language that looks like one, or en-US.
function langFrom(header) {
  for (const part of String(header || '').split(',')) {
    const tag = part.split(';')[0].trim();
    if (tag && tag !== '*' && LANG_RE.test(tag)) return tag;
  }
  return 'en-US';
}

const fold = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// An address rather than a point of interest: its first line is the
// street address itself ("1 Market St"), not a name.
function isStreetLine(line, structured) {
  const l = fold(line);
  if (!l) return false;
  const s = structured || {};
  if (s.fullThoroughfare && l === fold(s.fullThoroughfare)) return true;
  if (s.subThoroughfare && s.thoroughfare && l.startsWith(fold(s.subThoroughfare)) && l.includes(fold(s.thoroughfare))) return true;
  return false;
}

// One of Apple's autocomplete results -> ours, or null for one that isn't
// a place (a search suggestion: "Museum, Search Nearby" has no location).
function suggestionFrom(r) {
  if (!r || typeof r.completionUrl !== 'string' || !r.completionUrl.startsWith('/v1/search?')) return null;
  if (!r.location || !Array.isArray(r.displayLines) || !r.displayLines[0]) return null;
  const name = String(r.displayLines[0]);
  const s = r.structuredAddress || {};
  const address = r.displayLines[1] ? String(r.displayLines[1]) : [s.fullThoroughfare, s.locality, s.administrativeAreaCode || s.administrativeArea].filter(Boolean).join(', ');
  return { id: b64url(r.completionUrl), name, address, kind: isStreetLine(name, s) ? 'address' : 'poi' };
}

// One of Apple's places -> ours.
function placeFrom(p) {
  if (!p || !p.coordinate || typeof p.coordinate.latitude !== 'number' || typeof p.coordinate.longitude !== 'number') return null;
  const lines = Array.isArray(p.formattedAddressLines) ? p.formattedAddressLines.map(String).filter(Boolean) : [];
  const name = p.name ? String(p.name) : lines[0] || '';
  if (!name) return null;
  const address = isStreetLine(name, p.structuredAddress) || fold(name) === fold(lines[0]);
  return {
    name,
    address: lines.join(', '),
    addressLines: lines,
    lat: Math.round(p.coordinate.latitude * 1e6) / 1e6,
    lng: Math.round(p.coordinate.longitude * 1e6) / 1e6,
    applePlaceId: typeof p.id === 'string' && p.id ? p.id : null,
    kind: address ? 'address' : 'poi'
  };
}

// An id -> the /v1/search path and query to ask, or null for one that
// isn't a completion URL.
function completionFrom(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  let url;
  try {
    url = new URL(Buffer.from(id, 'base64url').toString('utf8'), 'http://x');
  } catch (e) {
    return null;
  }
  if (url.origin !== 'http://x' || url.pathname !== '/v1/search') return null;
  const q = url.searchParams.get('q');
  const metadata = url.searchParams.get('metadata');
  if (!q || q.length > 500 || (metadata && metadata.length > 2000)) return null;
  const params = new URLSearchParams({ q });
  if (metadata) params.set('metadata', metadata);
  return params;
}

// A Map that forgets: entries for `ttl`, at most `max` (the oldest go).
function memo(ttl, max = CACHE_MAX) {
  const m = new Map();
  return {
    get(k) {
      const v = m.get(k);
      if (!v) return undefined;
      if (Date.now() >= v.until) { m.delete(k); return undefined; }
      return v.value;
    },
    set(k, value) {
      m.delete(k);
      m.set(k, { value, until: Date.now() + ttl });
      while (m.size > max) m.delete(m.keys().next().value);
    },
    get size() { return m.size; }
  };
}

function settingsFrom(env) {
  return {
    teamId: (env.APPLE_MAPS_TEAM_ID || '').trim(),
    keyId: (env.APPLE_MAPS_KEY_ID || '').trim(),
    privateKey: env.APPLE_MAPS_PRIVATE_KEY || '',
    url: (env.APPLE_MAPS_URL || '').trim() || DEFAULT_URL,
    defaultNear: parseNear(env.PLACES_DEFAULT_NEAR || '') || DEFAULT_NEAR
  };
}

function createPlaces({ teamId, keyId, privateKey, url = DEFAULT_URL, defaultNear = DEFAULT_NEAR, fetchImpl = fetch, log = console } = {}) {
  const key = teamId && keyId ? readPrivateKey(privateKey) : null;
  let base = null;
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || u.protocol === 'http:') base = u.origin;
  } catch (e) {}
  const enabled = !!(key && base);
  if (teamId && keyId && privateKey && !key) log.warn('[canopy-events] APPLE_MAPS_PRIVATE_KEY isn\'t an EC private key (.p8): places are off.');

  let access = null; // { token, until }
  let trading = null;
  const suggestions = memo(CACHE_MS);
  const places = memo(PLACE_CACHE_MS);
  const day = { start: Date.now(), calls: 0 };

  function spend() {
    if (Date.now() - day.start >= 24 * 60 * 60 * 1000) { day.start = Date.now(); day.calls = 0; }
    if (day.calls >= DAILY_BUDGET) throw new PlacesError('daily budget used');
    day.calls++;
  }

  async function get(pathAndQuery, token) {
    let res;
    try {
      res = await fetchImpl(base + pathAndQuery, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch (err) {
      throw new PlacesError(`Apple Maps couldn't be reached (${err.name})`);
    }
    let body = null;
    try { body = await res.json(); } catch (e) {}
    return { status: res.status, body };
  }

  // The access token: the one kept, or a new one. One trade at a time.
  async function accessToken(fresh = false) {
    if (!fresh && access && Date.now() < access.until - REFRESH_EARLY_MS) return access.token;
    if (!trading) {
      trading = (async () => {
        spend();
        const { status, body } = await get('/v1/token', signJwt({ teamId, keyId, key }));
        if (status !== 200 || !body || typeof body.accessToken !== 'string') {
          access = null;
          throw new PlacesError(`Apple Maps refused the token trade (${status})`);
        }
        const seconds = Number.isFinite(body.expiresInSeconds) && body.expiresInSeconds > 0 ? body.expiresInSeconds : 1800;
        access = { token: body.accessToken, until: Date.now() + seconds * 1000 };
        return access.token;
      })().finally(() => { trading = null; });
    }
    return trading;
  }

  // A call with the access token; on a 401, once more with a new one.
  async function call(pathAndQuery) {
    if (!enabled) throw new PlacesError('places are off');
    let token = await accessToken();
    spend();
    let r = await get(pathAndQuery, token);
    if (r.status === 401) {
      token = await accessToken(true);
      spend();
      r = await get(pathAndQuery, token);
    }
    if (r.status !== 200 || !r.body) throw new PlacesError(`Apple Maps answered ${r.status}`);
    return r.body;
  }

  function failed(err) {
    // What went wrong, never what was asked or by whom.
    log.warn(`[canopy-events] places: ${err instanceof PlacesError ? err.message : 'unexpected error'}`);
    if (!(err instanceof PlacesError)) throw err;
    return null;
  }

  return {
    enabled,

    // Suggestions for `q` near `near` ({ lat, lng }, or the default), in
    // `lang`: [{ id, name, address, kind }], or null when Apple can't be
    // asked.
    async autocomplete(q, { near = null, lang = 'en-US' } = {}) {
      const text = String(q || '').replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY);
      if (!text) return [];
      const at = near || defaultNear;
      const where = `${at.lat.toFixed(2)},${at.lng.toFixed(2)}`;
      const cacheKey = `${fold(text)}\n${where}\n${lang}`;
      const kept = suggestions.get(cacheKey);
      if (kept) return kept;
      const params = new URLSearchParams({ q: text, searchLocation: where, lang });
      try {
        const body = await call(`/v1/searchAutocomplete?${params}`);
        const seen = new Set();
        const results = (Array.isArray(body.results) ? body.results : []).map(suggestionFrom)
          .filter((r) => r && !seen.has(r.id) && seen.add(r.id)).slice(0, MAX_RESULTS);
        suggestions.set(cacheKey, results);
        return results;
      } catch (err) {
        return failed(err);
      }
    },

    // The whole place for a suggestion's `id`: { name, address,
    // addressLines, lat, lng, applePlaceId, kind }; false for an id that
    // isn't one or a place Apple doesn't find, and null when Apple can't
    // be asked.
    async resolve(id, { lang = 'en-US' } = {}) {
      const params = completionFrom(id);
      if (!params) return false;
      params.set('lang', lang);
      const cacheKey = params.toString();
      const kept = places.get(cacheKey);
      if (kept) return kept;
      try {
        const body = await call(`/v1/search?${params}`);
        const place = placeFrom(Array.isArray(body.results) ? body.results[0] : null);
        if (!place) return false;
        places.set(cacheKey, place);
        return place;
      } catch (err) {
        return failed(err);
      }
    },

    // For the tests' sake: how many Apple calls today.
    callsToday: () => day.calls
  };
}

module.exports = { createPlaces, settingsFrom, signJwt, readPrivateKey, parseNear, langFrom, suggestionFrom, placeFrom, completionFrom, isStreetLine, DEFAULT_NEAR, MAX_RESULTS };
