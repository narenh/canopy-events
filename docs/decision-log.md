# Decision log

Every judgment call made during the build without asking, newest at the
bottom of each section, so they can be reviewed and reversed. **(You)**
marks the ones you made yourself, for context. `docs/decisions.md` is
the spec. This is the record of how we got there and what was assumed.

Format: decision · why · how to reverse.

## Accounts: quick sign-up (canopy-account-service)

- **(You)** Quick sign-up is first name, last name, email and a passkey,
  with no code and no photo. The passkey is required.
- **(You)** An email that already has an account gets "sign in instead",
  which reveals the account exists. Documented in the account README.
- **(You)** The verify nag can't be dismissed, and it never blocks
  anything.
- Reused the existing `email_verified_at` column as the marker (null
  means unverified). · It already existed. · n/a
- Everyone in the database at upgrade time counts as verified, including
  people whose email the admin had changed. · Otherwise existing people
  would lose access to tickets. · Re-null specific rows by hand.
- **Signing in by code to an unverified account takes it over:** its
  passkeys are removed and every other browser is signed out (the page
  warns first). · Otherwise someone who quick-signed-up with your email
  keeps a passkey on your now-verified account. · Cost: a real quick
  user who signs in by code on a second phone is signed out on the
  first. · Reverse in server.js's code-verify path (drop the passkey
  wipe).
- An email the admin edits is unverified until a code proves it. The
  admin can't edit their own email from Edit profile (409 `own_email`).
  · Otherwise the admin could lock themselves out of /admin. · n/a
- The normal sign-in page doesn't link to quick sign-up. Only sites send
  people to `?quick=1`. · `/` already makes verified accounts, so
  offering the weaker kind there didn't fit. · Add a link in welcome.html.
- Quick sign-up only works once an admin exists. · The same rule as
  every other sign-up. · n/a
- Quick sign-up limits: 10 tries per browser per 15 min, 20 per address
  per hour, 200 per hour overall; accounts made: 10 per address per
  hour, 50 per hour overall. · No email is sent, so there's no per-email
  limit to lean on. · lib/limits.js / server.js constants.
- A bearer token that's present but malformed means signed out. It
  never falls back to the cookie. · There's no ambiguity about who's
  asking. · client/canopy-account.js.
- `renewCookie` only comes back when the site sends
  `X-Canopy-Site-Host`, and the client leaves it off for bearer
  requests. · An app token must never become a cookie. · n/a

## Accounts: phone/Instagram lookup

- **(You)** Lookup is one-way: knowing the number or handle finds the
  account, and an account never gives up its contact details.
- "Let people who know your phone or Instagram find you" is **on by
  default**. · Lookup is useless if nobody is findable, and you have to
  already know the number. · `FINDABLE_BY_DEFAULT` in lib/db.js.
- Unverified accounts can be found. · Phone and Instagram are
  self-claimed for everyone, verified email or not. · server.js lookup
  query.
- When two accounts claim the same phone or handle, lookup returns
  nothing. · Neither claim is proven, and picking one could pick the
  impostor. · Cost: someone can hide you from lookup by claiming your
  number. The real fix is phone verification (SMS), later.
- Lookup limits: 30 per asker per hour and 100 per day, 60 per address
  per hour, 300 per hour overall (scraping caps out around 7,200 numbers
  a day). Sites need the `allows_lookup` switch, and only verified
  askers may look up. · Phone numbers can be enumerated. · lib/limits.js
  constants.
- The visitor's address for lookup limits comes from the site, in an
  `X-Canopy-Visitor-Ip` header. · Sites hold keys, so they're trusted
  for this. · n/a

## Events (canopy-events)

- **(You)** Friends are implicit, events are visible to anyone with the
  link, the host picks guest list visibility, and unverified accounts
  can RSVP but not host. It's a full web app with an `/api/v1` OpenAPI
  spec, and push is the only notification channel (the apps ship before
  launch).
- Event ids are 12 characters of base62 (about 71 bits). · The id is the
  only thing keeping a link-only event private. · lib.
- Signed-out visitors see the event details and counts, never guest
  names. · Link previews and the sign-in prompt still work. · The event
  serializer.
- Friends are defined as both at the same event: a host, or going,
  where the event has started and wasn't cancelled. *Maybe* doesn't
  count. · A friend is someone you were actually with. · lib friends
  query.
- **Schema counts as deployed from the first merge to main**, so every
  later change is a real migration. · Coolify auto-deploys main and
  keeps the database on a volume. · n/a
- The API takes invites by any person id. The web UI offers friends,
  and later lookup results. · So the lookup feeds straight in. · n/a
- Push notifications are built server side tonight (inbox, device
  registration, a placeholder sender that only logs). · Ready for the
  apps. The real APNs and FCM senders need keys. · n/a
- Host moderation (remove guest, make a new link) joins v1 after cover
  images and the waitlist. · Otherwise a leaked link can't be undone.

## Process

- canopy-account-service: straight to main, pushed after every green
  step. canopy-events: feature branches in worktrees, merged into main
  by the orchestrator and pushed.

## iOS app (canopy-events-ios)

- **(You)** The SwiftUI foundation is built tonight with mock data only,
  and no backend integration. Small files, organized for you to build
  on by hand.
- Work goes on branch `feat/ui-foundation`, merged to main by the
  orchestrator. · The same pattern as events. · n/a
- Mock data sits behind one `EventsRepository` protocol in the
  environment, and model property names match the API's JSON. · The
  real client becomes a drop-in later. · n/a
- **(You)** The deployment target is iOS 26.6, written in the most
  modern Swift that iOS 26 supports.
