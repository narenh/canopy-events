# Canopy Events

`events.canopysf.com`. A simple event service, like Partiful, but built
around friends. A host makes an event and shares its link. People open
the link, sign in (or quick-sign-up), and say **going**, **maybe** or
**can't go**.

- **Anyone with the link** can see an event. The id is the link
  (`events.canopysf.com/e/<id>`): 12 random characters, so it can't be
  guessed, and there's no listing or search.
- **Friends are implicit.** Two people are friends once they've both been
  at the same event: hosting it, or "going", once it has started and if
  it wasn't cancelled. There are no friend requests. Friends are who a
  host picks from to invite, and who's called out as "friends going".
- **The guest list is the host's choice**, per event: everyone with the
  link sees the names, or only people who've answered do (everyone else
  sees counts). Hosts always see everything.
- **Contact details never leak.** Nobody is ever shown anyone else's
  email, phone, Instagram, Venmo or Cash App, not even a host looking at
  their own guests. Other people are a name and a photo.
- It has a **fully documented JSON API** (`/api/v1`, OpenAPI 3.1, rendered
  at `/docs`), so the iOS and Android apps can be built on it without
  touching the server. The web pages use the same API.

**What this isn't.** It keeps no accounts of its own. Everyone is a
Canopy account (`account.canopysf.com`, the `canopy-account-service`
repo), and events stores only their ids, the same as tickets. There's no
email or text sent from here, no `.ics`, no tickets or payments, and no
public discovery. `docs/decisions.md` is the source of truth for what's
in and out.

**Where it's up to.** This is the core: the database, the API (events,
answers, the guest list, invitations, friends, your events), its spec
and docs, and the tests. The web pages, co-hosts and plus-ones, the
activity wall, cover images and capacity with a waitlist come next, in
that order (`docs/decisions.md`, "v1 scope"). The schema already has room
for all of them.

## How it works

- `server.js` is the Express app's wiring: the two checks every request
  goes through, the response headers (no framing, no MIME sniffing, no
  full URLs in `Referer`) and the Origin check (below); then the API's
  routers, the docs, `/healthz` and the static files; and the error
  handler that keeps every API error in one shape.
- `routes/` is the API, one file per subject, each mounted at `/api/v1`:
  `events.js` (making, reading, editing and cancelling events),
  `rsvps.js` (answers, the guest list, invitations), `me.js` (you, your
  friends, your events) and `docs.js` (the spec and `/docs`). A new
  subject is a new file here, so work on different subjects doesn't
  collide.
- `lib/` is what the routes share:
  - `db.js` is persistence: one SQLite file, `DATA_DIR/events.db`, with
    the schema, its version and upgrades, and the daily snapshots. The
    queries are in `lib/store/`, one file per subject (`events.js`,
    `rsvps.js`, `friends.js`), and `init()` hands them back as one store.
  - `people.js` is **the only place a person is turned into JSON**:
    `publicPerson` (the five public fields, copied by name), the former
    member, and `ownPerson` for `/me`.
  - `rules.js` is who may do what: hosts, who sees the guest list's
    names, when an event is over, why an answer or an invitation is
    refused.
  - `views.js` turns events into API objects, with the visibility rules
    applied, for every route that returns one.
  - `auth.js` is the API's sign-in checks (signed in; signed in and
    verified), in the API's error shape.
  - `eventInput.js` cleans what a host sends to make or edit an event.
  - `api.js` is errors, async routes, cursor pagination and loading the
    event a route is about.
  - `ids.js` makes event ids. `limits.js` holds the in-memory counters
    behind the limits, and `clientIp()`. `domain.js` is "is this a Canopy
    address?" and where this service is (`publicBase`).
  - `canopy-account.js` is the account service's
    `client/canopy-account.js`, copied in **unchanged**. Update it by
    copying the file again, never by editing it here.
- `openapi.yaml` is the API's contract. `docs/api.md` is the guide for app
  developers. `public/vendor/redoc-2.5.4/` is the renderer `/docs` uses.
- `test/` uses `node:test`. Each file starts the real server in a child
  process on a scratch `DATA_DIR`, against a fake account service
  (`test/fakeAccount.js`). `npm test` runs them all.

`GET /healthz` answers `{"ok":true}`, and `GET /favicon.ico` answers an
empty 204.

## Accounts

Signing in happens at `account.canopysf.com`. Its `canopy_session` cookie
belongs to all of `canopysf.com`, so the browser sends it here too, and
`lib/canopy-account.js` asks the account service who it is (cached for a
minute). Apps send the same token as `Authorization: Bearer <token>`.

- **Quick accounts.** Someone opening an event link who has never used
  Canopy can make an account with just a name, an email and a passkey, no
  emailed code. It's **unverified** until they prove the email. Events is
  a site that allows them (see "Running locally"), so they're signed in
  here with `emailVerified: false`. They can answer, be invited and see
  guest lists. They can't make events (or, later, co-host). Every page
  shows them a banner to verify that can't be dismissed, and the API
  says `emailVerified: false` so the apps show it too.
