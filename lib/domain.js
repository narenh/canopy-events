// Which addresses count as Canopy: canopysf.com and every subdomain of it,
// over https. The same answer as the account service's lib/domain.js, cut
// down to what events asks it:
//
//   - which pages may make a change here with the cookie (the Origin
//     check in server.js);
//   - where a ?return= may send someone, for the pages that come later.
//
// CANOPY_DOMAIN overrides the domain. Outside production, http on
// localhost / 127.0.0.1 counts too, so it can be run and tested locally.

const BASE = (process.env.CANOPY_DOMAIN || 'canopysf.com').toLowerCase();
const PRODUCTION = process.env.NODE_ENV === 'production';

function isLocalHost(host) {
  return host === 'localhost' || host === '127.0.0.1';
}

// A URL (string) is a Canopy page: https on the domain or a subdomain of
// it, with no username/password part (https://canopysf.com@evil.example
// reads as canopysf.com to a person and evil.example to a browser).
function isCanopyUrl(raw) {
  let url;
  try { url = new URL(String(raw)); } catch (e) { return false; }
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (!PRODUCTION && url.protocol === 'http:' && isLocalHost(host)) return true;
  return url.protocol === 'https:' && (host === BASE || host.endsWith('.' + BASE));
}

// An Origin header value ("https://events.canopysf.com") is a Canopy page.
function isCanopyOrigin(origin) {
  return !!origin && origin !== 'null' && isCanopyUrl(origin);
}

// ?return= cleaned: the URL if it's a Canopy page, otherwise null.
function safeReturn(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 2000) return null;
  return isCanopyUrl(raw) ? new URL(raw).toString() : null;
}

// Where this service is, as links should point at it: event links in the
// API (<base>/e/<id>), and where to come back to after signing in. An app
// asks from wherever it is, so the request's own host can't be trusted to
// be the public one in production.
function publicBase(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  if (PRODUCTION) return `https://events.${BASE}`;
  return `${req.protocol}://${req.get('host')}`;
}

module.exports = { BASE, PRODUCTION, isCanopyUrl, isCanopyOrigin, safeReturn, isLocalHost, publicBase };