- The app moves to the **Swift 6 language mode** (if it builds cleanly),
  keeping MainActor default isolation and approachable concurrency. ·
  That's what "most modern Swift" means. · SWIFT_VERSION back to 5.0.
- Fixed the repo: `CanopyEvents/` was tracked as a gitlink (a submodule
  entry) to a commit that exists nowhere, so the Xcode project and Swift
  files weren't in git. They're now tracked as plain files (0e11c39,
  pushed together with your unpushed "add xcproj"). · Otherwise every
  commit would silently leave the code out. · n/a
- No test target yet, since adding one means editing the project file.
  · Left for you. · n/a
- The look uses the system's Liquid Glass tinted with Canopy green, plus
  a mesh background, rather than recreating the web's CSS. · It's
  native on iOS 27. · Design/ tokens.
- **(You)** Xcode Cloud builds from main, and you want a fresh build
  every so often, just not every few minutes. So the iOS agent merges
  compiling work into main and pushes about once or twice an hour, or
  after major milestones.
- **(You)** The iOS app stays fully mocked for now: no networking, no
  real passkey calls, no API client. The mock flows work end to end:
  fake sign-in and quick sign-up (with the verify banner and a fake
  verify), creating, editing and cancelling events, viewing them,
  RSVPs including plus-ones and the waitlist, the wall, invites and the
  inbox. All of it lives in memory behind protocols shaped like the API,
  and a fresh launch resets to the seed data.
- **(You)** The app has three tabs: **Events** (going and maybe),
  **Invites** (invited but not answered, with a link at the top to
  declined events) and **Profile** (your own info). There's no Friends
  or Inbox tab.
- **(You)** Hosting appears in stages. Someone who has never hosted
  gets three tabs, with a "+" on Events. Creating a first event (or
  being made a co-host) adds a **Hosting** tab and a quick-create
  button in the tab bar, which replaces the "+".
- Assumed: once a host, always a host (the tab stays even when every
  hosted event is past or cancelled). Once Hosting exists, hosted events
  live there, not in Events. Events keeps going, maybe and waitlisted
  (with a badge), plus a "Past events" link. The API gets
  `hasHosted` on `/me` to drive it.
- Assumed: friends appear only in the invite picker and as "friends
  going" on an event. Notifications get no screen for now; push covers
  them later. · They have nowhere else to go with three tabs.
- The API will need `GET /api/v1/me/events/declined` (not_going) for the
  Declined list. Noted for the next API pass. The mock app doesn't
  need it tonight.

## Accounts: native sign-in (canopy-account-service, `/api/native/v1`)

- **(You)** Built tonight instead of later, because both apps ship
  before launch.
- Every web handler is a named function, and the native routes mount
  the same functions. · The rules and limit counters are the same by
  construction, not by copy. · n/a
- A sign-in or sign-up starts with `POST auth/begin`, which returns a
  `ceremony` value. Every later step sends it as the bearer token. ·
  It's one uniform rule for the Origin exemption. · n/a
- The token is **rotated** at sign-in (the ceremony value never becomes
  the signed-in token). · The same rule as the web: a value seen before
  sign-in never becomes a signed-in one. · Cost: if the last answer is
  lost on the network, the app signs in again.
- The Origin exemption is narrow: only `/api/native/v1` requests with
  `Authorization: Bearer` (and `auth/begin` with a JSON body). A bearer
  header on a web route skips nothing. Native routes never read the
  cookie. · n/a
- Ceremony steps refuse a signed-in token (409 `signed_in`). "One token
  per install" is enforced by signing out first. · n/a
- Passkey origins accepted for apps: Canopy origins (including
  `https://canopysf.com`) plus Android hashes from
  `ANDROID_APK_KEY_HASHES`. The web still accepts Canopy origins only.
  · **The iOS origin (`https://canopysf.com`) rests on an Apple
  engineer's forum answer, not formal docs, and hasn't been tried on a
  real phone.** Android's is confirmed in Android's docs. · lib/domain.js.
- Sessions record which client they are (web, ios or android) and a
  name ("Safari on iPhone", "Canopy Events on iPhone"). The profile
  gains a "Signed in on" list with sign out for each, and a new **sign
  out everywhere**. · Apps make many sessions, and people need to cut
  one off. · Schema v7.
- App photo uploads must be JPEG, and EXIF/XMP metadata (location
  included) is now stripped server side from **every** JPEG upload. ·
  App uploads don't go through the browser's canvas, and the README
  promises no location data. · lib/photoStore.js `withoutMetadata`.
- `/photo/:id` accepts a bearer token. · Otherwise apps couldn't show
  photos. · n/a
- Errors that had no `reason` gained one (`names_required`,
  `not_found`, `no_passkeys`, `too_large`, `bad_upload`, `bad_json`). ·
  Apps need machine-readable reasons. · Additive.
- The admin pages, setup password, recovery and setup links stay
  web-only. · n/a
- `assetlinks.json` has placeholders: package `com.canopysf.events` and
  an all-zero fingerprint. **To do (you):** copy
  `docs/well-known/apple-app-site-association` (filled in with
  `UC3Y84QJ83.com.canopysf.CanopyEvents`) to the canopysf.com site, with
  a `Content-Type: application/json` header rule. Fill in assetlinks
  when the Android app exists.


## Events web

- **The pages are clients of the API**, even on the server: each page
  asks this server's own `/api/v1` over loopback, as the visitor (their
  cookie, their host), and draws the answer. · One copy of the
  visibility and never-leak rules, and API changes being built in
  parallel (plus-ones, waitlist, moderation) reach the pages with no
  second copy to forget. Costs one local request per list; the session
  lookup is cached. · `apiGet` in routes/pages.js could call lib/views
  and the store directly.
