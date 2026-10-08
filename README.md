# Canopy Events

`events.canopysf.com`. A simple event service, like Partiful, but built
around friends. A host makes an event and shares its link. People open
the link, sign in (or quick-sign-up), and say **going**, **maybe** or
**can't go**.

- **Anyone with the link** can see an event. The id is the link
  (`events.canopysf.com/e/<id>`): 12 random characters, so it can't be
  guessed, and there's no listing or search.
- **Your friends are a list, one way, like following.** Everyone you've
  been at an event with (hosting it, or "going", once it has started and
  if it wasn't cancelled), plus anyone you've added: through your or their
  **friend link** (or its QR code; both ways, since sharing it is saying
  yes), by **phone or Instagram** (one way), or by an **invitation**
  either way. There are no friend requests, nobody is told they were
  added, and only you see your list. Friends are who a host picks from to
  invite, and who's called out as "friends going".
- **The guest list is the host's choice**, per event: everyone with the
  link sees the names, or only people who've answered do (everyone else
  sees counts). Hosts always see everything.
- **Contact details never leak.** Nobody is ever shown anyone else's
  email, phone, Instagram, Venmo or Cash App, not even a host looking at
  their own guests. Other people are a name and a photo. Events doesn't
  even hold the visitor's own: the account service is set up to tell it
  none of them.
- It has a **fully documented JSON API** (`/api/v1`, OpenAPI 3.1, rendered
  at `/docs`), so the iOS and Android apps can be built on it without
  touching the server. The web pages use the same API.

**What this isn't.** It keeps no accounts of its own. Everyone is a
Canopy Account (`account.canopysf.com`, the `canopy-account-service`
repo), and events stores only their ids, the same as tickets. There's no
email or text sent from here, no `.ics` of its own (each person's
calendar feed is the account service's, which asks events for their part:
see "Calendar"), no tickets or payments, and no public discovery. `docs/decisions.md` is the source of truth for what's
in and out.

**Where it's up to.** All of v1 (`docs/decisions.md`, "v1 scope") is in
the API: events, answers, the guest list, invitations, friends and your
events; co-hosts and plus-ones; the activity wall; cover images and
capacity with a waitlist; notifications (the inbox and phone
registration; push itself only logs until the APNs and FCM keys come
with the apps); removing guests and making a new link; and finding people
by phone or Instagram; and each event's colour. The web pages (below)
cover all of it except notifications, which belong to the apps.

## How it works

- `server.js` is the Express app's wiring: the two checks every request
  goes through, the response headers (no framing, no MIME sniffing, no
  full URLs in `Referer`) and the Origin check (below); then the API's
  routers, the docs, `/healthz` and the static files; and the error
  handler that keeps every API error in one shape.
- `routes/` is the API, one file per subject, each mounted at `/api/v1`:
  `events.js` (making, reading, editing and cancelling events),
  `calendar.js` (someone's events for their Canopy calendar, asked by
  the account service, outside `/api/v1`),
  `rsvps.js` (answers, the guest list, invitations), `hosts.js`
  (co-hosts), `wall.js` (the activity wall), `moderation.js` (removing
  guests, new links), `people.js` (finding someone by phone or
  Instagram), `covers.js` (cover images,
  and serving them at `/covers/`), `notifications.js` (your inbox and
  your phones), `friends.js` (your friends, adding and taking people
  out, friend links), `me.js` (you, your events) and `docs.js`
  (the spec and `/docs`). A new
  subject is a new file here, so work on different subjects doesn't
  collide. `pages.js` is the web pages (see "The pages").
