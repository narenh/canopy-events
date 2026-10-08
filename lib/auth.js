// Who may call what, for the API. lib/canopy-account.js (the account
// service's client file, copied in unchanged) finds the caller, from the
// canopy_session cookie (the web) or an `Authorization: Bearer` token
// (the apps). These answer in the API's own error shape, with the links an
// app or a page needs to send someone on: to sign in, to quick-sign-up,
// or to verify their email.
//
// Quick accounts are signed in here, unverified (emailVerified: false).
// They can answer, be invited and see guest lists. They can't make events
// (or, later, co-host them): requireVerified.

const { fail } = require('./api');
const { isVerified } = require('./people');
const { publicBase } = require('./domain');

// The same test lib/canopy-account.js uses to decide a request is signed
// in by its bearer token rather than its cookie. The Origin check
// (server.js) skips exactly these, so the two have to agree.
const BEARER_RE = /^Bearer\s+(.*)$/i;
function isBearer(req) {
  return BEARER_RE.test(String(req.headers.authorization || '').trim());
}

module.exports = function createAuth(canopy) {
  // canopy.attach, for the API. When the account service can't be reached
  // the client answers a plain-text 503 (right for a page); an API answers
  // JSON, so that one answer is caught and put in the API's shape.
  function attach(req, res, next) {
    const send = res.send;
    res.send = function (body) {
      res.send = send;
      if (res.statusCode === 503 && typeof body === 'string') {
        return fail(res, 503, 'accounts_unreachable', body);
      }
      return send.apply(this, arguments);
    };
    canopy.attach(req, res, (err) => {
      res.send = send;
      next(err);
    });
  }

  // Where to come back to after signing in or verifying: the event the
  // call was about, the friend link or list link it was about, or the
  // home page.
  function returnTo(req) {
    const base = publicBase(req);
    if (req.params && req.params.id) return `${base}/e/${encodeURIComponent(req.params.id)}`;
    if (req.params && req.params.code) {
      const page = String(req.originalUrl || '').includes('/list-links/') ? 'l' : 'f';
      return `${base}/${page}/${encodeURIComponent(req.params.code)}`;
    }
    return `${base}/`;
  }

  function verifyRefusal(req, res) {
    return fail(res, 403, 'email_unverified', 'verify your email first', { verify: canopy.verifyUrl(req, returnTo(req)) });
  }

  // Signed in, or a 401 with where to sign in (or quick-sign-up, for
  // someone with no Canopy Account yet).
  function requirePerson(req, res, next) {
    if (req.person) return next();
    // An unverified account on a site that doesn't allow them. Events
    // does, so this is only here in case its key is set up without that.
    if (req.canopyUnverified) return verifyRefusal(req, res);
    fail(res, 401, 'sign_in_required', 'sign in first', {
      signIn: canopy.signInUrl(req, returnTo(req)),
      quickSignUp: canopy.quickSignUpUrl(req, returnTo(req))
    });
  }

  // Signed in with a verified email.
  function requireVerified(req, res, next) {
    requirePerson(req, res, () => (isVerified(req.person) ? next() : verifyRefusal(req, res)));
  }

  return { attach, requirePerson, requireVerified, returnTo, isBearer };
};

module.exports.isBearer = isBearer;