- Pages are drawn on the server **and** redrawn in the browser by the
  same file, `public/ui.js`, which runs in Node and in the page. Each
  page carries the API answers it was drawn from as JSON, so its script
  starts there without asking again. · Instant on a phone, link previews
  and no-JS readers get the content, tests can read the HTML, and the
  two can't drift. · Draw only in the browser from the embedded JSON.
- Server-side additions are `routes/pages.js`, `lib/render.js`,
  `views/*` and `public/*`, plus four lines in `server.js` (mount the
  pages; an HTML "nothing here" for other browser GETs). Nothing in the
  API, `routes/` or `lib/` otherwise changed. · Clean merges. · n/a
- Link previews (Open Graph and Twitter): the title (prefixed
  "Cancelled:" when it is), and "<date>, <time> <zone> · <place name>".
  Never the address and never the description (the host's own words can
  say anything, an address included). `twitter:card` is `summary` until
  there's an image. · The spec: title, date, place name. ·
  `eventMeta()` in lib/render.js.
- The cover image hook is `UI.coverUrl(event)`, reading
  `event.coverImageUrl`. That field name is a guess; whoever adds covers
  points it at the real one, and the page and the preview both follow. ·
  n/a · public/ui.js.
- Every page is `noindex, nofollow` (meta tag and `X-Robots-Tag`), and
  `Cache-Control: no-store`. · Events are link-only; pages say who's
  going. Previews ignore robots tags. · routes/pages.js, lib/render.js.
- **Time zone labels**: an event's times are always in its zone, and
  labelled ("Times are Los Angeles time (PDT)" on the event, "PDT" after
  the time in lists) when the viewer's clock reads differently at that
  moment, not when the zone names differ (Phoenix and Los Angeles in
  summer get no label). The browser tells the server its zone in a `tz`
  cookie (a year, `SameSite=Lax`), so only the very first page is drawn
  with labels everywhere and then redrawn. · The spec asks for a label
  when it differs. · `sameClock()` in public/ui.js; drop the cookie in
  public/events.js.
- Home shows **invitations first**, then hosting, coming up, past (the
  spec lists hosting first). Empty lists are left out. · Invitations are
  the one list asking for something. · `HOME_LISTS` in public/ui.js.
- An invitation on the home page offers **Going** and **Can't go** only;
  "Maybe" is on the event page. · "Accept/decline right there". ·
  `invitationCard()` in public/ui.js.
- Inviting friends is **its own page**, `/e/<id>/invite`, not a sheet
  over the event. · A long list with a search box scrolls better on a
  phone as a page, and the back button works. · n/a
- The invite page loads all your friends (100 drawn by the server, then
  up to 10 more pages of 100 in the browser) so the search box filters
  everyone, client-side. It reads up to 2,000 of the guest list to mark
  who's already on it. · No search endpoint, and friends lists are
  small. · constants in routes/pages.js and views/invite.html.
- `/new` for an unverified person is a page saying to confirm the email,
  with the button, rather than a redirect to the account service. Editing
  is for hosts and isn't gated on being verified, the same as the API's
  PATCH. · They see why. · routes/pages.js.
- **Validation messages**: which field comes from the API's `reason`;
  the words come from copy.js for the reasons it lists (so every sentence
  stays in copy.js), and are the API's own `error` sentence otherwise.
  · The API's sentences are written for developers ("startsAt is a date
  and time with a time zone offset…"). · `COPY.editor.errors`.
- The editor uses `datetime-local` fields and a time zone list (every
  zone the browser knows, the browser's own chosen for a new event). A
  typed time is read on the chosen zone's clock; changing the zone keeps
  the clock time. The start is empty for a new event rather than
  guessed. An emptied end time clears it. · Native pickers on phones; no
  library. · public/ui.js `fromLocalInput`.
- Descriptions are plain text with their line breaks; links aren't made
  clickable. · Simplest safe thing. · `details()` in public/ui.js.
- An address gets an "Open in Maps" link to Apple Maps
  (`maps.apple.com/?q=`), which opens Maps on an iPhone and Apple's web
  map elsewhere. · One link for every phone. · `details()`.
- Names: full names on the guest list, hosts and friends; `shortName`
  ("Ben O") in the small friends-going chips. · n/a · public/ui.js.
- The guest list shows 50 at a time, grouped going / maybe / waitlisted
  / can't go / (hosts) invited, with "show more". Counts in the event
  card include "N invited" for hosts only. · n/a · public/ui.js.
- Hosts can **bring back** a cancelled event (the API allows it). Once
  an event is over, invite and cancel are hidden; edit stays. ·
  `hostSection()` in public/ui.js.
- Signed out, a cancelled or past event shows its state and a small
  sign-in link, not the big RSVP. · Nothing to answer. ·
  `signedOutSection()`.
- Share uses the phone's share sheet where there is one, otherwise copies
  the link. Cancelling and bringing back ask with `confirm()`, as the
  account pages do. · n/a · views/event.html.
- The header, signed out, has a "Sign in" button; sign out is a link at
  the foot of every page rather than in the header. · The header is full
  at 375px. · lib/render.js.
- `color-scheme: dark` is added to the copied tokens. · Native date
  pickers and the time zone list's pop-up otherwise draw light (a
  `<select>` list was white on white). · public/events.css.