- `lib/` is what the routes share:
  - `db.js` is persistence: one SQLite file, `DATA_DIR/events.db`, with
    the schema, its version and upgrades, and the daily snapshots. The
    queries are in `lib/store/`, one file per subject (`events.js`,
    `rsvps.js`, `hosts.js`, `waitlist.js`, `wall.js`, `notifications.js`,
    `friends.js`, `people.js`, `calendar.js`), and `init()` hands them back
    as one store.
  - `notify.js` is the one way anyone hears about anything: it writes
    the inbox entry and queues the push in one call, and never tells the
    person who did it. `push.js` sends to their phones; for now its
    sender only logs (the APNs and FCM senders need the apps' keys).
  - `coverImage.js` turns an uploaded photo into the stored JPEGs, the
    full size (up to 1600 px) and copies 400, 800 and 1200 px wide (with
    `sharp`, and `heic-decode` for iPhone photos), in a worker thread
    (`coverWorker.js`, one upload at a time) so the HEIC decoder, which
    is synchronous, never holds up other requests. `coverStore.js` keeps
    them in `DATA_DIR/covers`. `coverBackfill.js` makes the copies for
    covers uploaded before there were any, after the server starts.
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
  - `render.js` sends a page: a file from `views/` with its placeholders
    filled, its scripts and stylesheet inlined, the verify banner, and
    an event's link preview tags.
  - `canopy-account.js` is the account service's
    `client/canopy-account.js`, copied in **unchanged**. Update it by
    copying the file again, never by editing it here.
- `views/` and `public/` are the pages: one HTML file per page in
  `views/`, and in `public/` the shared `events.css`, `copy.js` (every
  sentence the pages say), `ui.js` (draws the pages' content) and
  `events.js` (the browser side: the API, photos, the time zone).
- `openapi.yaml` is the API's contract. `docs/api.md` is the guide for app
  developers. `public/vendor/redoc-2.5.4/` is the renderer `/docs` uses.
- `test/` uses `node:test`. Each file starts the real server in a child
  process on a scratch `DATA_DIR`, against a fake account service
  (`test/fakeAccount.js`). `npm test` runs them all. `pages.test.js` holds
  the pages to the same rules, as someone signed out, an unverified
  account, a guest, someone waitlisted, someone removed, a co-host and
  the creator.

`GET /healthz` answers `{"ok":true}`, and `GET /favicon.ico` answers an
empty 204.

## The pages

Server-sent HTML and plain JavaScript, with no framework and no build
step, the same as the account service. Phone first: most people open an
event link on a phone.

| | |
|---|---|
| `/e/<id>` | **An event**, what a shared link opens, drawn in the event's colour. On top, the cover (or a generated picture) as a 3:2 hero fading into the page, the title on the fade, and **when**, big: the day, the time, and a pill saying how soon ("Tomorrow", "This Saturday"). Then a card with the place, the hosts, the counts (people and their plus-ones) and spots left. Signed out: no address, and a big **RSVP** to the account service's quick sign-up, with a smaller "I have a Canopy Account, sign in". Signed in: going / maybe / can't go, how many guests you're bringing (when the host allows any), the waitlist when it's full, friends going, who's coming by the host's visibility rule, and the **wall** (posts, and what happened: "Ana is going", "the time changed"), with a box to post in once you've answered. Hosts get share, invite, edit and the guest list with **Remove** (and the removed, with Undo) instead of answering; the creator also cancels, makes a **new link**, and adds and removes **co-hosts**; a co-host can step down. Someone a host removed sees the public details and a calm line saying they're not on the list. |
| `/` | **Your events**: invitations (going or can't go right there), what you're hosting, what's coming up, and what's past, each row a 3:2 picture, the date in bold, the title and the place. "New event" for verified people; unverified people get a line saying to confirm their email to host. Signed out: what this is, and sign in. |
| `/new`, `/e/<id>/edit` | **The editor**, drawn like the event page: the cover as the hero (an upload button and a × on it, sent on save), the title typed where it shows, the date and times as big as the page's (each tapped to change), the time zone by friendly name with a "Change" menu (nearby zones first, then a search of all), the place and address, the description, who sees the guest list, plus-ones, capacity, and the event's colour (a slider that repaints the page as you drag). No help text. Verified people make events; hosts edit them. What the API refuses shows under the field it's about. |
| `/e/<id>/invite` | **Inviting** (hosts): find someone by their exact phone number or Instagram username (verified hosts; a name and a photo come back, never their details), then your friends with a search box, the ones already on the list (or removed, or hosting) marked. |
| `/e/<id>/cohosts` | **Adding co-hosts** (the creator): your friends with a search box and "Add"; anyone who can't co-host yet (an unconfirmed email) is told why under their row. |
| `/friends` | **Your friends**: your friend link with Share, Copy and its QR code (drawn on the server as an inline SVG, `lib/qr.js`), and Reset; "Add by phone or Instagram" (verified people; the invite page's lookup, with "Add friend"); and your list, how each is in it, with Remove (asked first). |
| `/f/<code>` | **Someone's friend link**: their name and photo. Signed out, "Sign up to add Ana" (quick sign-up) or sign in, coming back here. Signed in, "Add Ana Lima as a friend?" with one button, then your friends; opening the page adds nobody. Link previews get the first name only, no photo. |

Every page has the header (the logo, your events, friends, and your
photo, which opens your Canopy profile), a sign-out link at the bottom,
and, for an unverified account, a banner to confirm the email that can't
be closed. Anything else a browser asks for gets a "nothing here" page.

**The pages are a client of the API, like the apps.** A page asks this
server's own `/api/v1` for what it shows, as the visitor (over loopback,
with their cookie), draws it, and sends it with those answers inside for
its script to start from. So a page can't show more than the API gives
that visitor: the signed-out view, the guest list rule and the
never-leak rule are applied once, in `lib/views.js` and `lib/rules.js`,
and whatever the API learns later reaches the pages without a second copy
of the rules. Changes (answering, editing, inviting) are the page's
script calling the API with `fetch`. A 401 sends the visitor to sign in,
a 403 `email_unverified` to confirm their email, and a 503 says Canopy
accounts can't be reached.

**One renderer, in two places.** `public/ui.js` turns the API's answers
into HTML. The server runs it to draw each page before sending it, so
the page is there at once and a link preview has something to read; the
browser runs the same file to redraw after a change. Everything a person
typed goes through its `esc()`.

**Scripts and the stylesheet are inline**, put into each page by
`lib/render.js`, for the account service's reason: Cloudflare gives `.js`
files a 4-hour browser cache whatever the server says, so during a
deploy a phone could get the old script with the new page.

**The look is the account service's**: `public/events.css` starts with
its `account.css` tokens, mesh background and glass cards, copied, and
adds only what events needs, from the same colour pairs (their contrast
is worked out in the comment at the top). Keep the tokens in step with
that file. `public/canopy-logo.png` is its logo.

**Times** are always in the event's own time zone. When that isn't the
viewer's (their clock reads a different time), the event page says
"Times are in Pacific Time" (the zone's friendly name, `UI.zoneName`)
and lists add the zone's short name.
The browser tells the server its zone in a `tz` cookie, so pages after
the first are drawn right the first time.

**Link previews.** An event page carries Open Graph and Twitter tags:
the title, a line with the date, time and the place's name, and the
cover as `og:image` (`summary_large_image`) when there is one. Never the
street address (the preview is of what a signed-out visitor sees, and
previews are kept by the machines that fetch them) and never the
description. The page crops the cover to 3:2; the preview gets the whole
photo, at full size. The page's own covers (the hero, list thumbnails,
the editor's hero) have a `srcset` of every size, so a phone
downloads the 400 px copy for a thumbnail, not the 1600 px photo.

**The look.** Type is bigger than the account service's (17px body,
15px secondary, big bold titles; a scale of custom properties at the top
of the events half of `public/events.css`), and tap targets are at least
44px. **Event colours**: an event's `themeHue` turns the page's mesh to
that hue in OKLCH, keeping every colour's lightness, so contrast is the
same at every hue (`public/ui.js` `themeColors`; docs/api.md, "Event
colours"). Buttons and links stay Canopy green.

**Nothing is for search engines.** Events are link-only, so every page
says `noindex, nofollow` (a meta tag and `X-Robots-Tag`). Link previews
don't read either, so they still work.

**Photos** are the account service's `photoUrl`s in plain `<img>` tags:
the browser sends the Canopy cookie along. Signed out, the account
service won't give a photo, and a photo that won't load becomes the
person's initials.

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
  guest lists. They can't make events or co-host. Every page
  shows them a banner to verify that can't be dismissed, and the API
  says `emailVerified: false` so the apps show it too.
- **Deleted accounts.** When the account service no longer has someone,
  their answers stay here, and they show as a "Former member" with no
  photo.
- **Contact details.** Events shows nobody's email, phone, Instagram,
  Venmo or Cash App, not even your own, so it's granted none of them: in
  the account service's Sites tab, every contact-detail box for `events`
  stays unticked, and its `/api/session` answer leaves them out. What
  events never holds can't leak from its database, logs or caches.
  `/api/v1/me` is you without them; the apps read and change their own
  contact details at the account service (`/api/native/v1/me`). Even if
  they were sent, nothing here would pass them on: `lib/people.js` copies
  fields by name, and the tests (whose fake account service sends all
  five) walk every JSON answer in the whole suite and fail on anyone's
  details, yours included, turning up anywhere in it.

## The API

Everything under `/api/v1`. `openapi.yaml` is the full contract, served
at `/api/v1/openapi.yaml` and readable at `/docs`. `docs/api.md` explains
it for app developers: auth, the banner, the RSVP state machine, the
visibility rules, pagination, errors and limits, with curl examples.

| | |
|---|---|
| `POST /api/v1/events` | make an event (verified people) |
| `GET /api/v1/events/{id}` | one event (anyone with the link) |
| `PATCH /api/v1/events/{id}` | edit it (hosts), cancel or un-cancel it (the creator) |
| `DELETE /api/v1/events/{id}` | delete it and everything under it (the creator); nobody is notified |
| `POST /api/v1/events/{id}/cohosts` | make someone a co-host (the creator; verified people only) |
| `DELETE /api/v1/events/{id}/cohosts/{personId}` | take a co-host off (the creator), or step down |
| `GET /api/v1/events/{id}/wall` | the activity wall, newest first (whoever sees the guest list) |
| `POST /api/v1/events/{id}/wall` | post on it (hosts, going, maybe, waitlisted) |
| `DELETE /api/v1/events/{id}/wall/{entryId}` | delete a post (its author) or any entry (hosts) |
| `PUT`, `DELETE /api/v1/events/{id}/cover` | upload or remove the cover image (hosts) |
| `GET /covers/<key>.jpg`, `/covers/<key>-<width>.jpg` | a cover image at full size, or a narrower copy; public (for link previews) |
| `GET /api/v1/me/notifications`, `/unread` | your inbox, and its unread count |
| `POST /api/v1/me/notifications/read`, `/read-all` | mark some, or all, read |
| `POST`, `DELETE /api/v1/me/devices` | register a phone for push, or stop |
| `PUT`, `DELETE /api/v1/events/{id}/removed/{personId}` | remove a guest, or undo it (hosts) |
| `POST /api/v1/events/{id}/new-link` | give the event a new link; the old one stops working (the creator) |
| `POST /api/v1/people/lookup` | find someone to invite by exact phone or Instagram, in the body, never the URL (verified people) |
| `PUT /api/v1/events/{id}/rsvp` | answer: going, maybe, not_going |
| `DELETE /api/v1/events/{id}/rsvp` | take the answer back |
| `GET /api/v1/events/{id}/guests` | the guest list, by the visibility rule |
| `POST /api/v1/events/{id}/invites` | invite people by id (hosts) |
| `DELETE /api/v1/events/{id}/invites/{personId}` | take back an unanswered invitation (hosts) |
| `GET /api/v1/me` | you (name, photo, `emailVerified`; no contact details) |
| `GET /api/v1/me/friends` | your friends, how each is in your list, and events in common |
| `POST /api/v1/me/friends` | add someone by id, one way (verified people) |
| `DELETE /api/v1/me/friends/{personId}` | take someone out of your list, whatever way they're in it |
| `GET /api/v1/me/friend-link`, `POST .../reset` | your friend link (made on first use), or a new one |
| `GET /api/v1/friend-links/{code}` | whose link it is: a name and a photo (anyone with it) |
| `POST /api/v1/friend-links/{code}/accept` | say yes: you're friends both ways |
| `GET /api/v1/me/events/hosting`, `/upcoming`, `/invitations`, `/declined`, `/past` | your events |
| `GET`, `PATCH /api/v1/me/settings` | your settings: `calendarInvites` (invitations in your Canopy calendar; on by default) |
| `GET /api/calendar/{personId}` | someone's events for their Canopy calendar: **site to site**, signed by the account service, not for apps (see "Calendar") |

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

## Calendar

Everyone's **Canopy calendar** is one link from the account service
(`account.canopysf.com/cal/<secret>.ics`, on their Canopy profile and in
the apps), which their calendar app subscribes to. The account service
makes it by asking every Canopy site with a calendar for that person's
entries and merging them; its README ("Calendar feed", and "`GET
<site>/api/calendar/<personId>`" for the contract) has the whole story.
Events is the first site. Its part is `GET /api/calendar/<personId>`
(`routes/calendar.js`), outside `/api/v1`.

**Only the account service can ask.** Its requests are signed:
`Authorization: Canopy-Calendar t=<unix seconds>, sig=<hex>`, HMAC-SHA256
with the calendar secret the account admin's Sites tab showed for events,
set here as `CANOPY_CALENDAR_SECRET`, within five minutes of now.
`lib/canopy-account.js`'s `verifyCalendarRequest` checks it. Anything else
is a `401`: no signature, a bad one, someone else's, a stale one, and a
signed-in person's cookie or token. Without `CANOPY_CALENDAR_SECRET` every
request is refused, and the log says so at startup: events just isn't in
anyone's calendar. The secret is what makes this safe, so it's never
shown or logged; a new one is made in the Sites tab.

**What's in someone's calendar** (`lib/rules.js` `calendarStatus`):

| Their part | In the calendar |
|---|---|
| hosting or co-hosting | confirmed ("You're hosting.") |
| going | confirmed ("You're going.", with how many guests they're bringing) |
| maybe | tentative ("You said maybe.") |
| waitlisted | tentative ("On the waitlist.") |
| invited, not answered yet | tentative, titled "[INVITED] <title>" ("You're invited. Answer here: <link>"), unless they've turned **Show events I'm invited to** off |
| any of those, on a cancelled event | cancelled, until 30 days after it was to start |
| can't go, removed, invitation taken back | not in it |

From 90 days ago on (by start) and everything coming up. A deleted event
is simply gone. Answering an invitation changes the same entry (same UID,
newer `updatedAt`): going makes it confirmed with the plain title, maybe
tentative with the plain title, can't go takes it out. The setting is
each person's (`person_settings`, `GET`/`PATCH /api/v1/me/settings`,
`calendarInvites`, on by default), switched on the events home page's
**Calendar** card (with "Add to your calendar", which opens the Canopy
profile's calendar section) and in the app's Profile.

**What an entry says**: the title, when (UTC, plus the event's time zone;
no end time is `null`, which the feed shows as an hour), the place's name
and its address (everyone in the calendar is signed in and on the event,
so they see the address on its page too), the event's link, and a
description: their part in it, the host's description, and the link
again (Google doesn't show the link otherwise). **Never anyone else**: no
guest names, not the hosts' names, nobody's contact details. The feed ends
up on Google's and Apple's servers, and the tests (`test/calendar.test.js`,
and the leak walker on every answer) hold it to that.

**The UID is the event's own id** (`<events.id>@events.canopysf.com`),
which never changes, not its link (`public_id`), which a host's "new
link" replaces: a calendar app takes a new UID as a new event, and would
show it twice. The entry's link is the current one, so after a new link
the calendar points at the right page. `updatedAt` is when the event or
their part in it last changed (an edit, a new link, their answer, a
plus-one, being made a co-host), which is how a calendar app knows to
update the entry.

Someone events has never seen is `{"entries": []}`, never a 404. It isn't
limited: only the account service can ask, and it keeps each answer for
five minutes.

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
| Wall posts | 5 a minute, 100 a day | 20 a minute, 300 a day | 300 a minute, 5,000 a day |
| Cover uploads | 30 a day | 100 a day | 2,000 a day |
| Adding friends (by id, or a friend link; every try counts) | 200 a day | 500 a day | 5,000 a day |
| Friend links that find nobody | | 60 an hour | |

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
   are signed out here and get sent to verify their email instead. Switch
   on **Can find people by phone number or Instagram** too, or lookups
   answer 403 `lookup_not_allowed`. Leave every **Tell it the visitor's
   own** box (email, phone, Instagram, Venmo, Cash App) unticked: events
   uses none of them. For the calendar feed (optional, see
   "Calendar"), put `http://localhost:3001` in its **Calendar URL** and
   Save, and keep the calendar secret it shows for
   `CANOPY_CALENDAR_SECRET`.
3. Here:

   ```bash
   npm install
   CANOPY_ACCOUNT_URL=http://localhost:3000 CANOPY_ACCOUNT_KEY=<the key> PORT=3001 npm start
   ```

   Or copy `.env.example` to `.env`, fill it in, and run `node
   --env-file=.env server.js`. Without `CANOPY_ACCOUNT_URL` and
   `CANOPY_ACCOUNT_KEY` the server stops at startup and says so.
4. Open `http://localhost:3001/` for the pages, and
   `http://localhost:3001/docs` for the API. With the cookie from
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
works, so a broken install fails the build rather than the deploy. The
same stage makes a JPEG with `sharp` (cover images): sharp ships prebuilt
libvips for Alpine on x64 and arm64, so nothing compiles, but a missing
binary would otherwise only show at the first upload. HEIC photos are
decoded by `heic-decode`, which is WebAssembly, not native. It
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
     accounts** and **Can find people by phone number or Instagram**
     switched on, and **none** of the **Tell it the visitor's own** boxes
     ticked (events never shows anyone's email, phone, Instagram, Venmo or
     Cash App, its own visitor's included, so it shouldn't be sent them).
   - `CANOPY_CALENDAR_SECRET`: the calendar secret from the account
     service's **Sites** tab: put events' address in its **Calendar URL**
     (`https://events.canopysf.com`, or events' address on Coolify's
     internal network) and Save, and it's shown once. Without it, events
     isn't in anyone's Canopy calendar (see "Calendar").
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
- `backups/sqlite/events-YYYY-MM-DD.db` holds the snapshots;
- `covers/<event id>.jpg` holds the cover images at full size, and
  `covers/<event id>-<width>.jpg` their narrower copies (400, 800 and
  1200 px wide, those narrower than the photo; `lib/coverStore.js`).
  They're not in the snapshots: copy the folder too, or covers are lost.
  Losing only the copies is fine: clear `cover_sizes` in the database
  (`UPDATE events SET cover_sizes = NULL`) and restart, and the server
  makes them again from the full size.

Its tables are `events`, `hosts` (who hosts each event: the creator and
any co-hosts), `rsvps` (one row per person per event: invited, or their
answer), `wall` (the activity wall: posts, and the server's typed
entries), `notifications` (each person's inbox), `devices` (push tokens,
one phone each), `verified_people` (who events has seen signed in with a
proven email, since only they may co-host and the account service doesn't
say so about anyone but the visitor) and `hosted_people` (who has ever
hosted, for `/api/v1/me`'s `hasHosted`: once a host, always a host),
`friend_edges` (who has added whom, one way, and how), `hidden_friends`
(who each person took out of their list) and `friend_links` (each
person's friend link code) and `person_settings` (each person's
settings, a row only once they change one). There are no names, emails or photos: only
person ids. Friends from events together aren't stored; they're worked
out from `hosts` and `rsvps` each time, and the two friend tables are
added and taken away from that (`lib/store/friends.js`).

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

**An event's link isn't its `id`.** Every table points at `events.id`,
which never changes; the link is `events.public_id`, which "make a new
link" replaces. They start out the same. Anything that takes an id from
outside looks it up by `public_id` (`store.getEventByLink`), so an old
link finds nothing.

Nothing in the database signs anyone in. It does hold every event's
link, and the link is the key: anyone with a copy can open every event in
it and see who answered what. Treat a copy like the guest lists it is.
