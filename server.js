const express = require('express');
const path = require('path');

const store = require('./lib/db').init();
const createCanopyAccount = require('./lib/canopy-account');
const createAuth = require('./lib/auth');
const { fail } = require('./lib/api');
const { isCanopyOrigin } = require('./lib/domain');
const { isVerified } = require('./lib/people');
const { createPush } = require('./lib/push');
const { createNotifier } = require('./lib/notify');

const app = express();
const PORT = process.env.PORT || 3000;

// Coolify (and Cloudflare) terminate TLS in front of this container, so
// the request Express sees is plain HTTP; trusting the proxy makes
// req.protocol and req.hostname read what the visitor actually used. The
// account client needs it too: "come back here after signing in" has to
// say https, or the account service won't send anyone back.
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

// Everyone is a Canopy account. Without the account service there's no
// one to be, so a missing setting stops the server here, with what to do,
// rather than at the first request.
if (!process.env.CANOPY_ACCOUNT_URL || !process.env.CANOPY_ACCOUNT_KEY) {
  console.error('[canopy-events] CANOPY_ACCOUNT_URL and CANOPY_ACCOUNT_KEY are both required -- see README.md > Running locally.');
  process.exit(1);
}
const canopy = createCanopyAccount({ url: process.env.CANOPY_ACCOUNT_URL, key: process.env.CANOPY_ACCOUNT_KEY });
const auth = createAuth(canopy);

{
  const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
  const count = store.countEvents();
  console.log(`[canopy-events] DATA_DIR=${dataDir} (${count} events found on disk at startup)`);
  if (count === 0) {
    console.log(
      '[canopy-events] If you expected events here, DATA_DIR is probably NOT on a persistent volume -- ' +
        'see README.md > Deploying on Coolify.'
    );
  }
}

// ---------------- Headers every response gets ----------------
//
// No framing (a page in someone else's frame is how a click gets stolen),
// no MIME sniffing, and no full URLs in Referer: an event's address is
// the event's key.
app.use((req, res, next) => {
  res.set('X-Frame-Options', 'DENY');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  next();
});

// ---------------- Changes only from Canopy pages ----------------
//
// A change made with the cookie has to come from a page on canopysf.com
// or one of its subdomains, by its Origin header. The browser already
// keeps other websites from sending the cookie (SameSite=Lax); this covers
// Canopy's own subdomains, which count as the same site to the browser.
// Browsers send Origin on every POST, PATCH, PUT and DELETE, so a missing
// one is refused too.
//
// A request with `Authorization: Bearer` (an app) skips this. It's signed
// in by that token alone, never by the cookie (lib/canopy-account.js), so
// there's no cookie for another site to ride on. A web page can't add that
// header to a request to here either: it isn't one browsers let pages
// send to another origin without asking first, and this server never says
// yes. And native apps don't send Origin at all.
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (auth.isBearer(req)) return next();
  if (isCanopyOrigin(req.get('origin'))) return next();
  fail(res, 403, 'bad_origin', 'requests that change something must come from a Canopy page');
});

// ---------------- The API ----------------
//
// Everything under /api/v1, JSON in and out (openapi.yaml is the
// contract, docs/api.md the guide). Each subject is its own file in
// routes/, all given the same few things: the store, the account client,
// the auth checks, and notify() (lib/notify.js: the inbox and push, in
// one call).

const notify = createNotifier({ store, push: createPush({ store }) });
const ctx = { store, canopy, auth, notify };
const docsRouter = require('./routes/docs')();
const apiRouters = [
  require('./routes/events'),
  require('./routes/rsvps'),
  require('./routes/hosts'),
  require('./routes/wall'),
  require('./routes/covers'),
  require('./routes/notifications'),
  require('./routes/me')
].map((make) => make(ctx));

// The spec and its page come first: they're the same for everyone, so
// there's no need to ask the account service who's asking.
app.use(docsRouter);
// Cover images are public, for link previews (routes/covers.js).
app.use(require('./routes/covers').files(ctx));

// Answers about people are never for a cache to keep.
app.use('/api/v1', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use('/api/v1', auth.attach);
// Whether each caller's email is proven, from their own session: the only
// way events learns who may co-host (lib/store/people.js).
app.use('/api/v1', (req, res, next) => {
  if (req.person) store.noteVerification(String(req.person.id), isVerified(req.person));
  next();
});
apiRouters.forEach((router) => app.use('/api/v1', router));
app.use('/api/v1', (req, res) => fail(res, 404, 'not_found', 'there is no such API endpoint'));

app.get('/healthz', (req, res) => res.json({ ok: true }));

// The web pages (routes/pages.js): an event, your events, the editor,
// inviting, friends. They're clients of the API above, like the apps.
const pages = require('./routes/pages')(ctx);
app.use(pages.router);

// There's no icon; this keeps every page load from logging a 404 for one.
app.get('/favicon.ico', (req, res) => res.status(204).end());

// no-cache: a conditional GET every load, so a stale copy can't outlive a
// deploy in someone's browser.
app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders(res) {
      res.set('Cache-Control', 'no-cache');
    }
  })
);

// Anything else a browser asks for: a page saying there's nothing here.
app.use(pages.notFound);

// Errors as JSON in the API's shape rather than Express's HTML page.
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') return fail(res, 400, 'bad_json', "that body isn't JSON");
  if (err && err.type === 'entity.too.large') return fail(res, 413, 'too_large', 'that body is too large');
  if (err && err.status === 503 && err.reason) {
    console.error(`[canopy-events] ${err.message}`);
    return fail(res, 503, err.reason, err.expose);
  }
  console.error(err);
  if (res.headersSent) return next(err);
  fail(res, 500, 'server_error', 'something went wrong on our side');
});

// Every /api/v1 route Express knows, as { method, path } with OpenAPI's
// {param} for :param. test/spec.test.js holds this against openapi.yaml.
function apiRoutes() {
  const found = [];
  const add = (prefix, router) => router.stack.forEach((layer) => {
    if (!layer.route) return;
    const full = (prefix + layer.route.path).replace(/:(\w+)/g, '{$1}');
    if (!full.startsWith('/api/v1/')) return;
    Object.keys(layer.route.methods).forEach((m) => found.push({ method: m, path: full }));
  });
  add('', docsRouter);
  apiRouters.forEach((router) => add('/api/v1', router));
  return found;
}

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`canopy-events listening on port ${PORT}`);
  });
}

module.exports = { app, apiRoutes };
