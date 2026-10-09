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
- **Lists** are a person's own, private list of people who joined it
  themselves, by its link or QR code (`/l/<code>`). A host puts one on an
  event and everyone on it is invited; anyone who joins later is invited
  to its events still to come. For a weekly night: the QR code at the
  door, and newcomers get invited to the next one. Only the owner sees
  who's on a list.
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
by phone or Instagram; and each event's color. The web pages (below)
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
  and serving them at `/covers/`), `backgrounds.js` (the curated
  backgrounds from TMDB), `notifications.js` (your inbox and
  your phones), `friends.js` (your friends, adding and taking people
  out, friend links), `lists.js` (your lists, joining by link, and lists
  on events), `me.js` (you, your events) and `docs.js`
  (the spec and `/docs`). A new
  subject is a new file here, so work on different subjects doesn't
  collide. `pages.js` is the web pages (see "The pages").
- `lib/` is what the routes share:
  - `db.js` is persistence: one SQLite file, `DATA_DIR/events.db`, with
    the schema, its version and upgrades, and the daily snapshots. The
    queries are in `lib/store/`, one file per subject (`events.js`,
    `rsvps.js`, `hosts.js`, `waitlist.js`, `wall.js`, `notifications.js`,
    `friends.js`, `lists.js`, `people.js`, `calendar.js`), and `init()` hands them back
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
  - `backgrounds.js` is the curated backgrounds from TMDB (see
    "Backgrounds"): `config/backgrounds.json` and, optionally, a TMDB
    list, cached in memory and refreshed daily.
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
  the creator. The test servers keep idle connections open for the whole
  file (`KEEP_ALIVE_TIMEOUT_MS` on the server; unset, it's Node's 5 s), so
  a process starved of CPU in a parallel run can't drop a request at the
  keep-alive deadline (`test/harness.test.js`).

`GET /healthz` answers `{"ok":true}`, and `GET /favicon.ico` answers an
empty 204.

## The pages

Server-sent HTML and plain JavaScript, with no framework and no build
step, the same as the account service. Phone first: most people open an
event link on a phone.

