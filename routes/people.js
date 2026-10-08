// Finding someone to invite by their phone number or Instagram. Mounted at
// /api/v1.
//
// It's the account service's lookup (lib/canopy-account.js `lookup`),
// asked as the visitor, and passed on in this API's shape. The rules are
// the account service's, by design: exact matches only, never a list;
// only people who let themselves be found; a miss says nothing about why;
// tight limits per asker, per address and overall (the client sends the
// visitor's address, from CF-Connecting-IP, for the per-address one).
// Events adds one rule of its own first: verified people only, the same as
// hosting, so a throwaway quick account can't be used to look.
//
// The answer is the public `Person` and nothing else: not the number or
// handle that was asked about, and nothing the other way round.
//
// A POST, with what was typed in the JSON body, all the way through (the
// account service's lookup is a POST too): a URL with a phone number in it
// ends up in logs, and a body doesn't. Nothing here logs it either.

const express = require('express');
const { handle, fail } = require('../lib/api');
const { publicPerson } = require('../lib/people');

// The account service's refusals, as this API says them. Anything not
// here (it's down, or answered something unexpected) is a 503.
const PASSED_ON = {
  400: ['one_of', 'bad_phone', 'bad_instagram'],
  403: ['email_unverified', 'lookup_not_allowed'],
  429: ['rate_limited']
};
const SENTENCES = {
  one_of: 'give one of phone or instagram',
  bad_phone: "that doesn't look like a phone number",
  bad_instagram: 'an Instagram username is letters, numbers, . and _ only',
  email_unverified: 'verify your email first',
  lookup_not_allowed: "finding people by phone or Instagram isn't switched on here yet",
  rate_limited: "that's a lot of lookups -- try again later"
};

module.exports = function peopleRoutes(ctx) {
  const { canopy, auth } = ctx;
  const router = express.Router();

  router.post('/people/lookup', auth.requireVerified, handle(async (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const { phone, instagram } = body;
    if ((phone === undefined) === (instagram === undefined) || typeof (phone === undefined ? instagram : phone) !== 'string') {
      return fail(res, 400, 'one_of', SENTENCES.one_of);
    }
    let found;
    try {
      found = await canopy.lookup(req, phone !== undefined ? { phone } : { instagram });
    } catch (err) {
      const reason = err && err.reason;
      if (err && err.status === 401) {
        return fail(res, 401, 'sign_in_required', 'sign in first', {
          signIn: canopy.signInUrl(req, auth.returnTo(req)),
          quickSignUp: canopy.quickSignUpUrl(req, auth.returnTo(req))
        });
      }
      if (err && PASSED_ON[err.status] && PASSED_ON[err.status].includes(reason)) {
        const extra = reason === 'email_unverified' ? { verify: canopy.verifyUrl(req, auth.returnTo(req)) } : {};
        return fail(res, err.status, reason, SENTENCES[reason], extra);
      }
      console.error(`[canopy-events] lookup failed: ${err && err.message}`);
      return fail(res, 503, 'accounts_unreachable', 'Canopy Accounts could not be reached. Try again in a minute.');
    }
    res.json({ person: found ? publicPerson(found) : null });
  }));

  return router;
};