- The viewport tag is the account service's, `maximum-scale=1,
  user-scalable=no`, kept for the same look and no zoom-on-focus. It
  stops pinch zoom on Android (iOS ignores it). · Matching. · each view.
- A page's embedded data holds the visitor as `{id, firstName,
  emailVerified}` only, never their own contact details, and the page
  tests hold every page to having nobody's (the visitor's included). ·
  The pages never show them. · `meView()` in routes/pages.js.
- A photo that won't load (signed out, the account service won't serve
  it) becomes initials. Photos are fetched with no referrer. · n/a ·
  public/events.js.
- The wording is "Confirm your email", as on the account service's
  profile, not "verify". · One word for one thing across Canopy. ·
  public/copy.js.
- Visual checks used a scratch fake account service with photos and
  seeded events (not committed), not the real account service. ·
  Passkeys can't be made from the test browser. · n/a

## iOS foundation (feat/ui-foundation)

- Swift 6 language mode is on (`SWIFT_VERSION = 6.0`), with MainActor
  default isolation kept. The repository protocols are `Sendable` so
  `async let` works. · You asked for the most modern Swift. ·
  Build setting.
- `ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME = AccentColor` was
  added. · Without it controls were system blue. · Build setting.
- The "New event" tab-bar button is a normal `Tab` whose selection opens
  the editor. · `Tab(role: .prominent)` is iOS 27-only, and
  `tabViewBottomAccessory` isn't available on visionOS or macOS (both are
  in the target's platforms). · ARCHITECTURE.md has the upgrade path.
- No `#if os` in screens. Glass and iPhone-only modifiers go through
  `Design/View+Glass.swift` and `Utilities/View+Platform.swift`. · Keeps
  the screens readable. · n/a
- The verify banner is a top safe-area inset on each tab root and on
  pushed screens. · On the TabView it overlapped navigation bars. · n/a
- Mock accounts: Maya (verified host), Sam (unverified quick account),
  Ada (new). Any 6-digit code works. Mock photos come from pravatar.cc
  and picsum.photos, with initials and gradient fallbacks. Dark mode is
  forced. Debug launch arguments: `-mockAccount maya|quick|new`,
  `-mockTab`, `-mockEvent <id>`, `-mockNewEvent YES`.
- API fields the app assumed before the API had them: `capacity`,
  `spotsLeft`, `plusOnesAllowed`, `coverImageUrl`, `hasHosted`, the
  declined list, and the wall and inbox shapes. · They're listed under
  "Mock vs real" in ARCHITECTURE.md, to reconcile once feat/features is
  merged.
- `CanopyEventsTests/MockFlowTests.swift` (Swift Testing, 9 tests) lives
  outside the app folder, with **no test target yet** (adding one means
  editing the project). · Yours to add.
- **(You)** Sheets use the system sheet background, not the mesh; that
  applies to all four sheets (editor, RSVP, invite friends, verify
  email), not only the editor. Sign-in uses the Canopy logo PNG.
- Your `CanopyEventsIcon.icon` was moved from the repo root into
  `CanopyEvents/Events/`, so the synchronized folder builds it, and set
  as the target's App Icon. · Files outside that folder aren't part of
  the app. · Move it back and clear `ASSETCATALOG_COMPILER_APPICON_NAME`.
- **The app targets iOS 26.6, so it won't install on the iOS 26.5
  simulator** installed on this Mac (or any device on 26.0–26.5). Is
  26.6 intended, or 26.0?
## Events features

Co-hosts, plus-ones, the activity wall, cover images, capacity and the
waitlist, notifications, host moderation and lookup, built on branch
`feat/features`.

### Co-hosts and plus-ones (schema version 2)

- **Who's verified is learned from their own sessions.** Every API
  request records whether the caller's email is proven, in a
  `verified_people` table; only someone seen there may be made a
  co-host. · The account service's `/api/people` doesn't say who's
  verified, and the contract for it isn't ours to change tonight. ·
  Cost: a verified person who has never opened events (signed in) is
  refused until they have. The fix is a `verified` field on
  `/api/people`; then drop the table and ask that instead.