| | |
|---|---|
| `/e/<id>` | **An event**, what a shared link opens, drawn in the event's color. On top, the cover (or a generated picture) as a 3:2 hero fading into the page, the title on the fade, and **when**, big: the day, the time, and a pill saying how soon ("Tomorrow", "This Saturday"). Then a card with the place, the hosts, the counts (people and their plus-ones), spots left, the host's **details** (a link, the dress code, food, parking, where to stay, a phone number: a row each with its icon) and the description. Signed out: no address, no parking, place to stay or phone number (a line says more details show once you sign in), and a big **RSVP** to the account service's quick sign-up, with a smaller "I have a Canopy Account, sign in". Signed in: going / maybe / can't go, how many guests you're bringing (when the host allows any), the waitlist when it's full, friends going, who's coming by the host's visibility rule, and the **wall** (posts, and what happened: "Ana is going", "the time changed"), with a box to post in once you've answered. A guest's **⋯ menu** on their answer card: mute the event, opt out of invites from each host (or allow them again), and remove themselves from the event (asked first). Hosts get share, invite, edit and the guest list with **Remove** (and the removed, with Undo) instead of answering; the creator also cancels, makes a **new link**, and adds and removes **co-hosts**; a co-host can step down. Any host's ⋯ menu has **Lists…** (put their lists on the event, which invites everyone on them, take them off, or make one) and, with lists on it, **Show list QR** (a sheet with each list's QR code, big, for the door); and **Duplicate**, for a host who may make events: the editor for a new event, filled in from this one with no date or times (`/new?from=<id>`). A guest (or someone signed out) not on a list that's on the event sees **"Get invited next time"** with "Join <list>". Someone a host removed sees the public details and a calm line saying they're not on the list. |
| `/` | **Your events**: invitations (going or can't go right there), what you're hosting, what's coming up, and what's past, each row a 3:2 picture, the date in bold, the title and the place. "New event" for verified people; unverified people get a line saying to confirm their email to host. Signed out: what this is, and sign in. |
| `/new`, `/new?from=<id>`, `/e/<id>/edit` | **The editor**, drawn like the event page: the cover as the hero (an upload button, a button to choose one of the curated backgrounds when there are any, and a × on it, sent on save), the title typed where it shows, the date and times as big as the page's (each tapped to change: the system's pickers on a phone or tablet, and with a mouse or trackpad one popover with a month and a time field that takes any minute, like 7:57 PM, over a list of quarter hours; a new event, a duplicate too, starts at 7 PM once its day is picked), the time zone by friendly name with a "Change" menu (nearby zones first, then a search of all), the place and address, the description, chips under it to add **details** ("+ Link", "+ Info", "+ Dress code", "+ Food", "+ Parking", "+ Stay", "+ Phone"; a row each, with a ×), who sees the guest list, plus-ones, capacity, and the event's color (a slider that repaints the page as you drag). No help text. Verified people make events; hosts edit them. What the API refuses shows under the field it's about. `?from=<id>` is a **duplicate**: the new-event form filled in from the API's draft of that event (everything but the date and times, which start empty), its cover copied on save; nothing exists until then. A copy of an event that had the host's lists on it opens on the event page with **Lists…** showing (`?lists=1`), since lists are never copied. |
| `/e/<id>/invite` | **Inviting** is a sheet over the event page now (the host's "Invite"); this address opens the event with the sheet open. One search box (names, and a whole phone number or @username looks that person up, verified hosts only, a name and a photo back); your lists, each with "Invite all <n>"; "Invite everyone from…" a past event (its hosts and going and maybe guests); Suggested (`GET /api/v1/me/friends/suggested`); then everyone else, A to Z. People already on the event stay in the list, greyed, with their status badge. The picked are a row of faces at the foot, with "Invite 7". |
| `/e/<id>/cohosts` | **Adding co-hosts** (the creator): your friends with a search box and "Add"; anyone who can't co-host yet (an unconfirmed email) is told why under their row. |
| `/friends` | **Your friends**: your friend link with Share, Copy and its QR code (drawn on the server as an inline SVG, `lib/qr.js`), and Reset; **your lists** (each with its link, Share, Copy, its QR code, Rename, Reset link, Delete, and who's on it with Remove; making one is a name and nothing else, verified people only); "Add by phone or Instagram" (verified people; the invite page's lookup, with "Add friend"); and your list, how each is in it, with Remove (asked first); the **lists you're on**, with Leave; and, when there are any, the hosts whose invitations you've opted out of, with Undo. |
| `/l/<code>` | **A list's link**: the list's name and its owner. Signed out, "Sign up to join" (quick sign-up) or sign in, coming back here. Signed in, "Join Ana's Drag Race? Ana will be able to invite you to events." with one button, then it says so in place, with the invitations it brought; opening the page joins nobody. Its QR code is `/l/<code>/qr.svg`, drawn on the server (`lib/qr.js`). Link previews get the list's name and the owner's first name, no photo. |
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
adds only what events needs, from the same color pairs (their contrast
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
44px. **Event colors**: an event's `themeHue` turns the page's mesh to
that hue in OKLCH, keeping every color's lightness, so contrast is the
same at every hue (`public/ui.js` `themeColors`; docs/api.md, "Event
colors"). Buttons and links stay Canopy green.

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
| `GET /api/v1/backgrounds` | the curated backgrounds from TMDB (signed in) |
| `PUT /api/v1/events/{id}/cover/background` | make one of them the cover, as an upload does (hosts) |
| `GET /covers/<key>.jpg`, `/covers/<key>-<width>.jpg` | a cover image at full size, or a narrower copy; public (for link previews) |
| `GET /api/v1/me/notifications`, `/unread` | your inbox, and its unread count |
| `POST /api/v1/me/notifications/read`, `/read-all` | mark some, or all, read |
| `POST`, `DELETE /api/v1/me/devices` | register a phone for push, or stop |
| `PUT`, `DELETE /api/v1/events/{id}/removed/{personId}` | remove a guest, or undo it (hosts) |
| `POST /api/v1/events/{id}/new-link` | give the event a new link; the old one stops working (the creator) |
| `POST /api/v1/people/lookup` | find someone to invite by exact phone or Instagram, in the body, never the URL (verified people) |
| `PUT /api/v1/events/{id}/rsvp` | answer: going, maybe, not_going; an answer changes but is never taken back |
| `GET /api/v1/events/{id}/guests` | the guest list, by the visibility rule |
| `POST /api/v1/events/{id}/invites` | invite people by id (hosts) |
| `DELETE /api/v1/events/{id}/invites/{personId}` | take back an unanswered invitation (hosts) |
| `GET /api/v1/me` | you (name, photo, `emailVerified`; no contact details) |
| `GET /api/v1/me/friends` | your friends, how each is in your list, and events in common |
| `POST /api/v1/me/friends` | add someone by id, one way (verified people) |
| `DELETE /api/v1/me/friends/{personId}` | take someone out of your list, whatever way they're in it |
| `GET /api/v1/me/friend-link`, `POST .../reset` | your friend link (made on first use), or a new one |
| `PUT`, `DELETE /api/v1/events/{id}/mute` | mute an event's chatter, or unmute it (guests) |
| `POST /api/v1/events/{id}/leave` | take yourself off an event entirely (guests; not hosts) |
| `GET /api/v1/me/invite-optouts`, `PUT`, `DELETE .../{personId}` | the hosts whose invitations you've opted out of; opt out, or back in |
| `GET /api/v1/me/friends/suggested` | friends to suggest first when inviting, best first, with a `score` (docs/api.md says how) |
| `GET`, `POST /api/v1/me/lists` | your lists (with how many are on each), or a new one (verified people) |
| `PATCH`, `DELETE /api/v1/me/lists/{listId}`, `POST .../reset-link` | rename, delete, or a new join link |
| `GET /api/v1/me/lists/{listId}/members`, `DELETE .../{personId}` | who's on a list of yours (only ever to you), or take someone off |
| `GET /api/v1/me/list-memberships`, `DELETE .../{listId}` | the lists you're on (name and owner only), or leave one |
| `GET /api/v1/list-links/{code}`, `POST .../join` | a list's name and owner (anyone with the link), or join it: invited to its events still to come |
| `PUT`, `DELETE /api/v1/events/{id}/lists/{listId}` | put one of your lists on an event (hosts): everyone on it is invited; or take it off |
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
name, hosts, status and counts, and the event's public details (links,
info, dress code, food). Not the guest list, not the street address and
not the details that can hold one (parking, where to stay, a phone
number; `hiddenDetails` counts them): previews are fetched and kept by
machines (Slack, iMessage, crawlers), and a home address shouldn't end up
in their caches. Anyone signed in, even with a quick account, sees them,
except someone a host removed.

**Event details** (`lib/details.js`) are optional extra fields: `details`,
up to 10 of `{type, label, value}` (`link`, `info`, `dress_code`, `food`,
`parking`, `accommodation`, `phone`), set on create and replaced whole by
`PATCH`, stored as one JSON column on the event (schema version 13). Links
are http(s) only, checked and tidied on the way in; phone numbers get a
`tel:` `href`. docs/api.md ("Event details") has the rest.

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
description: their part in it, the host's description, the event's
details (every one, parking and phone included), and the link again
(Google doesn't show the link otherwise). **Never anyone else**: no
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

## Internal: the Account Manager's test people tools

The account service's admin page has buttons that act on events for its
**test people** (made-up Canopy Accounts; see "Seeding test guests"
below): make the admin friends with all of them, make past events with
them, and clear both away when they're deleted. Events does it at
`/api/internal` (`routes/internal.js`), outside `/api/v1`. It isn't the
apps' API and isn't in `openapi.yaml`; only the account service calls it.

| Request | Body | Answer |
|---|---|---|
| `POST /api/internal/test-friends` | `{ personId, friendIds: [...] }` (1 to 200 ids) | `{ added, alreadyFriends }` |
| `POST /api/internal/test-friends/remove` | `{ personIds: [...] }` (1 to 200) | `{ removed }` (edges) |
| `POST /api/internal/test-events` | `{ personId, testPeopleIds: [...], count }` (count 1 to 20) | `{ created }` |
| `DELETE /api/internal/test-events` | none | `{ deleted }` |

**Signed, like the calendar's requests, but bound to what each one is
for.** `Authorization: Canopy-Internal t=<unix seconds>, n=<32 hex>,
sig=<hex>`, sig being HMAC-SHA256 with the same calendar secret
(`CANOPY_CALENDAR_SECRET`) of
`canopy-internal-v1\n<purpose>\n<METHOD>\n<path and query>\n<t>\n<n>\n<SHA-256 of the body>`.
The purpose is `test-friends` or `test-events`; the body is the JSON as
`JSON.stringify` writes it (`''` for none). So a signature is good for one
request, within a minute either way of now, and only once (each `n` is
remembered for that minute; a double click is two requests with two
`n`s). A calendar signature can't pass for one of these, nor one of these
for a calendar request: a different scheme name and a different string
signed. `lib/canopy-account.js` `verifyInternalRequest(req, purpose)`
checks it, and `internalAuthorization` (used by the account service, and
by the tests) makes it. Anything else is a `401`, as is everything while
`CANOPY_CALENDAR_SECRET` isn't set. Unknown paths under `/api/internal`
are a JSON `404`, which the account service takes as "this site doesn't
do that".

**What they do.**

- **test-friends**: `'link'` edges both ways between `personId` and each
  id, exactly what each test person saying yes to the admin's friend link
  would make, and any hiding either way undone (the admin asked for all
  of them). Idempotent: `added` counts the ids where anything changed,
  `alreadyFriends` the rest. **remove** deletes every edge to or from those
  ids, any hiding of them or by them, and their friend links.
- **test-events**: `count` past events (`lib/store/testEvents.js`),
  spread over the last six months, an evening each, every other one
  hosted by `personId` and the rest by a test person with `personId`
  going (now and then maybe). Guests are drawn with a lean, so a few test
  people are at most events and the rest at fewer, about one in five
  saying maybe: the inviter's Suggested gets a real order. Written straight
  into the tables (the API won't make an event in the past), so nothing
  else happens: no Updates entries, no notifications or pushes, no
  invitation friend edges, nobody marked as having hosted. Each is marked
  `events.is_test` (schema version 16), has no cover, no color (gray) and a
  description saying it's made up, and never goes in a calendar feed. At
  most 100 at once (`409 too_many_test_events`). **DELETE** deletes every
  one, with its hosts, answers and anything under it (and a cover, if
  someone gave one).

Events can't tell a test person from anyone else (the account service
never says); it takes the account service's word for the ids, which only
ever sends `is_test` people's, and the signed-in admin's own as
`personId`.

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

**The account service's signed requests to `/api/internal` skip it too**
(see above): server to server, no `Origin`, no cookie read, and an
`Authorization: Canopy-Internal` header that a page elsewhere can't send
without asking first either.

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
| Cover uploads (and backgrounds chosen, counted together) | 30 a day | 100 a day | 2,000 a day |
| Adding friends (by id, or a friend link; every try counts) | 200 a day | 500 a day | 5,000 a day |
| Friend links that find nobody | | 60 an hour | |
| Making lists | 20 a day (50 in all) | 60 a day | 1,000 a day |
| Joining lists (every try counts) | 200 a day | 500 a day | 5,000 a day |
| List links that find nothing | | 60 an hour | |

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

## Seeding test guests

`scripts/seed-guests.js` fills real events, and your friends list, with
**test people**: made-up Canopy Accounts the account service's admin
creates for exactly this (see "Admin: test people" in its README). It
acts as each of them through the ordinary API with their bearer tokens,
so everything it makes is what real guests would make, and everything is
taken off again by `cleanup`. Plain Node 22, nothing to install. It never
touches your own account: it has only the test people's tokens.

**No script needed for a friends list and history.** The Account
Manager's **Test people** section does the common part with buttons:
**Create test people** (each with a photo from pravatar), **Make me
friends with all test people** (they're all in your friends list and
invite picker, and you in theirs), and **Make past events with me** (6
past events with you and them, so the inviter's Suggested has history
and an order). That last one is something the script can't do: it never
has your token. See "Internal: the Account Manager's test people tools"
above for how events does it. The script is for filling real events with
answers and updates, and for history among the test people themselves.

1. **Create test people.** Account Manager → **People** → **Test
   people**: type how many (1 to 50 at a time; press it again for more)
   and **Create test people**. 30 to 40 makes a realistic friends list
   and invite picker. Each gets an orange **Test** badge, and a photo
   (**Add photos** fetches any that didn't come).
2. **Get tokens.** **Get tokens** there shows them once; **Download**
   saves `canopy-test-tokens.json`. Anyone with this file is signed in as
   those test people, so keep it out of the repo. Pressing it again makes
   new tokens and signs the old ones out.
3. **Make them your friends.** **Make me friends with all test people**
   in the Account Manager does it in one go. Or with the script: copy your
   friend link (Friends → your link,
   `https://events.canopysf.com/f/<code>`), then:

   ```bash
   node scripts/seed-guests.js friends --tokens canopy-test-tokens.json \
     --friend-link https://events.canopysf.com/f/<code> --photos --history 5
   ```

   Every test person says yes to your link, so they're all in your friends
   list and invite picker (a link works both ways). `--photos` gives each
   one without a photo an avatar (from `https://i.pravatar.cc`, uploaded
   to their Canopy Account; skipped quietly if either can't be reached).
   `--history <n>` makes n past events (at most 20), each hosted by a test
   person with other test people going, so the test people have events in
   common and a "last together" with each other. **Your own** events in
   common with them can't be made this way: that would take your token,
   which the script never has. **Make past events with me** in the
   Account Manager makes those.
4. **Optionally, fill events.** For events you made (or any you have the
   link to):

   ```bash
   node scripts/seed-guests.js seed --tokens canopy-test-tokens.json \
     --event https://events.canopysf.com/e/<id> --event <another id> --updates
   ```

   For each event, 60 to 85% of the test people answer (or `--answers
   <n>`): mostly going, some maybe, a few can't go, and about a quarter of
   those coming bring a plus-one when the event allows them. With a
   capacity, the "going" answers that don't fit land on the waitlist, the
   way they would for anyone. `--updates` has a few of them post a short,
   friendly line on each event's Updates (at most 4 from test people per
   event, one each). Running it again tops up to the same mix rather than
   adding more, and skips anyone who already answered or posted.
   `--friend-link` and `--photos` work here too. Cancelled and finished
   events are skipped.
5. **Clean up.**

   ```bash
   node scripts/seed-guests.js cleanup --tokens canopy-test-tokens.json
   ```

   For every test person: their updates are deleted, they leave every
   event they're on (from their events lists, `/declined`, and the events
   the script remembers touching), any event they made (the `--history`
   ones) is deleted, and everyone is taken out of their friends list.
6. **Delete the test people.** Account Manager → **Delete all test
   people**. First events deletes every test event and every friendship
   with them (both ways), then their accounts go (photos included). If
   events can't be reached, the page says so and the accounts go anyway;
   a deleted account is left out of every friends list, so the leftovers
   don't show, and the next **Delete all test people** clears the test
   events.

Every command takes `--dry-run` (reads, but changes nothing, and prints
what it would do), `--base <url>` for another events site (default
`https://events.canopysf.com`, or the site of the first link you give),
`--account-url` for another account service (for `--photos`), and
`--concurrency` / `--delay` (3 at a time, 150 ms after each request). A
429 is waited out. The events it touched are remembered next to the
tokens file (`canopy-test-tokens.state.json`) for `cleanup`, which
deletes it when it's done; `--event` on `cleanup` adds more.

Locally: `--base http://localhost:3001 --account-url http://localhost:3000`.

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
     isn't in anyone's Canopy calendar (see "Calendar"), and the Account
     Manager's test people buttons can't reach events (see "Internal: the
     Account Manager's test people tools").
   - `TMDB_TOKEN` and `TMDB_LIST_ID` (optional): a TMDB list of films
     and shows whose backdrops join the curated backgrounds. See
     "Backgrounds". `config/backgrounds.json` works without them.
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

## Backgrounds

Hosts can choose a cover from a curated set of film and TV backdrops
from TMDB (The Movie Database) instead of uploading a photo: the second
button on the editor's photo. Choosing one makes it the cover exactly as
an upload does (the server downloads TMDB's full-size image and runs it
through the upload's pipeline), so from then on it's an ordinary cover.
With nothing curated, there's no button and nothing else changes.

The set is, in order:

1. **`config/backgrounds.json`**, the owner's hand-picked backdrops, in
   the order they show. Edit it by hand and redeploy. Each entry is one
   exact image:

   ```json
   [
     { "type": "movie", "tmdbId": 10625, "title": "Mean Girls", "filePath": "/cgFV761wxNtPxfVsEVSAM5xEkcG.jpg" },
     { "type": "tv", "tmdbId": 61662, "title": "Schitt's Creek", "filePath": "/1wFyBfKo6LpYppY9UABYkbv320s.jpg", "year": 2015 }
   ]
   ```

   - `type` is `"movie"` or `"tv"`, and `tmdbId` the number in the
     title's address on themoviedb.org (`/movie/10625-mean-girls`).
   - `title` is the name shown under its group in the picker. A title's
     entries are shown together, where its first one is.
   - `filePath` is the image's path on TMDB: on the title's page, open
     **Media → Backdrops**, open the image, and take the last part of its
     address (`https://image.tmdb.org/t/p/original/cgFV761wxNtPxfVsEVSAM5xEkcG.jpg`
     → `/cgFV761wxNtPxfVsEVSAM5xEkcG.jpg`).
   - `year` is optional, shown after the title.

   It holds references only, never image data. An entry that's wrong is
   skipped, and the log says which and why at startup; an image TMDB
   doesn't have is left out (and the log says how many). These need no
   TMDB token: the images are on TMDB's public image CDN.
2. **A TMDB list** (optional), with `TMDB_TOKEN` and `TMDB_LIST_ID` set:
   for each film or show on it, up to three of its best backdrops
   without text on them (by TMDB's votes, then size), or its others if
   it has none without text. To make one: sign in at themoviedb.org,
   open your profile's **Lists → Create List**, add films and shows, and
   take the number in the list's address (`/list/8512345` →
   `TMDB_LIST_ID=8512345`). The token is the **API Read Access Token**
   (v4) from **Settings → API** (request an API key first if there isn't
   one). It's sent only to TMDB's API, never to a browser or an app.

The same image twice is shown once. The set is loaded when the server
starts and again every day, in memory; a refresh that fails keeps what
there was. The server fetches each image's 300 px thumbnail once, to
work out the color that matches it, so picking one moves the editor's
color slider (and the apps can do the same, from `hue`).

**Attribution.** TMDB's terms ask for their logo and "This product uses
the TMDB API but is not endorsed or certified by TMDB." It's at the foot
of the picker and, small, at the foot of Your Events, whenever there are
backgrounds.

`TMDB_API_BASE` and `TMDB_IMAGE_BASE` point it at a fake TMDB, for the
tests (`test/fakeTmdb.js`); they're ignored in production.

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
