# Canopy Events: decisions

The source of truth for the first build (decided 2026-10-07). Anything
here can change later, but nobody should have to guess at it during the
build. When code and this file disagree, fix one of them.

## What it is

`events.canopysf.com`. A simple event service like Partiful, but built
around friends. Hosts make an event and share its link. People open the
link, sign in (or quick-sign-up, below), and say **going**, **maybe** or
**can't go**. It's a full web app, and it has a fully documented JSON API
(`/api/v1`, OpenAPI 3.1) so iOS and Android apps can be built on it
later without touching the server.

## Accounts: Canopy accounts, plus "quick" ones

Everyone is a Canopy account (`account.canopysf.com`, repo
`canopy-account-service`). Events keeps no names, emails or photos of
its own, only person ids, the same as tickets.

**Quick sign-up** is new in the account service, for people opening an
event link who have never used Canopy:

- They give **first name, last name, email**, and make a **passkey**. No
  emailed code and no photo. It has to feel instant. The passkey is
  required, so there's still never an account nobody can get into.
- If the email already has an account (verified or not), they're told
  "this email has an account, sign in instead". That says the account
  exists. We accept that leak in exchange for a quick sign-up.
- The account is **unverified** until its owner proves the email with a
  code. Unverified accounts work **only on sites the admin marks as
  allowing them** (events, and no other site for now). Every other site
  sees them as not signed in, and gets sent to verify.
- Unverified accounts see a **verify-your-email banner that can't be
  dismissed**, on every events page and on their profile. It's never a
  hard block. The API returns `emailVerified: false` so the apps can show
  the same thing.
- Proving the email by code turns the account into a full account. That
  means verifying from the profile, or signing in by email code, which
  for an unverified account adds a passkey and marks it verified.

Contract between the two services (the account service builds it, events
uses it):

- `GET /api/session`, for a site that allows unverified accounts:
  `person` gains `"emailVerified": true|false`.
  For a site that doesn't, an unverified person comes back as
  `{"person": null, "unverified": true}`.
- `client/canopy-account.js` (copied into events as `lib/canopy-account.js`) gains:
  - `quickSignUpUrl(req, returnTo)` → `<account>/?quick=1&return=…`
  - `verifyUrl(req, returnTo)` → `<account>/profile?verify=1&return=…`
  - **Bearer support**: `attach`/`requireSignIn` also accept
    `Authorization: Bearer <token>`, where the token is a `canopy_session`
    value (43 chars, base64url). It's passed to `/api/session` the same
    way as the cookie. Nothing is sent back as `Set-Cookie` for a bearer
    request. Native apps get a token from a sign-in flow that **will be
    built later** in the account service. Events only has to accept one.
  - `requireSignIn` for an unverified person on a site that doesn't
    allow them: pages redirect to `verifyUrl`, and API calls get
    `403 {"error": …, "reason": "email_unverified", "verify": url}`.