- **Deleted accounts.** When the account service no longer has someone,
  their answers stay here, and they show as a "Former member" with no
  photo.
- **Contact details.** The account service hands this site the visitor's
  own email, phone, Instagram, Venmo and Cash App, for `/api/v1/me`. It
  never hands over anyone else's, and nothing here would pass them on if
  it did: `lib/people.js` copies the five public fields by name. The
  tests walk every JSON answer in the whole suite and fail on anyone
  else's details turning up anywhere in it.

## The API

Everything under `/api/v1`. `openapi.yaml` is the full contract, served
at `/api/v1/openapi.yaml` and readable at `/docs`. `docs/api.md` explains
it for app developers: auth, the banner, the RSVP state machine, the
visibility rules, pagination, errors and limits, with curl examples.

| | |
|---|---|
| `POST /api/v1/events` | make an event (verified people) |
| `GET /api/v1/events/{id}` | one event (anyone with the link) |
| `PATCH /api/v1/events/{id}` | edit, cancel or un-cancel it (hosts) |
| `PUT /api/v1/events/{id}/rsvp` | answer: going, maybe, not_going |
| `DELETE /api/v1/events/{id}/rsvp` | take the answer back |
| `GET /api/v1/events/{id}/guests` | the guest list, by the visibility rule |
| `POST /api/v1/events/{id}/invites` | invite people by id (hosts) |
| `DELETE /api/v1/events/{id}/invites/{personId}` | take back an unanswered invitation (hosts) |
| `GET /api/v1/me` | you, with your own details and `emailVerified` |
| `GET /api/v1/me/friends` | your friends, with events in common |
| `GET /api/v1/me/events/hosting`, `/upcoming`, `/invitations`, `/past` | your events |

Errors are `{"error": "<a sentence>", "reason": "<snake_case_code>"}` with
the right status. Lists are cursor-paginated (`?cursor=&limit=`, and
`nextCursor` back). Times are ISO 8601 UTC, plus each event's IANA time
zone. Ids are strings.

**What a signed-out caller sees of an event.** Enough for a link preview
and a "sign in to answer" page: the title, description, times, place
name, hosts, status and counts. Not the guest list, and not the street
address: previews are fetched and kept by machines (Slack, iMessage,
crawlers), and a home address shouldn't end up in their caches. Anyone
signed in, even with a quick account, sees it.

**The tests hold the server to the spec.** Every `/api/v1` route Express
has must be in `openapi.yaml` and the other way round, and every JSON
answer in every test is validated against the spec's schema for that
operation and status. The `Person` schema allows no other fields, so a
leak fails twice.

## The Origin check

A change made with the cookie (anything but GET, HEAD or OPTIONS) has to
carry an `Origin` header for a page on `canopysf.com` or one of its
subdomains, over https. Outside production, `http://localhost` and
`http://127.0.0.1` count too. A missing `Origin`, or `Origin: null`, is
refused, because browsers send one on every POST, PATCH, PUT and DELETE.
The refusal is a 403 with `"reason": "bad_origin"`. It's the same check
as the account service's, and the second lock after `SameSite=Lax`.

**Bearer requests skip it.** A request with `Authorization: Bearer` is
signed in by that token alone, never by the cookie, even if one comes
along (`lib/canopy-account.js`). So there's no cookie for another website
to ride on. A web page can't add that header to a request to here
anyway: browsers only let a page send it to another origin after asking
the server first, and this one never says yes. And native apps don't
send `Origin` at all. `lib/auth.js`'s `isBearer` uses the same test as
the client file, so "skips the check" and "signed in by the token" can't
disagree.

## Limits

Counted per person, per network address, and with one ceiling across
everyone, like the account service's. The counters live in memory, so a
restart forgives everyone. The address is Cloudflare's
`CF-Connecting-IP` when present.

| What | Per person | Per address | Everyone |
|---|---|---|---|
| Making events | 20 a day | 60 a day | 1,000 a day |
| Invitations (one per person invited) | 300 a day | 600 a day | 5,000 a day |

On top of that, one invite request takes at most 100 people, and a
request body at most 100 KB. The numbers live next to the routes they
guard (`routes/events.js`, `routes/rsvps.js`). Invitations get a limit
because an invitation puts an event in someone else's list; it matters
more once hosts can find people by phone number.

## Running locally

Events needs the account service running too. Locally that's
`canopy-account-service` on **:3000** and events on **:3001**. Cookies
aren't port-specific, so signing in on one signs you in on both.

1. Start the account service (see its README): `ADMIN_PASSWORD=whatever
   npm start` in its folder, then sign up as the admin at
   `http://localhost:3000`.
