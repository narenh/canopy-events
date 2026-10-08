// The small things every /api/v1 route shares: errors in the one shape,
// async routes that can't take the process down, and cursor pagination.
//
// Errors are {"error": "<a sentence a person can read>", "reason":
// "<snake_case code>"}, with the right status. Apps branch on `reason`
// and may show `error`. A few carry more (a sign-in URL, say), documented
// next to where they're made.

// Express 4 doesn't catch a rejected promise from an async route: it
// becomes an unhandled rejection, and Node ends the process on one. Every
// async route goes through this, which hands the error to Express instead
// (a 500 for that request, like a synchronous throw).
function handle(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function fail(res, status, reason, error, extra = {}) {
  return res.status(status).json({ error, reason, ...extra });
}

// ---------------- Pagination ----------------
//
// Lists take ?limit= (1 to 100, 20 by default) and ?cursor=, and answer
// with `nextCursor`: pass it back as ?cursor= for the next page, and when
// it's null there are no more. A cursor is opaque to apps. Inside, it's
// the last row's sort key, base64url JSON, so a row added or removed
// while someone pages through doesn't shift the pages.
//
// A page can hold fewer than `limit` items even with more to come (a
// former member is left out of a friends page, say). Only a null
// nextCursor means the end.

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function encodeCursor(key) {
  return Buffer.from(JSON.stringify(key)).toString('base64url');
}

function decodeCursor(raw) {
  try {
    const key = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
    if (Array.isArray(key) && key.length === 2 && key.every((v) => typeof v === 'string' || Number.isSafeInteger(v))) return key;
  } catch (e) {}
  return undefined;
}

// ?cursor= and ?limit= from the request: { after, limit }, or null after
// sending a 400 for one that's malformed.
function pageParams(req, res) {
  let limit = DEFAULT_LIMIT;
  if (req.query.limit !== undefined) {
    limit = Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      fail(res, 400, 'bad_limit', `limit is a whole number from 1 to ${MAX_LIMIT}`);
      return null;
    }
  }
  let after = null;
  if (req.query.cursor !== undefined && req.query.cursor !== '') {
    after = decodeCursor(req.query.cursor);
    if (!after) {
      fail(res, 400, 'bad_cursor', "that cursor isn't one this list gave out");
      return null;
    }
  }
  return { after, limit };
}

// Rows fetched with limit + 1: the page, and the cursor for the next one
// (from `keyOf` of the page's last row) if there's more.
function paginate(rows, limit, keyOf) {
  const items = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? encodeCursor(keyOf(items[items.length - 1])) : null;
  return { items, nextCursor };
}

// ---------------- The event a route is about ----------------
//
// For routes under /events/:id: puts the event on req.event, and the
// caller's part in hosting it on req.role ('creator', 'cohost' or null),
// or answers 404. Something that isn't shaped like an event id is a 404
// too, without asking the database.
const { EVENT_ID_RE } = require('./ids');

function loadEvent(store) {
  return (req, res, next) => {
    const event = EVENT_ID_RE.test(req.params.id) ? store.getEvent(req.params.id) : null;
    if (!event) return fail(res, 404, 'event_not_found', "there's no event at that link");
    req.event = event;
    req.role = req.person ? store.hostRole(event.id, req.person.id) : null;
    next();
  };
}

module.exports = { handle, fail, pageParams, paginate, encodeCursor, decodeCursor, loadEvent, DEFAULT_LIMIT, MAX_LIMIT };