- Refusing an unverified target is 403 `email_unverified` **without** a
  `verify` link (the error says it's about them). · The link is only
  ever for the caller's own email. · routes/hosts.js.
- Only the creator adds and removes co-hosts, cancels and un-cancels,
  and (later) makes a new link. Co-hosts edit everything else, invite,
  see the whole guest list and (later) moderate. A co-host can step
  down by themselves. · Cancelling and the link are the whole event;
  everything else is running it. · `creator_only` checks in
  routes/events.js and routes/hosts.js.
- At most 10 co-hosts. · Plenty for a party; a ceiling on nonsense. ·
  `MAX_COHOSTS` in lib/store/hosts.js.
- **Becoming a co-host deletes the person's RSVP** (and its plus-ones).
  Stepping down, or being taken off, leaves them `invited` by whoever
  added them. · Hosts don't answer their own events, and keeping a
  hidden answer would mean every count had to skip it. Invited keeps
  the event in their lists, ready to answer. · lib/store/hosts.js.
- Co-hosts can't be added to a cancelled event or one that's over (the
  same 409s as inviting). Taking one off always works. · n/a
- **Plus-ones: lowering `guestsAllowed` keeps existing answers** and
  flags them (`guestsOverLimit` on the viewer's RSVP and on guest-list
  entries). The next change to that answer has to fit, even re-sending
  the same one. · Clamping would drop someone's plus-one without
  telling them. · lib/views.js; to clamp instead, update rsvps in the
  PATCH route.
- `guestsAllowed` is 0 to 10. A `maybe` may bring guests; `not_going`
  never does; leaving `guests` out of an answer means 0. · n/a
- Counts keep the people per status at the top level (so nothing that
  read them changes meaning), and add `guests` (plus-ones) and `total`
  (people + plus-ones) for going, maybe and waitlisted. · Additive. ·
  lib/store/rsvps.js countsFor.

### Two small additions for the app

- `GET /api/v1/me/events/declined`: events you answered `not_going`
  that **aren't over and aren't cancelled**, soonest first, invited or
  not. · It sits beside invitations in the app's Invites tab, so it
  follows the same rule; a declined event that's over or off has
  nothing left to change your mind about. · `LISTS.declined` in
  lib/store/events.js.
- `GET /api/v1/me` gains `hasHosted` at the top level (beside `person`
  and `verifyUrl`, not inside `person`, which is the account's own
  details). It's "hosts or co-hosts any event now on record", cancelled
  and past included. · A co-host who stepped down from their only event
  is false again: there'd be nothing in a Hosting tab. Recording "ever"
  exactly would need its own table. · `hasHosted` in
  lib/store/events.js.

### The activity wall (schema version 3)

- **Who reads it: whoever can see the guest list's names**, by the same
  rule (`canReadWall` is `canSeeGuestNames`). Anyone else signed in gets
  `wallVisible: false` and no entries, the same shape as the guest list;
  signed out is 401. · The wall is full of names ("Ana is going"), so it
  can't be looser than the list. · lib/rules.js.
- **Who posts: hosts, and answers of going, maybe or waitlisted.**
  Invited-and-silent and can't-go read but don't post (403
  `answer_first`). · Posting is for people who might be there. ·
  `canPost` in lib/rules.js.
- Cancelled and finished events still take posts. · "So sorry it's off"
  and "thanks for coming" are what a wall is for. · Add an
  `answerRefusal`-style check in routes/wall.js.
- **Posts are 1 to 1,000 characters, and longer is refused, not cut**
  (unlike a title). · Cutting someone's message silently loses what they
  said. · `MAX_POST` in routes/wall.js.
- Posting limits: 5 a minute and 100 a day per person; 20 a minute and
  300 a day per address; 300 a minute and 5,000 a day overall. ·
  Generous for talking, a ceiling for scripts. · routes/wall.js.
- Authors delete their own **posts** only (not "<you> is going", which
  goes away when you stop going); hosts, co-hosts included, delete
  anything. Deleting is a real delete. · Nothing to keep a deleted post
  for. · routes/wall.js.
- **The server's entries are typed rows** (`going`, `off_waitlist`,
  `time_changed`, `place_changed`, `cancelled`, `uncancelled`,
  `cohost_added`) with structured `details`, written in the same
  transaction as the change. No English is stored. The `type` column has
  no CHECK, so a new type is a code change, not a table rebuild. · n/a
- **One "going" entry per person, kept true**: saying going again
  replaces it with a fresh one, and withdrawing, changing to maybe or
  can't go, or becoming a co-host deletes it. · Otherwise the wall says
  people are coming who aren't. · lib/store/wall.js.
- Time and place entries carry the new values; only a real change makes
  one (re-sending the same start time doesn't). Time is startsAt, endsAt
  or timeZone; place is locationName or locationAddress. Title,
  description and visibility changes make no entry. · n/a
- Wall ids are SQLite AUTOINCREMENT integers, as strings in the API. ·
  An id is never reused, so deleting an old id can't hit a new post. · n/a

### Cover images and capacity (schema version 4)

- **Covers are public**: anyone with the URL loads it, signed in or not.
  · Link previews fetch it with nobody's session. · routes/covers.js
  `files`; to make them private, check `req.person` there (and lose the
  picture in previews).
- **A cover's URL is a random key, not the event's id**
  (`/covers/<key>.jpg?v=<uploadedAt>`), and every upload gets a new key.
  This is what schema version 4 adds (`events.cover_key`, unique). · The
  event id is the link; a public image URL carrying it would hand the
  link to anyone who copied the image's address. A new key also kills a
  replaced cover's old URL at once. · lib/db.js VERSION_4.
- **Re-encoded on the server with `sharp`** (libvips): auto-rotated from
  EXIF, fit inside 1600 px, flattened onto white, JPEG quality 82, **no
  metadata kept** (no GPS). The account service lets the browser crop to
  a small JPEG instead, but covers come from apps too, and covers are
  public, so the server can't trust a client to have stripped location.
  · lib/coverImage.js.
- **sharp is a new native-ish dependency.** It compiles nothing: npm
  installs its prebuilt libvips for linuxmusl from package-lock.json.
  Checked tonight by building the Dockerfile for both linux/amd64 and
  linux/arm64 (the deps stage now makes a JPEG as a smoke test, like the
  better-sqlite3 check) and converting a HEIC inside the amd64 image. ·
  The alternative was pure-JS decoders for four formats plus our own
  resize and rotate. · Dockerfile.
- **HEIC via `heic-decode`** (libheif compiled to WebAssembly, LGPL-3.0,
  about 9 MB installed), because sharp's prebuilt libvips only reads the
  AVIF kind of HEIF. · iPhones save HEIC; Safari usually converts on
  upload, but the iOS app needn't. · Drop it and refuse HEIC with
  `bad_image` if the size or licence matters.
- Type is told by the first bytes, never the filename or Content-Type.
  Up to 15 MB and 50 megapixels; 30 uploads a day per person, 100 per
  address, 2,000 overall. Served with `Cache-Control: public,
  max-age=3600`, so a removed cover can live in caches up to an hour. ·
  n/a
- Covers live in `DATA_DIR/covers/<event id>.jpg`, outside the SQLite
  snapshots (the Coolify volume backup has them). · Mirrors the account
  service's photos. · n/a
- **Capacity counts plus-ones**: going people + their guests ≤ capacity.
  `maybe` isn't capped. · The spec. · lib/store/waitlist.js.
- **Someone already going who asks for more plus-ones than fit is
  refused** (409 `no_room`) and keeps their spot, rather than being
  moved to the waitlist with their whole party. · Asking for one more
  shouldn't lose you the one you had. · lib/store/rsvps.js setAnswer.
- **Promotion is "earliest that fits"**: by when they were waitlisted,
  skipping a party too big for the free spots (who stays first for the
  next). It runs inside the same transaction as whatever freed the spot
  (withdraw, maybe/not going, fewer guests, capacity raised or cleared,
  co-host made, guest removed, event un-cancelled) and writes an
  `off_waitlist` wall entry. A test makes the wall entry fail and checks
  the whole withdrawal rolls back. · lib/store/waitlist.js.
- **Lowering capacity below the current going count bumps nobody**; new
  `going` answers wait until enough people leave. · The spec. · n/a
- A cancelled or finished event promotes nobody; un-cancelling fills
  from the waitlist. · Nobody should get "you're in!" for an event
  that's off. · n/a
- `PUT /rsvp` now answers `{event, waitlisted}` (a new `RsvpResult`
  schema) rather than `{event}`. · "The response says so" without making
  apps diff statuses. Additive for anyone reading `event`. · n/a
- Events get `capacity`, `spotsLeft` (never below 0) and
  `coverImageUrl`, shown to everyone including signed out (a preview can
  say "3 spots left"). · n/a

### Notifications, server side (schema version 5)

- **One `notify(type, {to, actorId, eventId, details})`** (lib/notify.js)
  writes the inbox rows and queues the pushes; routes never touch either
  directly. It drops the actor from `to` and de-duplicates. · The spec:
  nothing can push without landing in the inbox. · n/a
- **Typed, not worded**: `invited`, `event_changed` (`{changed: [time,
  place]}`, one notification for both), `event_cancelled`,
  `event_uncancelled`, `cohost_added`, `waitlist_promoted`, `wall_post`
  (`{entryId, text}`, text cut to 200 characters), `rsvp` (`{status}`).
  · Clients render the text, in their own language. · n/a
- `event_uncancelled` is added beside the spec's "cancelled". · Someone
  told it's off needs telling it's back on. · Drop the notify call in
  routes/events.js.
- **Who hears event changes, cancelling and host posts: going, maybe and
  waitlisted, plus the other hosts.** Invited-but-silent and can't-go
  don't. · The spec says "going to or maybe at"; the waitlisted still
  hope to be there, and co-hosts need to know what the creator did. ·
  `audienceOf` in lib/store/notifications.js.
- Only a **host's** post notifies; a guest's doesn't. · The spec ("a
  host posted"), and a busy wall would buzz everyone constantly. · n/a
- **RSVPs to hosts fold together while unread**: the unread `rsvp`
  notification for that event gets `count + 1`, the newest `actor` and
  status, and moves to the top; only the first of a batch pushes. Read
  it and the next answer starts a new one. A change of plus-ones alone
  isn't news; any change of status is (including to `not_going` and to
  the waitlist). · "May be batched", and one buzz per guest is too many
  for a big party. · `COLLAPSE` in lib/store/notifications.js.