2. In its **Account Manager → Sites**, add a site named `events`. Copy
   the key it shows (it's only shown once), and switch on **Allows quick
   (unverified) accounts** for it. Without that switch, quick accounts
   are signed out here and get sent to verify their email instead.
3. Here:

   ```bash
   npm install
   CANOPY_ACCOUNT_URL=http://localhost:3000 CANOPY_ACCOUNT_KEY=<the key> PORT=3001 npm start
   ```

   (or put those in a `.env` you load yourself; `.env.example` lists
   them all). Without `CANOPY_ACCOUNT_URL` and `CANOPY_ACCOUNT_KEY` the
   server stops at startup and says so.
4. Open `http://localhost:3001/docs` for the API. With the cookie from
   signing in at `:3000`, the API answers as you; `docs/api.md` has curl
   examples with a bearer token.

Locally, `http://localhost` passes the Origin check and event links say
`http://localhost:3001/e/<id>`. Neither holds with `NODE_ENV=production`,
which the Dockerfile sets.

`npm test` runs the tests (Node 22). They need nothing running: each
starts its own server and fake account service.

## Deploying on Coolify

The repo has a `Dockerfile`, the same as the account service's. It builds
`better-sqlite3` in a throwaway stage and checks the build actually
works, so a broken install fails the build rather than the deploy. It
runs as `NODE_ENV=production`, port 3000, `DATA_DIR=/app/data`.

1. New resource from this repository, branch **`main`**, build pack
   **Dockerfile**. Coolify deploys `main` whenever it changes.
2. **Domains**: `https://events.canopysf.com`. It has to be under
   `canopysf.com`: the browser only sends the Canopy cookie to
   `canopysf.com` and its subdomains, and the Origin check only accepts
   Canopy pages.
3. **Ports Exposes**: `3000`.
4. **Persistent storage.** In the **Storages** tab, add a volume with
   **Destination Path `/app/data`** (name it anything, e.g.
   `canopy-events-data`). The database and its snapshots live there.
   Without it, every redeploy starts from an empty disk and every event
   is gone. The Dockerfile's `VOLUME` line doesn't do this by itself.
5. **Environment variables**, from `.env.example`:
   - `CANOPY_ACCOUNT_URL`: `https://account.canopysf.com` (or the account
     service's address on Coolify's internal network).
   - `CANOPY_ACCOUNT_KEY`: the key from the account service's **Sites**
     tab for a site named `events`, with **Allows quick (unverified)
     accounts** switched on.
   - `PUBLIC_URL` and `CANOPY_DOMAIN`: leave unset. They default to
     `https://events.canopysf.com` and `canopysf.com`.
   - Leave `PORT` and `DATA_DIR` alone. The Dockerfile sets them.
6. Deploy.

### Confirming the volume is attached

Every startup logs how many events it found:

```
[canopy-events] DATA_DIR=/app/data (42 events found on disk at startup)
```

If it says `0` when you know there are events, the volume isn't attached
(the Storages tab is empty, the path isn't `/app/data`, or it was added
without a redeploy since). On a brand-new install, 0 is right.

## Storage & backups

Everything is in `DATA_DIR` (`/app/data` in the container):

- `events.db` is the database (SQLite, WAL mode, so `events.db-wal` and
  `events.db-shm` sit beside it while it's open);
- `backups/sqlite/events-YYYY-MM-DD.db` holds the snapshots.

Its tables are `events`, `hosts` (who hosts each event: the creator, and
co-hosts later) and `rsvps` (one row per person per event: invited, or
their answer). There are no names, emails or photos: only person ids.
Friends aren't stored at all; they're worked out from `hosts` and `rsvps`
each time.

**Schema version.** It's in SQLite's `user_version`. A new `events.db` is
made with the whole current schema. One at an older version is brought up
to date one step at a time (`UPGRADES` in `lib/db.js`), in one
transaction, so a step that fails leaves the file as it was. One at a
version this code doesn't know is refused at startup rather than opened.
Version 1 is what first shipped, and since Coolify deploys `main`, it's
frozen: `test/fixtures/schema-v1.sql` is a copy of it, and a test checks
that a file made from it and upgraded comes out the same shape as a new
one. Changing the schema means a new step in `UPGRADES`, the new shape in
`createSchema`, and `SCHEMA_VERSION` up by one; `lib/db.js` says how.

**Backups.** Two layers, the same as the account service:

- The service writes a consistent copy of the database, using SQLite's
  own online backup, to `backups/sqlite/events-YYYY-MM-DD.db` when it
  starts and every 24 hours after. It keeps the newest **14**. These are
  the ones to restore from.
- In Coolify, on this application: **Backups → Scheduled Backups → Add**,
  pointing at the `/app/data` volume, daily. That archives the whole
  volume. Coolify copies files as they sit on disk, and its copy of the
  live `events.db` can come out inconsistent if it's taken mid-write.
  That's why the snapshots exist.

**Restoring.** Stop the service. Copy the snapshot you want over
`events.db` and delete `events.db-wal` and `events.db-shm` (otherwise
SQLite replays the newer write log on top of the older snapshot). Start
the service and check the events count in the log.

Nothing in the database signs anyone in. It does hold every event's id,
and an id is the link: anyone with a copy can open every event in it and
see who answered what. Treat a copy like the guest lists it is.