**Later, not tonight unless there's time:** hosts find people to invite
by **phone number or Instagram username**, which people already fill in
on their Canopy profile. The account service gets an exact-match lookup
for sites (`GET /api/people/lookup?phone=…` / `?instagram=…`, never
prefix or fuzzy search, so it can't list people), rate-limited. Events
only lets verified hosts use it. Invites are therefore keyed by **person
id** from day one.

## Events: product rules

- **Visibility: anyone with the link.** An event's id is random and
  unguessable (it *is* the link: `events.canopysf.com/e/<id>`, 12 chars
  of base62, about 71 bits). There's no public listing or search.
- **Friends are implicit**: two people are friends when they've both been
  at the same event, meaning a host, or an RSVP of *going*, on an event
  that has started and wasn't cancelled. There are no friend requests.
  Friends are used for:
  - inviting: the host picks friends, and the event shows up under that
    friend's invitations, with no response yet;
  - "friends going" called out on an event page;
  - `GET /api/v1/me/friends`, with how many events in common.
- **RSVP**: `going`, `maybe`, `not_going`. Invited with no answer yet is
  `invited`. A waitlist adds `waitlisted` (see capacity).
- **Guest list visibility is the host's choice, per event**: `everyone`
  (anyone with the link sees names and photos) or `responded` (you see
  the names once you've RSVP'd; before that, only counts). Hosts always
  see everything. Emails are never shown to anyone except through the
  account service's own rules.
- **Unverified accounts can RSVP, post on the wall and be invited.** They
  **can't create events or be co-hosts.**
- Times are stored as UTC instants plus the event's IANA time zone.

## v1 scope, in build order

1. Core: create, edit and cancel events; RSVP; guest list with the
   visibility rule; invites to friends; friends; my events (hosting,
   going, invited, past); the quick sign-up and verify-banner wiring.
2. **Co-hosts** (verified only; the creator adds and removes them, and
   co-hosts can edit) and **plus-ones** (the host sets how many guests
   each RSVP may bring, 0 by default; an RSVP carries `guests: n`).
3. **Activity wall**: posts from hosts and guests on the event page,
   plus automatic entries ("Ana is going", "time changed"). Hosts can
   delete any post, and authors can delete their own.
4. **Cover image** (uploaded, stored on disk like account photos) and
   **capacity with a waitlist**: going + guests is capped. Past the cap,
   a `going` becomes `waitlisted`, and a freed spot promotes the earliest
   waitlisted RSVP automatically (only if it fits with its guests).

Not in v1: email/SMS notifications, .ics files, ticketing/payments,
public discovery.

## Technical shape

Match `canopy-account-service` closely. Read its README and `server.js`
before writing anything. The house style matters: plain-English
comments and README that explain *why*, written like that README.

- Node 22, Express 4, better-sqlite3 (one file, `DATA_DIR/events.db`,
  WAL, schema version in `user_version`, daily snapshots), `node:test`,
  Dockerfile for Coolify, port 3000, `DATA_DIR=/app/data`.
- Since nothing is deployed yet, the schema stays at **version 1** and is
  edited in place until the first deploy.
- Pages are server-sent HTML plus vanilla JS, with scripts and CSS inlined
  per page (Cloudflare cache lesson, see the account README). Same look as
  the account service: dark green mesh background and glass cards (copy
  `account.css`'s tokens). Mobile-first, since links get opened on phones.
- `lib/canopy-account.js` is a copy of the account service's client file.
- **API**: everything under `/api/v1`. JSON in and out. Errors are
  `{"error": "<human sentence>", "reason": "<snake_case_code>"}` with the
  right status. Lists are cursor-paginated (`?cursor=&limit=`, with
  `nextCursor` returned). Timestamps are ISO 8601 UTC strings. Ids are
  strings.
- **Auth**: the `canopy_session` cookie (web) or `Authorization: Bearer`
  (apps), both through `lib/canopy-account.js`.
- **The Origin check** (as in the account service) applies to
  cookie-authenticated changes only. A request authenticated by bearer
  token carries no cookie, so it can't be forged cross-site, and native
  apps don't send `Origin`.
- **Docs**: `openapi.yaml` in the repo is the contract. It's served at
  `/api/v1/openapi.yaml` and rendered at `/docs` (with a renderer vendored
  into `public/vendor`, never from a CDN at runtime). Tests check that
  every `/api/v1` route is in the spec and that responses match their
  schemas (ajv as a dev dependency is fine). `docs/api.md` is a
  narrative guide for app developers: auth, the RSVP state machine,
  pagination, errors, and examples.
- **Tests** run the real server against a **fake account service** (a
  tiny Express app in `test/` answering `/api/session` and
  `/api/people` from fixtures, with verified and unverified people) on
  a scratch `DATA_DIR`.
- Guess and abuse limits, like the account service's `lib/limits.js`:
  events created per person per day, posts per person per minute.
- Local dev: the account service on :3000 and events on :3001. Cookies
  aren't port-specific, so one sign-in works for both.

## Git

- `canopy-account-service`: straight to `main`, pushed.
- `canopy-events`: `main` is the integration branch. Subagents work on
  feature branches, which get merged back into `main` and pushed. Push
  often.