- Inbox order is by when the latest thing in a notification happened
  (`updated_at`), so a folded one rises. There's no pruning of old
  notifications yet. · Not needed at this size. · Add a startup DELETE
  of read ones past N days.
- Marking read is `POST /me/notifications/read {ids}` (1 to 100;
  others' ids silently ignored) and `POST /me/notifications/read-all`,
  plus `GET /me/notifications/unread` for a badge. · Simple for apps;
  ignoring others' ids gives nothing away. · n/a
- **Devices**: `POST /me/devices {platform, token}` upserts by token, so
  a token registered by someone else moves to the new person (one phone,
  whoever signed in last). `DELETE /me/devices` takes `{token}` in the
  body, as the spec's path has no token in it, and only removes the
  caller's own. Up to 10 phones each, least recently registered dropped.
  Tokens are 16 to 4,096 of `A-Za-z0-9:_.-`. · n/a
- **Push**: `lib/push.js` takes a sender `{name, send(device, message)}`;
  the default logs `[push] ios …abc123 invited #17`, never the whole
  token. A sender answering `invalidToken` unregisters it. Pushes are
  sent after the response, on `setImmediate`; failures are logged, never
  surfaced. The message is typed (`type`, ids, event title, `badge`) for
  APNs `loc-key` / FCM `body_loc_key` later. · No keys tonight. · n/a

### Host moderation (schema version 6)

- **`removed` is a real RSVP status**, so every existing query that
  filters by status (counts, lists, friends, "everyone coming") leaves
  removed people out by itself. SQLite can't change a CHECK in place, so
  version 6 rebuilds `rsvps` (new table, copy, drop, rename, indexes
  again), tested on a version-1 file with a row in it. · The alternative,
  a `removed_at` column, needed a filter added to every query, and one
  forgotten would show a removed guest. · lib/db.js VERSION_6.
- **Any host removes, co-hosts included.** · Moderating is running the
  event, not owning it. · routes/moderation.js `hostsOnly`.
- **A removed person still opens the event, and sees what someone
  signed out sees** (no address, guest list, wall or friends going),
  with `viewer.rsvp.status: removed`. · Anyone with the link sees the
  public details anyway; hiding them from this one person would only
  last until they signed out. The address is what matters, and they
  lose it. A new link is the answer to "they mustn't see it at all." ·
  lib/views.js `insider`.
- Removed people can't answer, withdraw, post, or be invited
  (`skipped: removed`); their going entry is deleted, and their posts
  are hidden (not deleted) from the wall for everyone, so undoing a
  removal brings the posts back. Their spot goes to the waitlist. ·
  n/a
- **Undo leaves them `invited`** (by the host undoing it), not their old
  answer. · Their old "going" might no longer fit the capacity, and the
  invitation puts the event back in their list to answer again. ·
  lib/store/rsvps.js restoreGuest.
- Hosts can remove someone not on the list yet (they must exist). · A
  host who knows who's trouble can act first. · n/a
- Hosts see removed people only with `?status=removed`, not in the
  default guest list; there's no `removed` in the public counts. · The
  count would tell guests someone was thrown out. · lib/rules.js.
- Nobody is notified of a removal, of undoing one, or of a new link. ·
  None is in the spec's triggers, and "you were removed" invites an
  argument. · Add notify calls in routes/moderation.js.
- **New link: an internal stable id plus a public link.** Version 6
  adds `events.public_id` (unique), set to `id` for every existing
  event; `id` never changes and stays the key for hosts, rsvps, wall,
  notifications and the cover's file. A new link replaces `public_id`
  only. Every lookup from outside goes by `public_id`
  (`getEventByLink`, used by `loadEvent`), and views only ever output
  `publicId`. · Changing `events.id` itself is impossible under the
  existing foreign keys (no ON UPDATE CASCADE) without rebuilding four
  tables; an alias table would mean keeping a list of dead ids around to
  refuse. · To reverse, point `loadEvent` back at `getEvent`.
- **The old link is a 404 `event_not_found`, not a 410.** · The point of
  a new link is that the old one gives nothing away, not even that there
  was an event there. · lib/api.js loadEvent.
- New links are the creator's alone, like cancelling. New ids are
  checked against both `id` and `public_id`. A link from two changes ago
  isn't remembered, so in theory it could be reissued; at 71 bits that
  won't happen. · n/a
- List cursors (`/me/events/*`) carry the event's internal id inside the
  opaque cursor. That can be an event's original link, which a new link
  has already killed, so it gives nothing away. · n/a

### Lookup to invite

- `GET /api/v1/people/lookup?phone=…|instagram=…` is a straight proxy of
  `canopy.lookup(req, …)`, **verified callers only** (checked here, from
  their session, before asking the account service, so an unverified
  caller's lookup never counts against anyone's limits). The answer is
  `{person}` through `publicPerson`, so even a field the account service
  added later couldn't come through. · The spec: "events only lets
  verified hosts use it." "Hosts" read as anyone verified, since anyone
  verified can host. · routes/people.js.
- Exactly one of `phone` or `instagram`, a single string, is checked
  here too (400 `one_of`); the cleaning and the rest are the account
  service's. · A repeated `?phone=` would otherwise reach it as an
  array. · n/a
- **Its refusals keep their status and reason**: 400 `one_of`,
  `bad_phone`, `bad_instagram`; 403 `email_unverified` (with this API's
  `verify` link) and `lookup_not_allowed`; 429 `rate_limited`. Its 401
  `signed_out` becomes this API's 401 `sign_in_required`, with the usual
  links. Anything else (down, a 5xx, a reason we don't know) is 503
  `accounts_unreachable`. The `error` sentences are ours. · One error
  vocabulary for the apps. · `PASSED_ON` in routes/people.js.
- No lookup limits of events' own: the account service's (per asker,
  per address, overall) are the real ones, and doubling them here would
  only make the two disagree. · n/a
- **The visitor's address** is whatever the client file sends:
  `CF-Connecting-IP`, else Express's `req.ip` (trust proxy on). Behind
  Cloudflare that's the real address; without it, `req.ip` comes from
  `X-Forwarded-For`, which a caller can set, so the per-address limit is
  only as good as Cloudflare being in front. The per-asker and overall
  limits hold regardless. · The client file is copied unchanged. · n/a
- The fake account service in the tests gained `/api/people/lookup`,
  exact matching on the fixtures' phones and handles, honouring
  "findable", and switches to make it refuse in each way the real one
  can. · n/a

## Security review (both services)

The review found no critical or high issues. Fixes are in progress
(account service on main; events on `fix/review`):

- **Reversed: unverified accounts are no longer findable by lookup.** A
  quick account (nothing proven) could claim your phone or Instagram
  and your name, and become the only match, so a host invites the
  impostor. Now only verified accounts match. · That raises the cost to
  owning an email inbox. It's not a full fix: SMS phone verification
  would be. · The account service's lookup query.
- Changing your email no longer reveals whether the new address has an
  account. Every try is counted first, and the refusal comes only at
  the code step. · One passkey reauth allowed unlimited existence
  checks. · n/a
- When a code proves an unverified account's email (the takeover), the
  squatter's phone, Instagram, Venmo, Cash App and photo are cleared
  too. · Otherwise lookups and payments would still point at their
  details. Kept: everything they did on events under that id. · n/a
- HEIC covers: decoder memory is freed and decoding moves off the main
  thread. · Each upload leaked about 14 MB and froze the server for
  about 0.7 s. · n/a
- Removing or uninviting someone deletes their notifications for that
  event, and the inbox only shows an event's link to people still on
  it. · Otherwise the inbox handed a removed guest the new link. · n/a
- Plus: JSON errors for malformed requests, limits on making new
  sessions, web photo uploads that can't be cleaned are refused, and
  the invited count goes to hosts only.

## Events web: friendlier design

- **(You)** Larger fonts everywhere and a friendlier feel. Event covers
  are first class: a 3:2 hero with a fade at the bottom.
- Assumed: the type scale is roughly iOS sized (17px body, 15px minimum
  for secondary text, 28–34px event titles). Events without a cover get
  a generated green mesh at the same 3:2, so every event page has the
  same hero. The 3:2 crop is display-only (the stored cover keeps its
  full frame). Lists show the cover at 3:2 too. · CSS custom properties
  in events.css.
- This applies to the events pages only. The account service's pages
  (sign-in, quick sign-up, profile) keep their smaller type for now. ·
  To be decided by you: quick sign-up is the first page a guest sees
  after events.
- **(You)** Hosts pick each event's background colour with a slider
  across the whole rainbow, at the same relative darkness.
- Assumed: `themeHue` on the event, 0–359, or null for the default
  Canopy green. The mesh is defined in OKLCH with lightness and chroma
  fixed and only the hue varying, so every hue has the same perceived
  darkness and text contrast holds. The slider lives in the editor with
  a live preview and a "Canopy green" reset, and the hue themes the
  event page (including the signed-out page and the no-cover hero).
  Other pages stay green. The iOS app will read the same field. ·
  docs/api.md says how the colours are derived, so the app can match.
- **(You)** The date and time are much more prominent (Partiful-style).
- Assumed: on the event page the when comes right after the title, on
  the cover fade: the day and date large, the time almost as large, and
  a relative pill ("Tomorrow", "This Saturday", "Happening now"). The
  place comes after it, smaller. List rows lead with a bold accent
  line, e.g. "SAT, OCT 10 · 7:30 PM", above the title. The signed-out
  page gets the same treatment.
- Account review fixes are on main (0e32e7f..8247337, then e5968a9):
  - Changing to an address that already has an account sends that
    address a "someone tried to move their account here" notice in
    place of the code, so both cases answer identically. The refusal
    (409) comes only at the code step. Also a new limit of 5 new
    addresses per person per hour.
  - After a takeover, the owner lands on their profile with a banner
    saying what was cleared, so they can fix the name the squatter typed.
  - New sessions are limited to 100 per address and 1,000 overall per
    hour. · A carrier that puts many phones behind one address could
    hit this; the README says so.
  - Apps keep the `bad_photo` reason for unreadable photos, while the web
    gets `bad_image`. · The iOS contract already documents `bad_photo`.
  - A contested phone or handle stays unfindable even if the other claim
    is an unverified account. · Cost: an unverified squatter can now
    hide you. The verify banner now says unconfirmed people can't be
    found.

## Contact data security (queued, low priority, not merged tonight)

- **(You)** Queued items 1–5: lookup by POST, per-site field scopes on
  `/api/session`, encryption of contact fields with keyed-hash lookup,
  self-serve account deletion, and a lookup audit log. They're on
  `feat/data-security` in both repos, for your review. Their judgment
  calls get logged on that branch.

## Contact data security (feat/data-security)

On `feat/data-security` in both repos, not merged. Newest at the bottom.

### 1. Lookup by POST

- The lookup is `POST` in both services (`/api/people/lookup` in the
  account service, `/api/v1/people/lookup` here), with `{phone}` or
  `{instagram}` in a JSON body. The GET forms are gone, with no
  compatibility period. · Numbers and handles in a URL end up in access
  and error logs along the way; neither service is public yet, so nobody
  depends on the GET. · Put the GET routes back next to the POSTs.
- A site's key (`Authorization: Bearer cnp_…`) lets `POST
  /api/people/lookup` skip the account service's Origin check. · The
  same reasoning as the apps' bearer exemption: a header no browser
  attaches by itself, on a route that never reads the cookie. Only that
  one path is exempt. · `SITE_POSTS` in server.js.
- Body values must be strings; a number, an array or an object is `400
  one_of`. · No type guessing on what's typed into a phone field. ·
  Accept numbers in both routes.
- Error log lines carry the path without its query string (account
  service), and events logs an error's stack rather than the whole error
  object (an `ApiFailed` carries the API's whole answer). · Nothing that
  could hold contact details goes in a log. · Revert the log lines.
- Left as they are: the account service's three development-only mail
  lines that print an address ("code for ana@…: 123456"). They never run
  in production (no SMTP there means the request fails instead), and the
  tests read codes from them. · Mask the address there if that's ever
  wanted; the test harness matches on it.

### 2. Per-site scopes on `/api/session`

- Each site in the account service is granted a subset of the visitor's
  `email`, `phone`, `instagram`, `venmo`, `cashapp`
  (`apps.contact_fields`, schema version 8). A new site gets none. ·
  A site can only leak what it's sent. · Tick the boxes in the Sites tab.
- Upgrading to version 8 grants every existing site all five. · That's
  what `/api/session` gave before, so tickets keeps working. · Untick
  per site afterwards.
- Fields not granted are **left out** of `person`, not sent as `null`. ·
  `null` already means "not filled in"; a site shouldn't be able to read
  "not told" as "blank". · `siteView` in the account service's server.js.
- `id`, names, photo, `emailVerified` and `findable` are always sent. ·
  Every site needs them to show who's signed in; `findable` is a
  setting, not a contact detail. · Add `findable` to the scopes.
- Events is granted nothing, and `GET /api/v1/me` no longer has `email`,
  `phone`, `instagram`, `venmo` or `cashapp` (removed from the `Me`
  schema, not kept as nulls). The leak walker now flags anyone's contact
  details, the caller's own included, and the fake account service sends
  all five by default so the tests prove events drops them even if it's
  granted them by mistake. · Events never showed them; the apps read and
  edit the profile through the account service's `/api/native/v1/me`.
  · Put the fields back in `ownPerson` and the schema.
- **Follow-up for the iOS app (not done here):** `Me.swift` documents
  `/api/v1/me` as its source for `email`, `phone` and so on. They're
  optional there, so decoding still works, but the profile header, the
  profile form and the verify sheet's "we sent a code to …" will show
  blanks until the app reads its own contact details from the account
  service's `GET /api/native/v1/me` (it already decodes into `Me`).
