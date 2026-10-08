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
- An invitation on the home page offers **Going** and **Can't Go** only;
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

## Events web, features pass

Web pages for co-hosts, plus-ones, the wall, covers, capacity and the
waitlist, host moderation and lookup, plus one API fix, built on branch
`feat/web-features`.

- **`hasHosted` is "once a host, always a host"**, recorded in a new
  `hosted_people` table (schema version 7), written in the same
  transaction as making an event or being made a co-host, and never
  deleted. The upgrade fills it from everyone in `hosts` at the time
  plus everyone in a wall `cohost_added` entry (which remembers co-hosts
  who have since stepped down), with the earliest time of either. · The
  app's Hosting tab shouldn't vanish when a co-host steps down (the
  earlier entry under "Two small additions" chose otherwise). · Cost: a
  co-host who stepped down before version 7 *and* whose wall entry a
  host deleted isn't known, and reads false until they host again. ·
  Point `hasHosted` in lib/store/people.js back at `hosts` (and leave
  the table).
- **The editor sends cover changes on Save**, not when a photo is
  picked: picking or removing only changes the preview, and the PUT or
  DELETE goes after the event's own PATCH (or POST). · One rule for the
  whole form ("nothing changes until you save"), and a new event has no
  id to upload to before it's made. · views/editor.html `saveCover`.
- A new event whose cover upload fails is still made, and the browser
  goes to its editor with `?coverError=<reason>`, which says so under
  the cover field. An edit whose cover fails stays on the page, saying
  the rest was saved. · The event is the important part; the cover can
  be tried again. · views/editor.html, routes/pages.js.
- Covers over 15 MB are refused in the browser before uploading, and a
  413 with no JSON (a proxy's) reads as "too big". · A phone on a slow
  connection shouldn't upload 20 MB to be told no. · views/editor.html.
- **No waitlist position.** The API doesn't give one, so a waitlisted
  viewer sees their status ("You're on the waitlist. You'll move up if
  a spot opens."). · The brief: position only if the API gives it. ·
  Add `position` to `Rsvp` and a line in `rsvpSection`.
- "It's full: you'll join the waitlist" shows when `spotsLeft` is 0 and
  the viewer isn't already going or waitlisted. It doesn't work out
  whether a party bigger than the spots left would fit. · The API says
  `waitlisted: true` either way, and the page redraws to say so. · n/a
- **The plus-ones stepper**: before answering, it only remembers the
  number (the answer takes it along); once someone has answered going,
  maybe or waitlisted, each tap changes the answer straight away. An
  answer over a lowered limit keeps its number, with a note saying that
  changing the answer will bring it down to the limit, which the page
  then does. · No extra "save" button under the answers. · `guestsShown`
  in public/ui.js, `stepGuests` in views/event.html.
- Counts read "4 going +2 guests · 1 maybe", and the guest list's
  groups "Going · 4 +2 guests". People first, plus-ones after. · The
  API's top-level counts are people; this keeps that meaning. ·
  `countsLine` in public/ui.js.
- **Adding co-hosts is its own page**, `/e/<id>/cohosts` (the creator
  only), picking from friends with a search box, like inviting. Removing
  a co-host and stepping down are buttons on the event page, with a
  `confirm()`. Refusals (an unconfirmed email, too many) show under that
  friend's row, in copy.js's words. Lookup isn't offered there. · The
  invite page's pattern; a co-host is someone you know. · n/a
- **Co-hosts no longer see Cancel or Bring back**, which the first
  pages showed every host and the API refuses (`creator_only`); "New
  link" is the creator's too. A co-host's area says what they can do. ·
  `hostSection` in public/ui.js.
- **A removed viewer's page** fetches no guest list or wall (the API
  would only say no), and its RSVP card is a calm line: "You're not on
  the list for this event. A host has taken you off it, so you can't
  answer. If you think that's a mistake, ask whoever invited you."
  `status.removed` ("Removed") is in copy.js for hosts' own lists. ·
  The brief: no raw key, nothing harsh. · `removedSection`.
- Hosts see the first 50 removed people, with no "show more". · Nobody
  removes 50 people from a party. · routes/pages.js `GUESTS_SHOWN`.
- The invite page marks hosts ("Hosting", "Co-hosting") and removed
  people, as it marks answers, rather than offering a checkbox the API
  would skip. · n/a · routes/pages.js.
- **Lookup reads what's typed**: a letter or a leading `@` means an
  Instagram username, anything else a phone number (the account service
  cleans both). An all-digit username needs its `@`. · One field, as
  the brief asks. · views/invite.html.
- `lookup_not_allowed` swaps the lookup box for a line saying it isn't
  available yet (until the page is opened again). An unverified host
  gets a "confirm your email" link in its place, and a 403
  `email_unverified` from the lookup is said in place, not a redirect.
  · Nobody is sent away mid-typing. · `api(..., { stay: true })` in
  public/events.js.
- **The wall shows the newest 20**, with "show more"; times are "just
  now", "5m", "3h", then the date. A post being typed survives the page
  redrawing (an answer, a delete). After an answer the wall is fetched
  again from the top. · n/a · views/event.html.
- Hosts' "Delete" on the server's entries ("Ana is going") asks "Take
  this off the wall?"; on posts, "Delete this post?". Unknown entry
  types are left out, as the spec says. · n/a
- **A new link** replaces the page's address in place (no reload) and
  shows the new link in a box with Share and Copy, under the confirm
  that explains the old one stops working. · n/a · views/event.html.

### Bigger type, and covers first (the owner's design direction)

- **A type scale in custom properties** (`--fs-body` 17px, `--fs-small`
  15px, `--fs-button` 17px, `--fs-h3` 19px, `--fs-title` 32px on a
  phone and 36px from 700px, `--fs-list-title` 19–20px, `--tap` 44px),
  set in the events half of events.css, which overrides the copied
  account.css sizes rather than editing them, so that half stays
  diffable against the account service. Fields are 17px. Colours are
  unchanged, so the contrast notes stay true. · The owner: friendlier,
  larger. · `:root` in the events half of public/events.css.
- Status pills (GOING, CANCELLED) stay at 13px, uppercase and bold: the
  one thing under 15px. · At 15px uppercase they shout and crowd a
  list row; they're labels next to bigger text, not something read. ·
  `.tag`.
- **The hero**: the cover at 3:2 (`object-fit: cover`), edge to edge on
  a phone (negative margins equal to the page gutter, safe areas
  included), inside the column with rounded corners from 700px. A
  gradient overlay fades it into the mesh's base colour (clear at 55%,
  70% at 80%, solid at the bottom), and the last 12% also melts away
  with a mask, so no edge shows against the mesh's glows. The title
  overlaps the bottom 64px (80px on desktop), where the overlay is at
  least 70%, with a text shadow. · The owner's brief; the overlap depth
  is what keeps a white title readable over a white sky. · `.hero`,
  `.head-text`.
- **No cover: a generated picture** at the same 3:2 in the same hero:
  three glows in one of six Canopy-green palettes, placed by an FNV
  hash of the event's id, drawn in CSS (no image file, no words). It's
  never a link preview image (`og:image` is only ever the real cover).
  · Every event page has the same shape; a preview of a gradient tells
  nobody anything. · `coverArt` in public/ui.js.
- **List rows get a 3:2 thumbnail** (132px wide on a phone, 168px from
  700px) with the date on it, the generated picture when there's no
  cover, and the title in two lines at 19px. Not a full-width card
  image per event. · A full-width 3:2 image is ~230px tall on a phone;
  twenty of them make the home page a long scroll to find one event. ·
  `.event-row .thumb`; for full cards, move `.thumb` above `.info`.
- The editor's preview is the cover at 3:2, cropped as the page crops
  it, without the fade (inside a glass card the fade reads as a
  smudge). · n/a · `.cover-preview`.
- **The 3:2 crop is display-only.** The API keeps the whole photo
  (within 1600px), and `og:image` is that photo. A server-side 3:2 crop
  for previews isn't worth it yet: iMessage and WhatsApp crop the image
  to their own shapes anyway, and Slack/X want about 1.91:1, not 3:2,
  so one more crop wouldn't match them either. If previews look bad, the
  fix is a second file at upload (1200×630, centre crop) used only for
  `og:image`. · n/a

### When, up front (the owner's second note)

- **The event page says when right under the title**, on the fade: the
  day at 24px semibold ("Tuesday, October 13"), the time under it at
  21px ("7:30 PM – 11:30 PM"), 26px and 23px from 700px; the zone line
  ("Times are Los Angeles time (PDT).") small under that, by the old
  rule. The when row left the details card, which now starts with the
  place. Signed out gets the same. · The owner's brief. · `whenHead`,
  `details()` in public/ui.js.
- **More than one day**: the date line is the two days, short ("Sat,
  Oct 17 – Mon, Oct 19"), and the time line the two times ("4:30 PM –
  11:30 AM"). Long day names for both didn't fit a phone's line. · n/a
- **The relative hint is a pill above the title** (where the "Happening
  now" and "Ended" tags were): Today (Tonight from 5 PM), Tomorrow, This
  Saturday (this calendar week, Monday first), Next Tuesday (next
  calendar week), In N weeks (under 4 weeks), In a month, In N months,
  Happening now, Ended. Cancelled shows the Cancelled tag instead. Days
  are counted on the event's own clock against now. The browser
  recomputes every pill on load and each minute (`refreshRelative` in
  public/events.js), so a page left open, or cached by a phone, says it
  right. · "This Tuesday" six days out (next week's Tuesday) read
  wrongly, hence calendar weeks. · `relativeWhen`.
- **List rows lead with when**: "SUN, OCT 11 · 8:30 PM" in bold
  uppercase in the link colour above the title, the zone's short name
  added when it differs, the two days for a multi-day event; then the
  title (two lines at most) and the place. The date chip that sat on
  the thumbnail went (it said the same thing twice). The pieces never
  break inside ("8:30 PM" stays together). · n/a · `whenRow`, `.row-when`.
- The friends page lists people, not events, so it has nothing to date.
  · n/a

### An event's colour (`themeHue`)

- **`themeHue` is folded into schema version 7** (the step that also
  adds `hosted_people`), as `events.theme_hue INTEGER` with a CHECK of 0
  to 359, NULL for Canopy green. · Version 7 isn't merged or deployed,
  so one step is simpler than two. · If 7 has shipped by the time this
  is read, it's frozen as it is; a later change is version 8.
- Any host sets it (co-hosts too), on create and PATCH; it's on every
  Event (signed out included) and on the notification `EventSummary`. ·
  It's how the page looks, not who runs it. · n/a
- **The model**: each colour of the mesh (base, five glows, the card's
  tint) is today's hex converted to OKLCH, with L and C kept and only the
  hue turned: hue = themeHue + that colour's offset from the brightest
  glow's hue. Canopy green is **161** (the brightest glow, `#145c3e`, is
  160.65°). `null` draws today's hex exactly; 161 is within 2/255 per
  channel. Out-of-gamut colours have their chroma lowered (binary
  search, L and hue kept). The constants are in `public/ui.js`
  (`THEME_MESH`) and docs/api.md's table, for the apps. · Same
  lightness means same contrast. · n/a
- **The contrast check** (white text on a card over the brightest glow,
  composited in linear light; same method for every row): Canopy green
  9.52:1; red (25°) 10.28; orange (60°) 10.13; yellow (100°) 9.86; cyan
  (193°, the worst on the wheel) 9.35; blue (255°) 9.91; purple (305°)
  10.23; pink (345°) 10.32. Muted text is 7.72–8.53, links 7.49–8.28,
  danger text 6.82–7.53, white straight on the brightest glow 7.83–8.75.
  All far past 4.5:1, and within 2% of the green's at worst. (This
  method gives slightly lower numbers than the 10.3:1 in the CSS comment,
  which was worked out differently; the comparison between hues is what
  matters here.) Only the card tint near yellow and `--card-solid`
  (unused by events) leave sRGB; no glow does, so no per-hue chroma
  table was needed beyond the general fit. A test holds white-on-card at
  ≥ 9:1 for eight hues. · n/a · test/pages.test.js.
- **Buttons, links and grey text stay Canopy green at every hue.**
  Turned, the accent `#2ec44f` leaves sRGB at most hues (clipped, it
  drifts in lightness), dark text on it drops to 6.5:1, and the link
  colour to 7.1:1; kept, they're the same everywhere and say "Canopy".
  · Looked right on purple, blue, red and olive in the browser. · To
  turn them, add `accent`/`accentText` rows to `THEME_MESH` and the
  `--theme-*` variables.
- **Yellow comes out olive**: a yellow as dark as the green is olive,
  which is what equal darkness means. Accepted rather than brightening
  yellow (which would break the "same darkness" rule the contrast rests
  on). · n/a
- The theme rides on `<html style="--theme-…">` (lib/render.js), so the
  page's own background, the overscroll area, the mesh, the cards, the
  hero's fade and the title's shadow all follow, and `<meta
  name="theme-color">` (the phone's browser bar) is the turned base.
  The generated cover picture turns with it too. · n/a
- **Where it applies**: the event page (signed in and out) and its
  editor. Home tints that event's card glass (the card tint at 45%
  rather than 30%, so it shows on the green); home, friends, inviting
  and co-hosts otherwise stay green. · The brief. · `eventRow`.
- **The editor's slider** is a native `<input type=range>` (0–359)
  under the cover, on its own row, with a rainbow track drawn at a
  visible lightness (the mesh's own colours are too dark to tell apart
  on a thin track) and a 30px thumb in the current glow colour; dragging
  it repaints the editor page itself. "Canopy green" sets null and is
  disabled while it is. Nothing is saved until Save. · Native ranges
  work with touch everywhere; no library. · `themeField`,
  views/editor.html. (Superseded below: the reset button went.)

### Cover geometry, a photo's colour, and no colour (schema version 8)

- **The frame**: 3:2, its top 16:9 the clear picture, the band below
  (width × 0.1042) the fade, and the title's top at the band's top. The
  overlap is `-10.4167cqw` on `.event-head`, a size container as wide as
  the frame, so it's exact at every width; on phones the whole head is
  full-bleed (its text and card put the gutter back). No rounding at the
  bottom ever; top corners only, from 700px. The how-soon pill sits
  inside the 16:9, 10px above the band, on the left. · The owner's
  geometry. · `.event-head`, `.hero`, `.head-text` in public/events.css.
- **The fade starts above the band**: clear to 62% of the frame's
  height, 72% at the band's top (84.375%), 92% at 93%, solid at 100%,
  then a mask melts the last 6% into the mesh. So the lowest ~quarter of
  the 16:9 darkens gently. · Starting the fade only at the band would
  put the title's first line on bare photo: white on a white sky would
  be 1:1. At 72% base under the title's top it's about 8:1 over pure
  white, at any hue (the fade is the hue-turned base). · The gradient
  stops in `.hero::after`.
- **The editor's preview is the same frame**: 3:2, top corners rounded,
  with the band under the 16:9 dimmed (42% black) below a dashed guide
  line. · "Lightly show where the safe area ends." · `.safe-guide`.
- List thumbnails stay plain 3:2, no fade (at 116px a fade only muddies
  them). · n/a
- **`coverHue` is worked out by one function in `public/ui.js`**
  (`hueFromPixels`), run by the cover worker on a 64×64 copy of the
  stored JPEG, and by the editor in the browser on a photo just picked
  (a canvas). Pixels go to OKLCH; near-grey (C < 0.04), dark (L < 0.2)
  and light (L > 0.93) ones are skipped; the rest add their chroma to
  one-degree hue bins; the best ±12° window wins, refined to its
  chroma-weighted circular mean. Under 4% of pixels counting is grey. ·
  One function means the slider's jump and the stored suggestion agree.
  The thresholds were picked on synthetic photos (tests: mostly red →
  ~27°, sky over field → whichever is bigger, grey with a 2% speck of
  red → grey, dark and pastel ignored). · Tune the constants in
  `hueFromPixels`.
- **The editor still sends the cover on Save**, so "right after an
  upload" is right after the photo is picked: the browser works out the
  same hue and the slider jumps there (unless the browser can't draw the
  photo, e.g. HEIC outside Safari: then no jump, and the server's
  `coverHue` is there next time). "Match photo" shows only when the
  photo's colour is known (a stored cover's `coverHue`/`coverGrayscale`,
  or the picked one's), and re-applies it. · Uploading on pick would
  change the live page before Save, which the editor otherwise never
  does. · views/editor.html `matchPicked`.
- A failure working out the hue never fails the upload: the cover is
  stored with no suggestion. · It's a suggestion. · lib/coverWorker.js.
- **No colour: `themeGrayscale: true`**, a second field beside
  `themeHue`, not a magic hue. While true, `themeHue` is ignored but
  kept, so turning grey off goes back to the old hue. Grey keeps every
  colour's L and sets C to 0 (neutral greys exactly as light, so the
  contrast holds; a test checks white on a card over the brightest glow
  is still ≥ 9:1). The generated picture and the card tints go grey too.
  · The orchestrator's suggested shape; a `theme` object would have
  meant changing `themeHue`, which the iOS app already reads. · n/a
- **`coverGrayscale` sits beside `coverHue`**, because "no hue" means
  two things: a grey photo, or not known (a cover from before version
  8, or none). Both are null/false with no cover. · Without it, every
  old cover would read as grey. · n/a
- Buttons and links stay Canopy green on grey too. · Same reasons as
  for hues; it's the one bit of colour left, and it says Canopy. · n/a
- **The slider**: 0–389, the first 30 steps grey (about 8% of the
  track, drawn as a grey stretch at the rainbow's lightness), then the
  hues 0–359. An untouched new event's slider sits on Canopy green's
  hue and saves null; "Canopy green" (the reset) is gone, as asked;
  dragging back to 161 looks the same as null. · n/a · `SLIDER_GREY`,
  `sliderOf`, `keyOfSlider` in public/ui.js.

### Attending (the owner's reference screenshot)

- **The summary counts people**, "4 Going · 2 Maybe", adding "· 3
  Waitlist" only when there is one, and the plus-ones going and maybe
  bring after them ("· +3 guests"). · Everywhere else counts people
  with plus-ones beside them, and "+N" on the faces is people too, so
  the numbers agree. · `attendSummary`.
- **"+N" is people**: everyone going or maybe (from the counts, not just
  the 50 loaded) less the faces shown. Waitlisted and can't-go people
  aren't in the row; they're in View all. · "Attending" means going or
  maybe. · `attendRow`.
- **The row's order**: friends going first (the API's friends-going
  list), then going, then maybe, newest answer first within each. ·
  The brief. · `attendPeople`.
- **How many faces fit is worked out by the page**: the server draws 5
  (a phone), and the script measures the row and redraws with as many
  56px circles (64px from 700px) as fit at least 8px apart, the last
  one "+N" when there are more; again on resize. A CSS grid of that many
  columns, `space-between`, keeps them even. · Only the browser knows
  the width. · views/event.html `fitAvatars`.
- **"View all" is a `<details>`** whose summary is the pill, placed level
  with the heading; it opens the whole list by answer under the row,
  with the host's tools (Remove, the invited group, the removed with
  Undo, Show more). The page remembers it open across redraws (after a
  remove, say). In-page rather than a new page, so the host's tools keep
  working as they are and nothing loads twice. · `guestsSection`,
  `guestGroups`.
- **The "Friends going" card is gone**: friends lead the row. When the
  names are hidden (the responded-only rule) the section keeps the
  heading and counts, says "2 friends going" if any, and the old reason;
  no faces and no View all. Signed out: the heading and counts only. ·
  The count of friends is the one thing the card said that the row
  can't when names are hidden. · n/a
- The details card no longer repeats the counts (Attending says them,
  signed out too); it keeps spots left. Hosts' "N invited" is now the
  invited group's count inside View all. · One place for counts. · n/a
- Faces with no photo are initials on the event's brightest glow colour
  (`--mesh-3`), so they follow the hue (and go grey). Tapping a face
  does nothing; each has the person's name as a `title`. · n/a
- The minimum gap between faces is 5px, which fits 5 at 375px (8px
  fitted only 4) and 9 at desktop width. · Seen in the browser. ·
  `MIN_GAP` in views/event.html.

### The host's controls, and deleting an event

- **Layout**: "Share link" and "Invite" side by side (while the event is
  on), then "Edit" wide with a ⋯ button beside it. The creator's menu:
  Co-hosts…, Make a new link… (while on), Cancel event or Bring back
  event, and Delete event… last, in red under a rule. A co-host's: Step
  down as co-host. Those controls are nowhere else on the page now. ·
  The owner's layout. · `hostSection` in public/ui.js.
- **The menu** is a `role="menu"` popover under the ⋯ (a button with
  `aria-haspopup="menu"`, `aria-expanded`, `aria-controls`), drawn as a
  solid card in the event's own card colour (`--theme-card-solid`), not
  glass, since it floats over other buttons. Opening focuses the first
  item; arrows, Home and End move; Escape closes and returns focus to
  ⋯; Tab, a tap outside, or picking an item closes it. The host's card
  is lifted above the cards after it (each glass card is its own
  stacking context, so the menu was painted under the next one). · A
  sheet would be more work for four items. · views/event.html.
- **"Co-hosts…"** opens the existing co-hosts block (list with Remove,
  and Add co-host) inside the host's card, and scrolls to it. · The
  brief. · `d.showCohosts`.
- **`DELETE /api/v1/events/{id}`**, the creator only (403
  `creator_only` for a co-host, a guest or anyone else; 401 signed out).
  It deletes the row, and the database's cascades take its hosts,
  answers, invitations, wall and every inbox entry about it; the route
  removes the cover file. `hosted_people` keeps its hosts (once a host,
  always a host). The link is a 404 `event_not_found` afterwards. No
  schema change. · routes/events.js.
- **Nobody is notified of a deletion**, and its existing notifications
  go with it. · There's no event left to open, so a notification could
  only say "something you were going to is gone" with nothing behind it;
  cancelling is the way to tell people, and the confirm says so. ·
  Notify `audienceOf` with an `event_deleted` type carrying the title
  (needs `event` null in the inbox and a new type for the apps).
- **The confirm** names the event; when people have said going or maybe
  and the event isn't over, it says how many, that deleting doesn't tell
  them and cancelling does, and still lets the host delete. After
  deleting, the page goes to Your events. · The brief. · `delete-event`
  in views/event.html.
- The Invite button says "Invite" (was "Invite friends"): it also finds
  people by phone or Instagram now, and two buttons share the row. · n/a

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

## Events review fixes

Fixes for the security review's events findings (branch `fix/review`).

- **The whole cover conversion runs in one worker thread**
  (`lib/coverWorker.js`), not just the HEIC decode, one upload at a time
  in a queue. · The WebAssembly decoder is synchronous (100 ms to most of
  a second per photo), and sharp's raw-pixel copies are big; a single
  worker keeps peak memory to one decode. Covers are rare, so a queue
  costs little. · Make `toCoverJpeg` call `convert` directly.
- The worker is **stopped after 30 s idle, after any failed job, and
  after a job that runs past 30 s** (refused as 400 `bad_image`, "took
  too long to read"). · A WebAssembly heap only grows while its worker
  lives, and heic-decode doesn't free its decoder when a file won't
  parse (that's inside the library); replacing the worker after a
  failure means a stream of broken files can't build up a leak. The
  cost is starting a worker (about half a second) on the next upload. ·
  `IDLE_MS`, `JOB_TIMEOUT_MS` and `finish()` in lib/coverImage.js.
- **HEIC is capped at 25 megapixels** (other formats stay at 50). ·
  HEIC is decoded whole into memory, about 10 bytes a pixel twice over,
  so a 48 MP "HEIF Max" photo needed several hundred MB at once. 25 MP
  takes the 12 and 24 MP photos iPhones save by default; Safari sends
  the web page a JPEG anyway, and the app can shrink first. ·
  `MAX_HEIC_PIXELS` in lib/coverImage.js.
- The HEIC fixtures were made with macOS `sips`: `cover-2mp.heic`
  (657 KB of noise, so it's slow to decode like a real photo and a leak
  shows) and `cover-26mp.heic` (14 KB, plain, just over the cap). · The
  489-byte `cover.heic` leaks too little to measure. · n/a
- The leak test checks the **libheif WebAssembly heap size**
  (`HEAPU8.length`) to within 2 MB, and RSS through the worker only
  loosely (under 80 MB growth over 20). · RSS moves a lot with GC and
  allocator timing; the heap size is exact (17 MB steady after the fix,
  +12 MB over 12 conversions without it). The /healthz test calibrates
  itself: no /healthz may take half as long as the upload (4 ms vs a
  133 ms upload after the fix; 100 ms of 126 ms before). · n/a
- **Removing or uninviting someone deletes all their notifications about
  that event**, in the same transaction (lib/store/rsvps.js
  `removeGuest`, `uninvite`). Undoing a removal doesn't bring them
  back. · Every entry carries the event's link. · Drop
  `forgetNotifications`.
- **The inbox's `event` is null** (not "title only") for anyone not on
  the event now: not a host, and no invited-or-answered row that isn't
  `removed` (`store.isOnEvent`). · Null was already allowed by the spec,
  so apps need no new shape, and it gives away nothing; a title-only
  object would have been a new schema with optional `id`. · lib/views.js
  `notificationViews`.
- That rule also covers **someone who answered without an invitation
  and took the answer back**: their old entries stay but lose the
  event. · They're off the list, the same as an uninvited person, and a
  host may have made a new link with them in mind. The cost is an inbox
  line they can't open; answering again at the link brings it back. ·
  Count a deleted answer as "on" (needs a record of it).
- **The push payload follows the same rule** (`eventId` and
  `eventTitle` null for someone not on the event), checked when it's
  queued. Everyone notified today is on the event, so this changes
  nothing now; it's a guard for later triggers. There's no persistent
  push queue (`push.queue` sends on the next tick), so there was no
  queued push to delete. · n/a
- **The other places that give out the current link were checked and
  left alone**: `/me/events/*` lists only events you host or have a
  non-removed row on; the wall, the guest list, cover URLs, friends and
  `/me` don't carry an event's id; every `/events/{id}` route needs the
  current link to begin with. · n/a
- **A cover upload that isn't a well-formed form is 400 `bad_image`**,
  not a new `bad_upload`. · multer's own errors (wrong field, too many
  files) were already `bad_image`, and apps branch on one reason for "the
  upload was wrong". Every non-multer error from the form parser counts,
  since memory storage can't fail on our side. · routes/covers.js
  `receive`.
- **The error handler honours a 4xx `err.status`**: under `/api/` it's
  that status with reason `bad_request` (`too_large` for 413) and our own
  sentence, never `err.message`. `bad_request` is new, and `400` was
  added to the five operations that didn't list one (`getEvent`,
  `deleteWallEntry`, `deleteCover`, `newLink`,
  `markAllNotificationsRead`), which a broken `%` escape or a broken
  JSON body can reach. · Express already marks undecodable params as
  400; a 404 would have needed no spec change but would claim the URL
  was well-formed. · server.js.
- **For a page URL** (`/e/%E0%A4%A`) it's the existing "nothing here"
  page (`pages.notFound`, a 404) for a browser asking for HTML, and a
  plain-text 400 otherwise. No view or `lib/render.js` change. · The
  page machinery offers only that page; a 404 says the same thing to a
  person. · server.js.
- A GET to a path that only has other methods (`GET
  /api/v1/events/{id}/wall/%zz`) is a 400 too, not the catch-all 404,
  because Express decodes params while matching a path before checking
  the method. · Harmless, and not worth a special case. · n/a
- **`counts.invited` is null for non-hosts** (signed out included), on
  the event, in every list, and on `/guests`; the key stays, so `Counts`
  keeps the same required fields. · The spec models "not yours to see"
  as null elsewhere (`viewer`, `locationAddress`, `spotsLeft`), and a
  missing key would break apps that decode `Counts` strictly. The pages
  only showed it to hosts, so nothing visible changes (that's true of
  `feat/web-features`' `public/ui.js` too, checked at the time). ·
  lib/views.js `countsView`.
- **(You) Partly undone:** unverified accounts are findable by
  **Instagram** again, because on a new network most people never
  confirm their email. Phone lookups still need a verified account,
  since numbers can be enumerated. · The impostor case is back for
  Instagram, but only while the real owner hasn't claimed their own
  handle. · Account service `findPerson` (2866489 on main). The real fix is
  proving the handle (see "Instagram ownership" below).
- **(You)** Cover geometry: a 3:2 frame whose top 16:9 is the
  semi-safe image area (the relative-time pill may sit there). The
  remaining bottom band fades into the background and holds the event
  title. Bottom corners are never rounded.
- **(You)** Uploading a cover suggests a hue that matches the photo,
  and the host can still change it.
- Assumed: the server computes `coverHue` (a chroma-weighted OKLCH hue
  histogram's peak, or null for greyscale) and stores it with the cover.
  The web editor jumps the slider to it after an upload and offers a
  "Match photo" button. `themeHue` only changes when the host saves, and
  an API-only upload never changes it, so the apps decide for
  themselves.
- **(You)** No "Canopy green" button: green is just where the slider
  starts. One end of the slider is fully greyscale, for colour-free
  events. A greyscale cover makes "Match photo" choose greyscale.
- Assumed (the agent may refine it): the API is `themeHue` plus a
  `themeGrayscale` boolean, with no magic hue values. Greyscale keeps
  the same lightness as every other position, so contrast holds.
- **(You)** The theme API (`themeHue` + `themeGrayscale`) is fine.
- **(You)** The guest section is called "Attending". It has a large
  heading, a "82 Going · 64 Maybe" summary, a "View all" pill, and one
  row of large round avatars ending in a "+N" circle (from your
  reference screenshot).
- Assumed: the avatars don't overlap, and as many fit as the width
  allows. Order is friends first, then going before maybe, then newest.
  +N counts people. The grouped list and the host's tools live behind
  "View all". When the list is hidden, the counts stay and a one-line
  reason replaces the avatars.
- **(You)** Host controls on the event page: "Share link" and "Invite"
  on one line, then "Edit" with a ⋯ menu beside it. Co-hosts, new
  link, cancel and delete all live in that menu.
- Assumed: you meant the event page's host area, not the editor. Delete
  is new: `DELETE /api/v1/events/{id}`, creator only, removing everything
  (the link then 404s). The confirm suggests cancelling instead when
  people have answered. Co-hosts get "Step down" in the menu.
- **(You)** UI updates reach events main more often. The web agent
  merges main into its branch, runs the tests, and fast-forwards main
  after each finished change, instead of the orchestrator merging at the
  end. · Schema steps deploy as they land, so a step on main is never
  edited, only followed by the next one.

## Performance

- **(You)** Covers get resized variants now. Caching and asset tuning
  (external versioned JS/CSS, cache headers, an SVG logo) wait until
  development is closer to done.
- Measured on an event page (local, 6 guests): 1 request, 138 KB raw
  / 40 KB gzipped, 3.5 MB JS heap, 164 DOM elements, first paint about
  100 ms. Covers were the real weight.
- **Ready for your review (not merged):** `feat/data-security`,
  account f1a5686 (168 tests) and events 81b17eb (208 tests); both pass
  and the events branch merges cleanly. Its full decision list is on
  that branch. **The order matters when merging:** account first (with
  `CONTACT_ENCRYPTION_KEYS` and `LOOKUP_HMAC_KEY` set in Coolify before
  deploying), then events, because events' lookup becomes a POST that
  only the new account service answers. iOS follow-up: events'
  `/api/v1/me` stops returning your contact details, so the app's
  profile must read them from the account service's `/api/native/v1/me`.
- **(You)** The semi-safe area is 2:1, not 16:9, and the fade was too
  abrupt. The fade now eases in from 45% of the frame (nine stops), 70%
  at the band's top (75% of the frame), and solid at the foot. The title
  overlaps by the band's height (width × 1/6). docs/api.md has the exact
  stops for the iOS app.
- **(You)** The editor looks like the event: the cover hero on top, an
  upload button and a × remove in its top right, and no help text. Time
  zones get friendly names in small text under the time, with a
  "Change" menu listing the nearby zones first (from Pacific: Hawaii,
  Alaska, Pacific, Mountain, Central, Eastern).
- Assumed: "nearby" means within about ±3 h of the viewer's zone at the
  event's date (DST-correct), one entry per friendly zone, then "Other
  time zones…" with search. The event page uses the same friendly names.
  The API still stores IANA ids.
- **(You)** The cover is part of the top card. The card's outline
  fades out going up and is fully visible from about the place row down,
  so the photo and title have no hard border. The editor mirrors it.
  Phone treatment is the agent's call (edge to edge, or inset), to be
  recorded.

## Cover image sizes

- **Narrower copies of every cover, JPEG only, at 400, 800 and 1200 px
  wide plus the full size (up to 1600).** · Measured on six real photos
  (stock photos at 5–13 MP, cropped to 4:3, and one brought to 4032×3024)
  through the real pipeline: picking the right width saves 35–43% of the
  hero on a 375 pt phone at 3× and 88–94% of a list thumbnail. WebP at
  the same quality 82 is only 14–20% smaller than the JPEG; at quality
  75 it's about 35% smaller, but I didn't check that it looks as good,
  and keeping the quality settings was the brief. WebP would double the
  files, need `<picture>` in three places and a `type` on each
  `coverImages` entry, and og:image has to stay JPEG anyway. · To add
  WebP: encode it in `encodeSizes` (lib/coverImage.js) as
  `<id>-<width>.webp`, add `type` to `coverImages` entries (additive),
  and wrap the page's `<img>`s in `<picture>`.
- **A 1200 copy, beyond the suggested 400/800/1600.** · A 375–414 pt
  phone at 3× needs 1125–1242 px for the full-width hero, so without
  1200 it would still get the 1600 and save nothing on the page people
  open most. The 400 covers every thumbnail (116 or 168 CSS px at 2× or
  3×). · `WIDTHS` in lib/coverImage.js. Each cover records the sizes it
  actually has, so changing the list never breaks one stored earlier.
- **One decode, then every size from the same pixels.** The photo is
  decoded, turned, shrunk to fit 1600 and flattened once into raw 8-bit
  sRGB pixels; each size is encoded from those. The full size comes out
  byte-for-byte what it was before (checked on two photos). Cost: an
  upload takes about 25 ms more (49 → 75 ms for a 12 MP JPEG on this
  Mac), and a cover takes about twice the disk (the copies add up to
  about the full size). · Encode only the full size in `convertSizes`.
- **The full size keeps its file and URL** (`covers/<event id>.jpg`,
  `/covers/<key>.jpg`); copies are `covers/<event id>-<width>.jpg` on
  disk and `/covers/<key>-<width>.jpg` publicly. No `-1600` duplicate,
  and the full size has only the one URL (`<key>-<full width>.jpg` is a
  404), so caches never hold it twice. Disk names stay on the internal
  id, which never changes, so "new link" and delete work as before. A
  name is served only if it matches one pattern and the width is one the
  cover has; tests throw path-traversal and junk names at it. · Routes
  in routes/covers.js, names in lib/coverStore.js.
- **The sizes are in the database (schema version 9, `cover_sizes`,
  JSON `[[width, height], ...]`), not read off the disk.** · Every event
  in every list carries `coverImages`, so no file system calls per row;
  NULL with a cover marks one from before, waiting for its copies; and
  heights come free. · A later step can stop using it; the column is
  harmless.
- **API: `coverImages: [{ width, height, url }]`, narrowest first, the
  last being `coverImageUrl`.** An array rather than a map, so "the
  narrowest at least N wide" is a scan. `height` is there so apps can
  size a frame before the image loads and allow for a photo wider than
  its frame. `[]` with no cover, and while a cover from before is
  waiting (its size isn't known without reading the file); apps use
  `coverImageUrl` then. Also on the notification's event summary, for
  inbox thumbnails. · Additive; removing it is a breaking change for
  apps that adopt it.
- **Existing covers are backfilled after startup, in the background,
  not lazily.** One at a time through the same worker as uploads (an
  upload waits behind at most one, about 22 ms each from a stored 1600
  JPEG), only covers with no sizes, so it's idempotent and a no-op once
  done. The stored full size isn't touched or re-encoded. Each one is
  finished synchronously once the worker answers (still the same cover?
  write files, record sizes), so an upload or delete made meanwhile
  wins and the old photo's copies are dropped. Failures (file missing,
  unreadable) are logged and retried at the next start. Lazy-on-request
  would put the work on the request path and need per-request
  bookkeeping for no gain at this scale. · Remove the call in server.js
  (pages and apps keep working on `coverImageUrl`).
- **`sizes` on each `<img>` follows its layout, and grows for photos
  wider than 3:2.** Hero `(min-width: 700px) 680px, 100vw`; thumbnail
  `168px` / `116px`; editor preview `640px` / `calc(100vw - 72px)` (the
  form card's padding). The frames are 3:2 and filled `object-fit:
  cover`, so a 16:9 photo is drawn 1.19× its frame's width, and `sizes`
  says so, or panoramas would come out soft. Thumbnails are
  `loading="lazy"`, the hero isn't; all are `decoding="async"`.
  og:image stays the full-size JPEG. · `COVER_DRAWN` and `coverSizes` in
  public/ui.js.
- **Assumed: the hero, thumbnail and editor layouts as they are on main
  today.** The log above mentions an editor redesign (the cover as a
  hero on top) and the cover joining the top card, possibly inset on
  phones. Whoever lands those should update `COVER_DRAWN` in
  public/ui.js (the page tests pin the current `sizes`). Picking a new
  photo in the editor drops the saved cover's `srcset`, or the browser
  would keep showing the old one.

## Calendar feed (queued, on branches for review)

- **(You)** A personal calendar feed, and a shared Canopy calendar
  across all apps.
- Design: one `webcal://account.canopysf.com/cal/<secret>.ics` per
  person (the secret is stored hashed, with reset on the profile). The
  account service pulls each site's entries server to server
  (`GET /api/calendar/<personId>`, JSON), merges them, caches each site
  for about 5 minutes, and serves a site's last good copy when it's
  down. Sites keep their own data; the account service stores none.
  Events is the first site. **Tickets has to implement the same
  contract** (that repo isn't on this machine).
- The account side is built on `feat/data-security` (schema v11),
  because that branch already uses v8–10. So **merge data-security
  first.**
- Events entries: hosting and going are confirmed; maybe and waitlisted
  are tentative; cancelled ones are kept marked cancelled for 30 days;
  declined and removed are dropped. No guest names.

## Event card

- **The cover, the title and when, the place, the hosts and the
  description are one card.** The hero is the card's top; the details
  under it lost their own `.card` and carry the glass and the outline on
  `.details-card::before`, which starts 64px (`--card-fade`) above the
  details and fades in over those 64px with a mask. It's measured from
  the details themselves, so the outline is fully there just above the
  place row (or the hosts, with no place) however long the title is.
  There's no top border: the sides fade up into the photo. · The
  owner's screenshot note. · Put `card` back on `details-card` in
  `details()` (public/ui.js) and delete the `::before` rule.
- **Phones: the whole card edge to edge**, the glass full width with no
  side lines, only a line along its foot. · The hero was already edge to
  edge on a phone; an inset card would either shrink the photo by 32px
  with rounded corners or put a vertical line a few pixels from the
  screen's edge beside an edge-to-edge photo. Edge to edge looked
  cleaner at 375px with a bright, a dark and no cover. · Give
  `.event-head` the gutter as margins below 700px and the `::before` a
  full border.
- From 700px the hero's top corners are 18px (the cards' radius, was
  20px), and the outline has the same radius at the bottom. · One card.
  · `.hero` in the 700px block.
- The hero still fades into the page's base colour, not into the glass.
  · The glass is see-through over a mesh whose glows move with the
  scroll, so there's no one colour to fade to; the difference is a
  slightly darker strip under the title, which reads as the photo's
  shadow. · n/a
- `COVER_DRAWN.hero` is unchanged (680px from 700px, 100vw on a phone):
  the card is exactly as wide as the hero was. · n/a · public/ui.js.

## Editor redesign

- **The editor is the event card**, as the page draws it: the cover as
  the hero (the generated picture in the event's colour without one),
  the title typed where the title goes, the date and times as big as the
  page's, the zone under them, then the place, address and description
  in the card. Under it: a "Guests" card (who sees the list, plus-ones,
  capacity), a "Colour" card (the slider and Match photo), and Save in a
  bar stuck to the bottom of the screen. · The owner's direction; Save
  in reach on a long phone form. · `editorForm` in public/ui.js,
  views/editor.html.
- The "New Event" / "Edit Event" heading is read out but not shown, and
  the "‹ title" link above the form went (Back is beside Save). · The
  page should open on the hero, as the event does. · `editorForm`.
- **The title is a one-line textarea that grows**, so a long title
  wraps exactly as it will on the page. Return doesn't add a line, and a
  pasted line break becomes a space. · An `<input>` can't wrap. ·
  `fitTitle` in views/editor.html.
- **When: the start is a date and a time, each its own picker; the end
  is one date-and-time picker.** Each is the browser's own input, made
  see-through and laid over the words ("Tuesday, October 13", "7:30
  PM"), with a dashed underline to say it can be tapped; a mouse click
  calls `showPicker()`. "+ End time" sets the end three hours after the
  start and opens it; × clears it. An end on another day reads "Sun, Oct
  11, 11:00 AM" on the time line (not the page's two-line multi-day
  form, which needs the end's day and time in two places). Moving the
  start moves the end with it, keeping the length. A day without a time
  sends no start, so the API's "Pick when it starts" shows under the
  date. · Native pickers on phones, no library, and any end (overnight,
  multi-day) still possible. · views/editor.html.
- **Field look**: the place, address and description are quiet fields
  with a dashed edge (dashed means "tap to edit", as under the date and
  times). Errors still show under each field. · They have to read as the
  page and still look editable. · `.details-card .soft`.
- **No help text**, as asked. Labels are short and only shown where the
  field doesn't say what it is (the guest settings and colour); the
  rest are read out (`.sr-only`). Hints moved into placeholders where
  they matter: "Address (only signed-in guests see it)", "No limit".
  The visibility choices are now "Everyone with the link" and "Only
  people who've answered" (they no longer say that the others see the
  counts). The two status lines stay: "can't be previewed" (now a
  caption on the hero) and "the event is saved, but its cover didn't
  upload". Unused strings are gone from copy.js. · The owner's
  direction. · `COPY.editor`.
- **The cover buttons**: 48px circles of dark glass with a white edge
  and a white icon (camera; ×), top right of the hero, readable on a
  white sky and on a night photo. The upload's name (read out, and its
  tooltip) is "Add cover photo" or "Change cover photo"; the × is
  "Remove cover photo" and only there with a photo. Nothing is sent
  until Save, as before. · n/a · `coverHero`, `.hero-btn`.
- `COVER_DRAWN.editor` is gone: the editor's cover is the event card's
  hero, so it asks for the hero's sizes (with the wide-photo scaling),
  and the page test pins that. · n/a · public/ui.js.
- A new event's generated picture is placed by an empty id, so after
  Save the event's page places its glows differently (by its new id);
  the colours match. · The id doesn't exist until Save. · n/a
- **Time zones by friendly name** (`UI.zoneName`): Intl's
  `longGeneric` name with "Standard Time" shortened to "Time", and a
  table of overrides where that name is clumsy or wrong ("Hawaii Time",
  "Arizona", "London", "Mexico City", "Gulf Time", "India Time",
  "China Time"…). A zone that shares a main zone's generic name but not
  its clock (Mexico City, Regina: "Central" with no summer time) is its
  city, as is a zone with no name (only "GMT-5"). · The owner's list. ·
  `ZONE_NAMES`, `MAIN_ZONES` in public/ui.js.
- **The nearby list is one zone per offset**, within 3 hours of the
  viewer's own at the event's start (now, without one), west to east.
  Each offset is stood for by the first of 33 main zones with it,
  preferring the viewer's continent (Paris gets Athens for +3, not
  Nairobi). The viewer's own zone and the event's are always in it, and
  marked ("Your time zone"; ✓) by friendly name, so a Vancouver viewer's
  "Pacific Time" is Los Angeles. · "One per distinct friendly zone"
  literally would list Arizona for every Pacific viewer (it's within
  range all year), but the owner's example is exactly six: Arizona always
  shares Pacific's clock (summer) or Mountain's (winter), so one per
  offset leaves it out unless you're in Arizona. · `nearbyZones`; to show
  every distinct name, group by `zoneName` instead of offset.
- "Other time zones…" opens a sheet over the page (a modal dialog: the
  search field, then every zone the browser knows, friendly name with
  the city under it and the offset small, west to east at the event's
  date). Enter takes the first match; Escape or a tap outside closes. ·
  A popover is too small for 400 zones with a phone's keyboard up. ·
  views/editor.html `openZonePanel`.
- The server draws the zone menu for the `tz` cookie's zone (so the
  page and its tests have it); the browser draws it again each time it
  opens, for its own zone and the date as typed. While the menu or the
  sheet is open, the Save bar drops beneath them. · n/a
- **The event page uses the friendly names**: "Times are in Pacific
  Time." under the time, and the wall's "moved it to Sat, Oct 31 · 7:30
  PM Pacific Time". List rows and link previews keep the short "PDT":
  they're one tight line. · n/a · `whenHead`, `whenShort`.

## iOS: following the web designs

- **(You)** The iOS app adopts the new web designs. Its top card has
  **no border at all**, because the cover is edge to edge. The theme
  colours are derived exactly as docs/api.md describes (OKLCH). The app
  stays fully mocked. The iOS agent's own judgment calls go in the iOS
  repo's ARCHITECTURE.md ("Decisions").

## Calendar feed: ready for review (feat/calendar)

- Built on branches: account 75c2d4a (on feat/data-security, schema
  v11) and events bf65597. The account service proves itself to sites
  with an HMAC-signed request: `Authorization: Canopy-Calendar t=,sig=`
  using a per-site secret shown once in the Sites tab, set on the site
  as `CANOPY_CALENDAR_SECRET`, ±5 minutes. Feed links are stored hashed
  and also sealed, so "Copy link" can show them again. A person no site
  has ever answered for gets a 503, not an empty calendar, so calendar
  apps don't wipe their events. Last-good copies are kept in memory
  only, since they contain addresses. Cancelled entries get "Cancelled:"
  in the title, for Google. Tickets' contract is in the account README.
  A flaky ETag/304 test was fixed in 7ad3a79: the test's fake sites
  built their times from the clock on every request. The feed itself
  was deterministic. 183/183, repeatedly.
- **Merge order:** data-security, then calendar (account), then events
  calendar. Then copy the full `client/canopy-account.js` into events
  again.

## Mobile web polish

- **(You)** On phones the event has no card: the hero, title, when,
  place, hosts and description sit on the page's background, with no
  outline, no line along the foot and no rule above the description.
  Below 700px `.details-card::before` doesn't exist at all; the space
  under the description is 12px plus the usual 16px gap. Replaces "Phones:
  the whole card edge to edge" under "Event card". · The owner's
  screenshot. · events.css, "The event".
- **The desktop card stays** from 700px (the glass and the fading
  outline), but the rule between the hosts and the description is gone
  there too (22px of space instead). · At 900px the card still frames a
  column that would otherwise float on a wide background, and the rule
  added nothing inside it once the phone had none. · Put `border-top`
  back on `.description` in the 700px block.
- **Why the background jumped on an iPhone**: the mesh's fixed layers
  were `inset:0`, which in Safari follows the visible area, so they grew
  and shrank by the toolbars' height as the page scrolled, and every
  glow (placed in percentages) slid and stretched; while Safari caught
  up, the strip it hadn't redrawn showed the bare page colour behind the
  status and bottom bars. Now they're `top:0; height:100lvh` (100vh
  where lvh isn't known): always the tallest the screen gets, anchored
  at the top, so the toolbars only cover their bottom edge. Never
  `100dvh` for the background. The body's `min-height` is `100svh`
  (was `100dvh`, which also moved). The full explanation is in
  events.css above `.mesh-bg`. · n/a · events.css.
- Already in place and kept: `viewport-fit=cover` on every page, html
  and body painted the event's base colour (`--theme-base`, grey too),
  and `<meta name="theme-color">` set by the server to the same base
  (lib/render.js, the same `themeColors` the CSS variables come from;
  the editor updates it live). New tests pin the meta to exactly
  `--theme-base` for a hue and for grey, and viewport-fit on every page.
  · n/a
- **Safe areas**: the page's top padding is at least
  `env(safe-area-inset-top)` (it's 0 in Safari's own window, and the
  status bar's height in a home-screen web app), so the header, and the
  hero under it, never run under the status bar. The hero stays below
  the header, not under the status bar: the header has to be first. ·
  n/a · events.css, `body`.
- **Room for Safari's floating toolbar**: below 700px the page ends with
  `72px + env(safe-area-inset-bottom)` of padding (`--toolbar-clear`),
  so Attending's faces (the last thing signed out) and Sign out scroll
  fully clear of iOS 26's bottom bar. 72px is a guess at the bar's
  height plus its margin. · Chromium can't show it, and I don't know
  the bar's exact height. · `--toolbar-clear` in events.css.
- **The ⋯ button**: an inline SVG of three dots (on the box's centre, so
  it doesn't depend on where the font puts "⋯"), in a 50px square with
  Edit's border, glass and radius, read out as "More". Share link,
  Invite and Edit are now exactly 50px high too (a link and a button had
  come out a pixel or so apart). · The owner's report. · `ICON.more` in
  public/ui.js, `.more-btn` in events.css.
- **No sentence under "You're hosting" or "You're co-hosting"**: the
  card is the heading and the buttons, as the editor lost its help text.
  The co-host's sentence said what only the creator can do; the co-host's
  menu already only offers what they can. The cancelled and ended lines
  stay (they're state, not help). `hostingHint` and `cohostingHint` are
  gone from copy.js. · The owner suggested it. · Bring the `else` line
  back in `hostSection()`.
- The hero's last stretch now melts into the page over its bottom 22%
  (was 6%), so the edge between the photo's dark foot and the mesh,
  which shows more now there's no glass under it, is a soft fall rather
  than a band. White text there is over the base colour or the mesh,
  both already checked. · Looked like a dark stripe at 390px. ·
  `.hero` mask in events.css.
- The mesh rules are the copy of the account service's account.css: the
  same lvh fix belongs there (its pages have the same fixed layers). Not
  done here; this branch doesn't touch canopy-account-service. · n/a
- The same background fix went to the account service (6aabda1): mesh
  layers at 100lvh pinned to the top, and the page's min-height at
  100svh. The photo-backdrop variant already did this.
- **(You)** iOS event page, on pull-down: the hero image stays put
  (pinned to the top of the screen, no stretch or zoom). The content,
  with the fade and title, rubber-bands down over the bottom of the
  photo. Scrolling up moves everything together as usual. The iOS repo's
  ARCHITECTURE.md records the details.
- From the owner's iPhone screenshots: iOS 26 Safari paints the strips
  behind its status bar and floating toolbar one flat colour (the base),
  and the mesh's glows ran right up to them, leaving hard seams that
  shifted as glows scrolled past. The mesh (and its grain) now fades to
  the base colour over the top ~18% and bottom ~24% of the screen, so
  the strips meet the same colour. The account pages got the same
  change. · Cost: slightly less glow at the top and bottom. · The first
  gradient layer of `.mesh-bg::before` in events.css and account.css.
- **(You)** The header photo opens an account menu: your name first
  (with "Canopy Account" under it, linking to your Canopy profile), then
  Sign out. Sign out is removed everywhere else (the page footer is
  gone). · The menu uses the same keyboard and Escape behaviour as the
  host ⋯ menu. · lib/render.js `header()`, public/events.js
  `accountMenu`.
- **Reversed the edge fade** (cf7c6a6): fading the fixed mesh to base
  near the edges left a vignette that content visibly scrolled through.
  **(You) okayed instead:** phones (under 700px) get a flat background in
  the event's base colour, with no glows and no grain, so it matches
  Safari's flat status-bar and toolbar strips exactly. The cover and the
  glass cards carry the colour. Desktop keeps the glowing mesh.
- **(You)** Invite notifications: still exactly two actions (Going,
  Can't Go; no Maybe, to discourage maybes), with icons. The title is the
  sender ("Adam Smith"), matching the communication-notification avatar.
  The body is "10/16 · 7p · Throw Eggs at Karl" (M/d · h+a/p · title, in
  the event's time zone, with middle dots). The server's push wording
  should match (iOS repo docs/push-payloads.md). Next: a Notification
  Content Extension with an app-styled card (cover, date, place, faces,
  Going / Can't Go).
- **(You)** Events stays one repo for now (the API and the web pages),
  but the line between them is enforced. test/boundary.test.js follows
  every local require() from the web entry points (routes/pages.js,
  lib/render.js, public/*.js) and fails if they reach anything but their
  own files and three small pure helpers (lib/people.js, lib/domain.js,
  lib/ids.js). Pages get data only from /api/v1 over HTTP. · A later
  split is moving folders, not untangling code. · Split when there's a
  second web client, a need to deploy separately, or more people.


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

### 3. Contact details encrypted at rest (account service, schema version 9)

- **Email is encrypted too**, with a keyed-hash column (`email_hash`,
  unique) that sign-in, "is this address taken" and uniqueness use. ·
  Names plus emails are the most useful thing in a leaked copy; the hash
  keeps every exact-match use working, and lets an email come back after
  a lost encryption key (its owner signs in by code). · Drop the email
  from `SEALED_COLUMNS`/`sealedContact` and look up by `email` again
  (a schema step to decrypt it).
- Venmo and Cash App are encrypted but have no hash. · Nothing looks them
  up. · n/a
- Format `v1:<keyId>:<nonce>:<ciphertext+tag>`, AES-256-GCM, random
  12-byte nonce, the value's **kind** (`email`, `phone`, ...) as GCM's
  additional data; not bound to the row id. · Stops a value being moved
  to another column and still opening; row binding would also break when
  a session's id changes at sign-in, and only matters to someone who can
  write to the database, which isn't the threat here. · `seal`/`open` in
  lib/contactCrypto.js.
- HMAC input is `<kind>:<cleaned value>`. · Phone and Instagram hashes of
  the same string can't collide. · n/a
- The session columns that hold an email for a few minutes
  (`code_email`, `verified_email`) and a waiting sign-up's details
  (`pending_profile`) are sealed too. · Otherwise a snapshot taken during
  a sign-up carries the address in plain text. · n/a
- `secure_delete` is always on, and the upgrade to 9 runs `VACUUM`
  afterwards (outside its transaction). · Without them the old plain text
  stays in free pages and is copied into every snapshot; the test that
  checks the raw file fails without them. · Remove the pragma and the
  VACUUM.
- Keys: `CONTACT_ENCRYPTION_KEYS` (`id:base64key`, comma-separated, first
  is current) and `LOOKUP_HMAC_KEY`. Unset in development: throwaway keys
  made and printed. Unset in production on an empty database: also
  throwaway keys, printed with a loud `!!!` warning, so the admin can
  still set up a fresh install; once anyone exists, production refuses to
  start without keys. Setting only one of the two always refuses. ·
  Mirrors `ADMIN_PASSWORD`, and stops a restart from silently losing
  everything. · `checkKeys` in lib/db.js.
- A value under a key id that isn't in the list makes production refuse
  to start, unless `CONTACT_KEYS_LOST=1` (a third env var, added for
  this). Then those values read as empty; nothing is deleted, so a found
  key brings them back. · Taking an old key out too soon should be loud,
  and a truly lost key shouldn't brick the service. · Drop the flag to
  make it always refuse, or always warn.
- Rotation runs at every startup when anything isn't under the first key,
  in one transaction; there's also `store.reseal()`. A changed
  `LOOKUP_HMAC_KEY` is noticed through a check value in `meta`
  (`lookup_key_check`) and every hash is rebuilt from decrypted values. ·
  No manual step to forget. · n/a
- An email that reads as empty (lost key) is re-sealed when its owner
  proves it by code (`addPasskeyProvingEmail` now takes the proven
  address); confirming from the profile answers `409 email_unreadable`
  and asks them to sign in by code instead. The phone's lookup hash is
  left as it was when the encryption key is lost, so people stay findable
  by the number they had even though their profile shows it empty. ·
  Recovering what can be recovered without destroying anything. · Clear
  the hashes in `checkKeys` when `CONTACT_KEYS_LOST=1`.
- Snapshots and Coolify backups from before version 9 are not touched;
  the startup log and README tell the admin to delete them. · Deleting
  backups automatically is the owner's call. · n/a

### 4. Self-serve account deletion (account service)

- "Delete my account" sits at the bottom of the web profile, behind the
  passkey check already used for changing an email (`/api/auth/reauth/*`,
  15 minutes) and typing **DELETE** (case doesn't matter), not the email.
  · DELETE is the same for everyone and quick to type on a phone; typing
  your email adds nothing the passkey hasn't already proven, and fails if
  the email can't be read after a lost key. · `deleteWordTyped` in
  views/profile.html.
- The server only requires the passkey check, not the typed word. · The
  passkey is the security boundary; the word only stops a slip, and
  anything that could send the request could send the word too. · Add a
  `confirm` body field in `deleteMe`.
- `DELETE /api/profile` (web) and `DELETE /api/native/v1/me` (apps) are
  one handler, and do exactly what the admin's delete does: passkeys,
  every session, setup links, photo; then the browser's cookie is
  cleared. · One code path, as with the rest of the native API. · n/a
- The admin is refused (`409 is_admin`) before the passkey check, and the
  profile shows them why instead of the button. · Deleting the admin
  would reopen first-run setup to whoever has the setup password. · n/a
- The deleted email is free straight away; signing up with it makes a
  new, unrelated account. · Nothing else is left to tie it to. · n/a
- **Open question for you: should events purge a deleted person's wall
  text?** Today events keeps everything under the id (RSVPs, wall posts,
  hosting) and shows the person as "Former member" with no photo, and the
  account README now says so. Their name and photo disappear everywhere,
  but what they *wrote* on a wall stays word for word, and it can name
  them ("it's Ana's birthday, I'm bringing cake"). Options: (a) keep it,
  as now: a deleted account isn't a request to rewrite other people's
  event history, and hosts can already delete any post; (b) blank the
  text of their posts the first time `/api/people` stops returning them
  (events would need to notice deletions, e.g. a periodic sweep of ids
  with posts, since nobody tells sites); (c) offer "delete my posts on
  events" as its own step before deleting the account. Not built. My
  lean is (c) if anyone asks, since only the person knows what they want
  gone, and (b) is the only one that works after the fact.

### 5. The lookup log (account service, schema version 10)

- Every lookup a site makes is logged in `lookup_log`, found or not and
  refused or not: asker id, site id, kind, a keyed hash of the cleaned
  target (the same HMAC as `phone_hash`/`instagram_hash`), matched,
  refusal reason, a keyed hash of the visitor's address, and the time. A
  request with no valid site key isn't logged. · Anyone on the internet
  could otherwise write rows; only our sites' lookups are lookups. ·
  Log it in `requireSite`'s 401 too.
- The visitor's address is stored as an HMAC (same key, kind `address`),
  not the IP. · Patterns only need "same address or not"; an IP is
  personal data that would sit in every backup. · Store
  `address` instead of `store.lookupHash('address', …)`.
- Kept **90 days**, pruned on the snapshots' daily timer (before each
  snapshot) and at startup. · Long enough to see a slow, weeks-long
  enumeration under the 100-a-day limit and to answer "how did they find
  me?" later; short enough that it isn't a long-term record of who looked
  for whom. · `LOOKUP_LOG_TTL_MS` in lib/db.js.
- Flags: **10 misses in a row**, or **20+ lookups in a day with 80%+
  missed**, or **any rate-limited lookup in a day**, per asker and per
  address. A flag is a `lookup alert` warning line (once a day per asker
  or address, in memory, so a restart can repeat one) and a "Look into
  this" tag in the admin's new **Lookups** tab (the last 7 days, askers
  with counts and miss rates, and only flagged addresses, by the first 12
  characters of their hash). Flags block nothing. · Hosts inviting people
  who aren't on Canopy will miss sometimes; ten in a row or a day of
  nothing but misses is someone guessing. · `LOOKUP_ALERT` in server.js.
- Refusals that come before the lookup limits (not allowed, signed out,
  unverified, one_of, rate_limited) are logged at most 30 an hour per
  asker (or per address when there's no asker) and 600 an hour overall;
  `bad_phone`/`bad_instagram` are already behind the lookup limits. ·
  Otherwise a signed-in user could fill the disk through a site. ·
  `lookupRefusalLog` in server.js.
- A deleted account's log entries stay under its id until they age out
  (shown as "Former member" in the tab). · It's security data, and it
  holds no contact details. · Delete them in `deleteMe`.
- The README says plainly that the hashes protect copies, not the live
  server: with `LOOKUP_HMAC_KEY`, phone numbers (and IPv4 addresses) are
  few enough to brute-force back. · Honest about what a keyed hash buys. ·
  n/a

## Calendar feed

Built on `feat/calendar` in both repos, not merged. The account service's
branch is based on `feat/data-security` (unmerged), so its schema step is
version 11 and it needs that branch merged first. Events needed no schema
change.

- **Account-to-site auth: an HMAC signature with a per-site calendar
  secret, not a bearer token.** `Authorization: Canopy-Calendar t=<unix
  seconds>, sig=<hex HMAC-SHA256(secret, "canopy-calendar-v1\n<personId>\n<t>")>`,
  five minutes either way. The secret is made in the account admin's Sites
  tab when a site is first given a Calendar URL, shown once, and set on the
  site as `CANOPY_CALENDAR_SECRET`; `canopy.verifyCalendarRequest(req)` in
  the client file checks it. · The account service can't present the
  site's own key (it only keeps the hash), so it needs its own secret per
  site either way. A plain bearer secret would be a few lines simpler, but
  every request would carry a credential good for every person's calendar
  forever: a logged header, a proxy, or a mistyped Calendar URL (the admin
  types it) would leak all of it. A signature leaks one person's calendar
  on one site for five minutes, for about a dozen more lines. No nonce or
  replay cache: a replay inside five minutes gets the same answer the
  account service already has. · To switch to a bearer token: send the
  secret as `Authorization: Bearer` in lib/calendar.js `authorization`,
  and compare it in constant time in `verifyCalendarRequest`.
- **The site calendar secret is stored sealed (CONTACT_ENCRYPTION_KEYS),
  not hashed.** · It has to be read back to sign with. Sealing keeps the
  data-security branch's promise that a copy of the database holds no
  working secret, and it rotates with the other sealed columns
  (`SEALED_COLUMNS`). A lost key leaves the site out of feeds until the
  admin makes a new calendar secret. · Derive it from a dedicated env key
  instead (then no column, but rotating that key breaks every site).
- **The person's feed secret is stored as its SHA-256 *and* sealed, not
  only as a hash (refined from the brief).** · Hash-only makes the link
  show-once: the next time someone opened their profile, "Copy link" would
  have nothing to copy, and every visit would need a reset. The hash is
  what a fetch is looked up by; the sealed copy is only for showing it
  again; a database copy alone gives neither. A lost key replaces the link
  the next time they open the Calendar section. · Drop the `secret` column
  and make the profile show the link once (Reset to see a new one).
- **`GET /api/profile/calendar` makes the link on first use.** · "Made when
  they first open the calendar section": the page asks on load. A GET with
  a first-time side effect is harmless here (no cross-site page can read
  the answer, and making a link exposes nothing). The apps get
  `GET /me/calendar` and `POST /me/calendar/reset`; the web
  `/api/profile/calendar` and `/reset`. · Split into a POST to create.
- **Last good answers are kept in memory, not on disk.** · They're where
  people will be, with home addresses; on disk they'd be in every snapshot
  and Coolify backup. The cost is a restart during a site outage. ·
  Persist `kept` (lib/calendar.js) to a table or file.
- **A 503 when there are sites to ask and none has ever answered for this
  person (refined from the brief's "leave that site out").** · With one
  site (events), "leave it out" after a restart during an events outage
  would serve an empty calendar, and calendar apps delete what's missing.
  A 503 with `Retry-After: 300` makes them keep what they had. With two
  or more sites, a site that's never answered is left out as the brief
  says, as long as another one answers. · Remove the `unavailable` branch
  in lib/calendar.js `entriesFor`.
- **An unverified person's feed only asks sites that allow unverified
  accounts.** · The same line `/api/session` draws: a site that treats
  them as signed out shouldn't be putting things in their calendar. Events
  allows them, so quick sign-ups get their events. · Drop the filter in
  `entriesFor`.
- **Times in UTC with Z; no VTIMEZONE.** The site still sends `timeZone`
  (unused for now). · The brief allows it, and it's the least that can go
  wrong; calendar apps show the right local time. · Write TZID times and
  VTIMEZONEs in lib/ics.js from `timeZone`.
- **No end time → an hour long in the feed.** Events sends `end: null`
  and the account service writes DTEND = start + 1 h. · With no DTEND the
  RFC makes a timed event zero-length, which apps draw as an unreadable
  sliver; an hour is what every calendar app gives a new event. Events'
  own "over" assumption is 6 h, which would block out a whole evening that
  the host never said. · `DEFAULT_LENGTH_MS` in lib/ics.js, or have events
  send its own guess.
- **DTSTAMP = LAST-MODIFIED = updatedAt; SEQUENCE = seconds since
  2020-01-01 of updatedAt; no METHOD.** · With no METHOD, the RFC defines
  DTSTAMP as the last revision, and it makes the text (and so the ETag)
  identical while nothing changes, so 304s actually happen. SEQUENCE must
  only grow and fit in 32 bits (until ~2088). · lib/ics.js.
- **"Cancelled: " in a cancelled entry's title, and `TRANSP:TRANSPARENT`;
  `TRANSP:OPAQUE` for tentative.** · Google ignores `STATUS:CANCELLED` in
  subscribed calendars and shows the event as on. · lib/ics.js
  `eventLines`.
- **Google Calendar link on the profile** (`calendar.google.com/calendar/r?cid=<webcal>`)
  next to Add to Calendar and Copy link. · Android has no webcal handler,
  and Google is most Android users' calendar. · Remove the link in
  views/profile.html.
- **Limits: 120 fetches/hour per feed, 1,200/hour per address, 60 unknown
  links/hour per address, no global ceiling.** · Apple can poll every 5
  minutes from each device; Google's fetchers share addresses across many
  users; a global ceiling tripping would freeze everyone's calendar. ·
  `feedLimits` in the account service's server.js.
- **Events: invited-only is left out of the calendar.** · Not in the
  brief's list. An invitation isn't a plan, and the app's Invites tab is
  where it's answered; showing every invitation as tentative would fill
  calendars with things people never agreed to. · Add `rsvp === 'invited'`
  as tentative in lib/rules.js `calendarStatus` (and to the store query).
- **Events: the window is by start time (`starts_at >= now - 90 days`),
  and "cancelled kept until 30 days after the start" also by start.** ·
  The brief's wording; events' `over_at` would only differ for very long
  events. · lib/store/calendar.js and `CALENDAR_CANCELLED_KEPT_MS`.
- **Events: the UID is `events.id` (`<id>@events.canopysf.com`), the URL
  `public_id`.** Checked: `events.id` is set at creation and never
  updated anywhere (every table and the cover files point at it);
  "new link" only changes `public_id` (lib/db.js version 6,
  store.setEventLink). The domain comes from `CANOPY_DOMAIN`, not
  `PUBLIC_URL`, so a local or changed public URL can't change UIDs. ·
  routes/calendar.js `entryFor`.
- **Events: what an entry says.** The title; the place's name and address
  joined with ", " as LOCATION; a description of their part ("You're
  hosting.", "You're going (plus 1 guest).", "You said maybe.", "On the
  waitlist.", "This event was cancelled."), the host's description, and
  the link (Google doesn't show the URL property). No host names (they'd
  need the account service, and the brief says no guest names; hosts are
  people too). `updatedAt` = the latest of the event's `updated_at`, when
  they were made a host, and their answer's `status_at`/`responded_at`,
  so maybe → going updates the entry. · routes/calendar.js.
- **Events: `GET /api/calendar/:personId` is outside `/api/v1`, mounted
  before the account attach.** · It isn't the apps' API; under `/api/v1`
  the `Authorization` header would be read as a person's token. It's in
  openapi.yaml under a "Site to site" tag with its own `canopyCalendar`
  security scheme, and the spec test now includes it. A person id that
  isn't a UUID is `400 bad_person_id`; an unknown one is `{entries: []}`.
  · routes/calendar.js and server.js.
- **Events' `lib/canopy-account.js` got only the calendar hunk, not the
  whole data-security client.** · The README says "copy it unchanged",
  but events' main still talks to the deployed account service, whose
  lookup is a GET; copying the data-security client (lookup as a POST)
  would break lookups until that branch deploys. The calendar hunk is
  byte-for-byte the account service's (checked with a diff). · After
  both branches merge, copy `client/canopy-account.js` over it again.
- **Missing `CANOPY_CALENDAR_SECRET` on events is a warning, not a
  startup failure.** · The calendar is optional; every request is then a
  401, and the account service serves events' last good answers (or
  leaves it out). · server.js.
- **Test-only knobs `CALENDAR_FRESH_MS` and `CALENDAR_TIMEOUT_MS`** (read
  only with `NODE_ENV=test`) so the account tests can exercise staleness
  and timeouts in under a second. · server.js.
- **`ical.js` as the strict parser (dev dependency), plus
  `test/icsCheck.js`** for what it doesn't enforce (CRLF, 75 octets,
  escaping, required properties once, UTC). · Swap for another parser in
  test/icsCheck.js.
- **Merged and deployed (2026-10-08):** data security and the
  calendar feed. Account cf3c32c went first, after you set
  `CONTACT_ENCRYPTION_KEYS` and `LOOKUP_HMAC_KEY` in Coolify; it started
  with them, so the contact fields are encrypted at rest. Events 63d161f
  went second, with the client file synced from the account service.
  Remaining for you: in the Sites tab, untick events' contact fields, set
  its Calendar URL, and put the secret it shows in events'
  `CANOPY_CALENDAR_SECRET`.
- **Fix:** the editor couldn't set a start time in desktop Safari. The
  date and time fields were see-through pickers under the big words,
  opened with showPicker(), but desktop Safari's time and date-time
  fields have no pop-up (you type into them), so nothing opened and
  nothing could be typed. With a mouse or trackpad, the real fields now
  show in place of the words, at the page's size with the dashed
  underline, and showPicker() is gone (in Chrome its pop-up also
  swallowed typing). Phones keep the words over the system wheel. ·
  Desktop shows the browser's date format (10/20/2026) while editing.

## Explicit friends (in progress, feat/friends)

- **(You)** Friends can be added by a personal friend link or QR, by
  phone or Instagram lookup, and by inviting or being invited, on top
  of shared events. **One-way, like following**: your friends are the
  people in your list.
- Assumed: accepting someone's friend link is mutual (sharing your link
  is consent). It's a confirm page, so a GET never adds anyone. An
  invite adds both ways. You can remove anyone, including shared-event
  friends (hidden), and nobody is notified of adds or removals. Your
  list is only shown to you. Adding by lookup needs a verified email,
  like lookup itself.
- **(You)** Calendar feed: events you're invited to show as
  "[INVITED] <title>" (tentative) when an option is on, which it is by
  default. Answering updates the same entry: going → confirmed with the
  plain title; maybe → tentative; can't go, uninvited or removed →
  dropped. The setting is stored in events (`calendarInvites`), toggled
  from a Calendar card on the events home page and in the app's
  Profile. Queued after explicit friends, so the two schema steps don't
  collide.
## Explicit friends

On `feat/friends`. **(You)** decided the ways in (a friend link / QR
code, finding by phone or Instagram, inviting or being invited, plus
events together) and that it's one way, like following. The rest:

- **Schema version 10: `friend_edges` (person_id, friend_id, source:
  `link` | `lookup` | `invite` | `invited_by`, created_at; the pair is the
  key, no self-edges), `hidden_friends` (person_id, friend_id, hidden_at)
  and `friend_links` (person_id, code, created_at; code unique).** Your
  list = (events together ∪ your edges) − your hidden. · As designed. ·
  A new step that drops the three tables.
- **Taking anyone out deletes your edge *and* hides them (refined from
  the brief's "removing an explicit edge deletes it").** · With a delete
  alone, someone you took out would come back the next time you were at
  an event together, or the next time they invited you, which is the
  opposite of what taking them out meant. Only your own adding brings
  them back: by id, saying yes to their link, or inviting them. Someone
  else's doing (they invite you, they say yes to your link) adds their
  edge but doesn't undo your hiding. · `removeFriend` in
  lib/store/friends.js without the `hide`, for explicit-only friends.
- **The friend link's code is 12 random base62 characters (71 bits, like
  an event id), stored as it is, not hashed.** · It has to be shown again
  every time the friends page opens, and events has no sealing key like
  the account service's calendar secret. What the code grants is small:
  saying yes puts the owner in your list and you in theirs, nothing
  about them beyond the name and photo a guest list already shows.
  Anyone with a copy of the database has far more than this anyway. ·
  Store `sha256(code)` and show the link once (Reset to see a new one).
- **`GET /api/v1/me/friend-link` makes the link on first use**, as the
  calendar link does. · The friends page asks on load. · Split into a POST.
- **Saying yes to a link is both ways; the owner's hiding the opener
  stays.** · The brief: sharing your link is consent. But the owner may
  have taken that person out since, and an old link in their hands
  shouldn't undo it. · `addLinkFriends`'s second `addEdge` with `true`.
- **Your own link: 409 `own_link`** (not a no-op). · An app can say "this
  is your link" rather than show a success that did nothing. · Return
  the owner instead.
- **`GET /api/v1/friend-links/{code}` is open to anyone with the link,
  signed in or not, and gives the owner's `Person` plus `viewer: {isYou,
  isFriend}` (null signed out).** · The signed-out page shows who you'd
  be adding; `viewer` lets a page or app say "that's you" or "already
  friends" without a second call. It only ever says something about the
  caller's own list. · Drop `viewer`.
- **Adding by id: 200 `{friend}` whether new or not; 404
  `person_not_found` for an id the account service doesn't know; 409
  `is_you`; verified only, checked before asking the account service.** ·
  The same verified-only line as the lookup. Any id works, not only one a
  lookup returned: ids are already on every guest list, and adding one
  grants nothing new (no notification, nothing they see). · n/a
- **`DELETE /api/v1/me/friends/{id}` for someone not in your list is 404
  `not_a_friend`**, not a silent hide. · Otherwise it'd be a way to
  pre-emptively block someone, which isn't a feature anyone asked for. ·
  Insert the hide anyway.
- **Limits: adding friends (by id, or saying yes to a link) is 200 a
  person, 500 an address, 5,000 overall a day; every try counts, found
  or not. Friend links that find nobody: 60 an hour an address.** · The
  brief's "per day and per address". Counting misses too keeps adding by
  id from being a way to test ids in bulk. The account service's own
  lookup limits still apply before anyone gets an id. · `addLimits` and
  `linkMisses` in routes/friends.js.
- **Invitations add both edges for `invited` and `already_on_list`
  outcomes, not `is_host` or `removed`.** · Someone already on the list
  (they answered from the link) was still picked by the host. A host or a
  removed guest wasn't invited. The host's own hiding is undone (they
  chose the person); the guest's isn't. · `invite` in lib/store/rsvps.js.
- **`source` per friend: an edge's way in wins over `shared_events`**
  (`lookup` → `added`, `link` → `link`, `invite`/`invited_by` → `invite`).
  The first way in is kept; adding again changes nothing. ·
  `eventsInCommon` still says the events, so nothing is lost; the way in
  is the more deliberate fact. `invite` either way, so the list never
  says who invited whom. · `SOURCES` in routes/friends.js.
- **Order: most events in common first, then the people you only added
  (0 in common), by id; cursor unchanged.** · The list's shape and cursor
  stay as they were. Newest-added first would need a three-part cursor.
  · Change the ORDER BY and the cursor key.
- **`eventsInCommon` can be 0 and `lastTogetherAt` null now.** · There's
  no honest date for "last together" with someone you only added; a
  made-up one (when they were added) would be a lie the API keeps
  forever. **The iOS app's `Friend.lastTogetherAt` is a non-optional
  `Date`: it needs to become `Date?`, or decoding a list with an added
  friend fails.** · Send `addedAt` as `lastTogetherAt` instead.
- **"Friends going" and the invite picker use the whole list** (added,
  link and invite friends included; hidden ones not). · One meaning of
  "your friends" everywhere. · `friendsGoing` in lib/store/friends.js
  back to `together`.
- **No notifications.** Nobody hears they were added; the inbox types
  are unchanged. · The brief; and one-way adding is meant to be quiet. ·
  A `friend_added` type in lib/notify.js.
- **The friends routes moved from routes/me.js to a new
  routes/friends.js, and the spec has a Friends tag.** · One subject, one
  file, as the README says. · n/a
- **`auth.returnTo` knows `:code`**: a signed-out accept's 401 sends
  people back to `/f/<code>`, not the home page. · lib/auth.js.
- **The QR code is drawn on the server as an inline SVG (`lib/qr.js`)
  with `qrcode-generator` 2.0.4** (Kazuhiko Arase's, MIT, no
  dependencies) for the encoding and our own drawing (one path, a run per
  row, black on a white tile with the standard 4-module quiet zone,
  correction level M). The production link is version 3, 29 modules. ·
  The `qrcode` package pulls in a CLI's worth of dependencies; this one
  has none. Drawing it ourselves makes the SVG about a tenth the size of
  the library's own. **Checked by decoding:** test/qr.test.js renders the
  SVG to pixels with sharp and reads it back with `jsqr` (a dev
  dependency, an independent decoder) at two sizes for three links, and
  checks version 3 and the quiet zone; test/friend-pages.test.js decodes
  the one on the friends page the same way. A deliberately broken code
  doesn't decode (checked by hand). · Swap the encoder in lib/qr.js.
- **lib/qr.js is allowed on the web side of the boundary test.** · It's
  pure (text in, SVG out) and draws a link the API gave; the apps make
  their own QR codes (docs/api.md says how). · Return a `qrSvg` from
  `GET /me/friend-link` instead.
- **Reset reloads the friends page** rather than redrawing the QR code in
  the browser. · The encoder is server side only; a reset is rare. ·
  Ship the encoder to the page.
- **/f/<code>: link previews get "Add Ana on Canopy" and "Ana's friend
  link on Canopy Events.", the first name only, no photo, no image tag.**
  The page itself shows the full name and photo (initials signed out,
  since photos need a Canopy session). · Previews are fetched and kept by
  machines, and a link pasted somewhere public shouldn't carry a face
  and a full name. · `friendLinkMeta` in lib/render.js.
- **/f/<code> signed in: one confirm card; already friends and your own
  link say so instead of offering the button; after yes, the friends
  page.** A wrong or reset code is a 404 page. · As designed. ·
  views/friend-link.html, `UI.friendLinkPage`.
- **Friends page lookup**: the invite page's lookup UI (`lookupSection`
  now takes a copy prefix), with "Add friend" or a "Friend" tag; a found
  person is put at the top of the list. Finding yourself shows nothing.
  · Reuse. · `UI.friendFound`, views/friends.html.
- **Removing asks first ("They won't be told, and they won't come back
  unless you add them").** · It sticks (hidden), so the confirm says so.
  · `friends.removeConfirm` in public/copy.js.
- **A friend's line says how they're in your list ("Added", "Friend
  link", "Invitation") and then events together;** the invite and
  co-host pickers use the same line, so a friend with 0 events in common
  doesn't read "0 events together". · `UI.friendSub`.
- **Visual check** at 375 px and desktop against the fake account
  service: the friends page (QR, link, Share/Copy, Reset, lookup →
  "Add friend" → top of the list, Remove), and /f/<code> signed in
  (confirm → friends page) and signed out.
- **(You) Reversed "buttons and links stay Canopy green":** on event
  pages (and the editor's live preview) the accent follows the event's
  colour: the photo ring, the "how soon" pill, icons, links and the main
  button. Canopy green's three accent colours are turned to the event's
  hue with their lightness kept (greyscale → neutral grey). Checked at
  every hue and grey: dark text on the accent ≥ 6.8:1, links on the base
  ≥ 14.5:1, accent vs base ≥ 7:1. Other pages stay green. · public/ui.js
  themeStyle. The iOS app should match (accent from the same turn).

## Calendar: invitations

On `feat/calendar-invites`. **(You)** decided invitations go in the feed
as `[INVITED] <title>`, tentative, behind a setting that's on by default,
and that answering updates the same entry. The rest:

- **Schema version 11: `person_settings` (person_id, calendar_invites 0/1
  default 1, updated_at), one row only once someone changes a setting.**
  No row is every default, so everyone already here has invitations on
  without a backfill. · The brief's "a `person_settings` table"; nothing
  existing was per person and right for it (`verified_people` and
  `hosted_people` are facts, not choices). · A step that drops the table.
- **`GET /api/v1/me/settings` answers `{calendarInvites}` flat, and
  `PATCH` takes only the settings to change**: an unknown name is 400
  `unknown_setting`, a non-boolean 400 `bad_calendar_invites`, a body
  that isn't an object 400 `bad_settings`; nothing changes on a 400. `{}`
  changes nothing. Quick (unverified) accounts have settings too. · The
  brief's shape; strict so a typo in an app doesn't silently do nothing.
  · routes/me.js.
- **An invitation's entry: title `[INVITED] <title>`; status `tentative`;
  description "You're invited. Answer here: <link>", then the host's
  description, without the link again at the end** (every other entry
  ends with it; here it's already in the first line). Hosts are never
  "only invited" (hosting wins). · As asked. · `INVITED_PREFIX`,
  `partLine` in routes/calendar.js.
- **`updatedAt` now includes `invited_at`**, on top of the event's
  `updated_at`, being made a host, and `status_at`/`responded_at`. Every
  transition the brief lists moves it: invited → going or maybe changes
  the status (so `status_at`); taking an answer back to invited sets
  `status_at` too; can't go, uninvited and removed take the entry out.
  The test checks it grows at each step. · So the account service's
  SEQUENCE and LAST-MODIFIED move and calendar apps redraw it. · n/a
- **A cancelled invitation keeps its `[INVITED]` title** (the account
  service adds "Cancelled: " in front) and, like the others, stays as
  cancelled for 30 days, only while the setting is on. · It was never
  answered; the title says what it was. · `title` in `entryFor`.
- **Turning the setting off takes invitations out at once, cancelled ones
  included; turning it on puts them back** (with their old `updatedAt`,
  which is fine: to a calendar app they're new again). Answered events
  are untouched by it. · n/a
- **Home page Calendar card: one line, "Add to your calendar" (a link to
  `<CANOPY_ACCOUNT_URL>/profile#calendarCard`, the account profile's
  calendar card's id, checked read-only in canopy-account-service's
  views/profile.html), and an iOS-style switch "Show events I'm invited
  to"** that PATCHes the setting and flips back if it doesn't save. Below
  the lists, signed in only. · As asked; the feed's link itself lives on
  the account service, so the card sends people there rather than
  copying it. · `UI.calendarCard`, views/home.html.
- **Visual check** at 375 px against the fake account service: the card,
  and the switch turning the setting off (the API agreed).
- **(You)** When an event's colour is greyscale (and only then), the
  host can pick the accent separately: buttons, pill, icons, links. It's
  a second "Accent" slider (grey → hue wheel) that appears only in the
  grey stretch. API `accentHue` (0–359 or null = grey accents) is refused
  unless themeGrayscale is on, and cleared when an event leaves
  greyscale. Queued after friends and calendar invitations (schema
  order).
- **(You)** Refinement: the accent is never grey. A greyscale event's
  accent is **white** (the default, `accentHue: null`) or a hue, so a
  black-and-white event's buttons don't look disabled. The Accent slider
  runs from white through the hue wheel. Existing grey events switch from
  today's grey accent to white.

## Accent for grey events

On `feat/grey-accent`. **(You)** decided a grey event's host picks the
accent, and (the refinement) that it's never grey: white or a hue. The
rest:

- **Schema version 12: `events.accent_hue`, 0-359 or NULL (white), with
  a CHECK that it's NULL unless `theme_grayscale = 1`.** · The database
  holds the "only for grey" rule too, so no path can leave a coloured
  event with an accent. · A step that rebuilds events without it (SQLite
  can't drop a column with a CHECK in place).
- **API: `accentHue` on every event (and every `EventSummary` in
  notifications), signed out too; null on any event that isn't grey.** A
  non-null value with `themeGrayscale` false (as it is, or as this change
  makes it) is 400 `accent_needs_grayscale`; anything but null or a whole
  0-359 is 400 `bad_accent_hue`; `themeGrayscale: false` clears it in the
  same write; `null` is accepted anywhere. · As asked; null is harmless
  everywhere, which keeps the editor's Save simple. · lib/eventInput.js.
- **Existing grey events are white now, not grey** (`accentHue` null on
  every one of them). · The refinement says so; grey buttons look
  disabled. · `accentColors` in public/ui.js.
- **White's colours: accent `#ffffff`; text and icons on it the grey
  page's base `#0e0e0e` (19.3:1); links `#ffffff` (19.3:1 on the base,
  17.6:1 on a card), set apart from white body text by weight 700 and a
  2px underline** (`--link-weight`, `--link-underline`, set by
  `themeStyle` only then; events.css reads them on `a`). The pill and the
  primary buttons are white with dark text, the photo ring white. · The
  page's own base rather than black so the dark matches the page. · Plain
  black (`#000000`) as `--on-accent`.
- **A hue accent on grey is the same trio a page in that hue has
  (`turnHex` of `#2ec44f`/`#03190a`/`#b6f5c3`).** Re-run over the whole
  wheel against the grey background: dark text on the accent ≥ 6.8:1,
  links on the grey base ≥ 14.5:1 (≥ 13.2:1 on a card), the accent
  against the base ≥ 7.0:1. test/accent.test.js checks these floors, and
  that no hue accent comes out grey. · n/a
- **One function for both sides: `themeStyle(key, accent)`**, the
  accent key from `accentKeyOf(event)` (null for a coloured event, WHITE
  or a hue for grey); `render.page` takes `accent` next to `theme`. The
  browser bar (`theme-color`) stays the grey base. · n/a
- **Editor: an "Accent" slider under Colour, shown only while Colour is
  in its grey stretch; its first 30 steps are white (its track starts
  white), then the wheel, like the colour slider.** Live preview of
  buttons, pill and ring as it moves. Leaving grey hides it and Save
  sends `accentHue: null`; "Match photo" moves only the colour. No help
  text. · As asked. · views/editor.html, `UI.accentField`.
- **Fixed on the way: "Match photo" showed with no photo to match.** The
  button's `hidden` was beaten by `button{display:block}`; `.hue-row
  [hidden]` (and `.field[hidden]`) are `display:none` now. · events.css.
- **docs/api.md's "Event colours" said buttons and links stay Canopy
  green at every hue**, which hasn't been true since the accent started
  following the event's colour; it now says how the app derives every
  accent (coloured, white, hue-on-grey). · n/a
- **Tests:** the API rules and the CHECK (test/accent.test.js), the page's
  CSS variables for a grey page with a hue and with white and its
  `theme-color` staying grey, the editor's slider shown for grey and
  hidden otherwise (as the server draws it), the contrast floors, the
  version 12 step (test/db.test.js); the spec and leak walker run on every
  answer. Showing and hiding as the slider moves, and Save sending null,
  were checked by hand in the browser (375 px): grey → accent 330 → Save
  stored `accentHue: 330` and drew a purple pill and button on grey;
  moving Colour to a hue hid the Accent slider and Save stored null.

## Event details (custom fields)

On `feat/details`. **(You)** asked for optional extra fields like
Partiful's chips (link, info, dress code, food, parking, accommodation,
phone), with parking, accommodation and phone kept from signed-out
viewers like the address. The rest:

- **Schema version 13: one JSON column, `events.details` (NULL is none),
  with a `json_valid` CHECK, not an `event_details` table.** · The list
  is small (10 at most), always read with its event (every list already
  loads whole rows), only ever replaced whole, and nothing queries across
  events by it; a table would add a join or a second query to every list
  for nothing. · A step that rebuilds events without it, plus a table if
  a query ever needs one.
- **API: `details: [{type, label, value, href}]` on every event, and
  `hiddenDetails`, a count (0 when nothing's held back), next to
  `locationAddressHidden`.** `href` is derived, never stored: a link's
  address, or `tel:` with a phone's digits (and its leading +); null for
  text. A count rather than a flag so the page or an app could say "2
  more"; the web only says "More details show once you sign in." · The
  brief's "count or flag". · lib/views.js.
- **Hidden exactly where the address is**: `insider` in lib/views.js
  (signed in and not removed). Removed guests get the public ones and no
  sign-in line (signing in wouldn't help them), as with the address. ·
  As asked; one rule. · `PRIVATE_TYPES` in lib/details.js.
- **Refusals carry `index`** (`{error, reason, index}`; the Error schema
  gained an optional `index`): `bad_details`, `too_many_details`, and with
  the index `bad_detail`, `bad_detail_type`, `bad_detail_label`,
  `bad_detail_value`, `bad_detail_url`, `bad_detail_phone`,
  `detail_too_long`. Nothing changes on a 400. · As asked, plus the ones a
  real body can hit. · lib/details.js `cleanDetails`.
- **Too long is refused, not cut**, unlike the description and title,
  which are silently trimmed. · A cut URL or phone number is broken, and
  the brief names `detail_too_long`. The editor's `maxlength`s mean a
  person never sees it. · Slice instead.
- **Links: http and https only; one typed with no scheme that starts like
  a host ("partiful.com/e/x", "www.example.com") gets `https://`;
  normalized with `new URL().href`; refused with a user name or password
  in it (`https://bank.example@evil.example` reads as one place and goes
  to another) or a host with no dot.** · People paste addresses without
  the scheme; nothing else should ever become an href. · `cleanUrl`.
- **Phone: digits with spaces, dashes, dots, brackets, slashes and a
  leading +, 3 to 20 digits, kept as typed (trimmed). No extensions.** ·
  "Loose"; `tel:` can dial it. · `PHONE_RE`.
- **A label is one line (whitespace collapsed), 60 characters; an empty
  one is null. Unknown fields on a detail are ignored**, like unknown
  fields on an event. · n/a
- **Event page: the details go after the hosts and spots, before the
  description**, one row each in the place row's style (icon in the
  accent, heading bold, value under it in the secondary size). · Short
  facts read best before the long prose, and that's where Partiful puts
  them. · `detailsBlock` in public/ui.js.
- **A link row is the link itself** (its label, or the host without
  "www."), with the host under it when it has a label, so a guest sees
  where it goes; no "Link" heading. A phone row is its label (or "Phone")
  over a `tel:` link. Text keeps line breaks (`pre-line`) and is escaped;
  links in text aren't made clickable, as in the description. The page
  re-checks every href (http(s), or `tel:` and digits) before drawing it
  as one. · Defence in depth. · `detailRow`.
- **Icons are inline SVGs on the place pin's 24×24 grid, filled where the
  shape allows (shirt, info, parking, bed, phone) and a 2px line for the
  link and the fork and knife.** · n/a · `DETAIL_ICON`.
- **Editor: rows above the chips, both under the description, inside the
  card.** A row is the icon, a heading input (its placeholder is the
  type's own heading, so leaving it empty reads as that; for a link it's
  the link text) and the value (a one-line input with `inputmode="url"`
  or `"tel"` for link and phone, a two-line textarea for the rest), and a
  × . A new row's value gets focus. Chips scroll sideways under 700px and
  wrap above; at 10 rows they're disabled. A row left completely empty
  isn't sent. · As asked; the URL field is `type="text"` with
  `inputmode="url"` so the page's input styles apply and the browser
  doesn't refuse "partiful.com/x" before the API can tidy it. ·
  views/editor.html, `detailEditRow`.
- **No privacy note in the placeholders** for parking, stay and phone
  (the address's says "only signed-in guests see it"). · "No help text",
  and it wouldn't fit a one-line field at 375px. · copy.js
  `editor.detailPlaceholders`.
- **Calendar feed: after the host's description, one line per detail,
  "Heading: value"** (the label or the type's heading; a multi-line value
  starts on the next line), all types: everyone with an entry is on the
  event. · As asked. · `detailLines` in routes/calendar.js.
- **Not in link previews**, and nothing else (wall, notifications) says
  details changed. · Previews never carry the description either; a
  details edit isn't news. · n/a
- **Leak walker**: a host-typed phone lives under `value`, not a contact
  field name, so the walker only flags it if it's someone's account
  number; the tests use a made-up number, and the walker's own test shows
  an account number in any detail is caught. · n/a
- **Tests**: test/details.test.js (cleaning, the round trip, replacing
  and clearing, refusals with the index and nothing changed, a
  `javascript:` link refused on create and edit, who sees what signed
  out, removed, restored, unverified, by app; the calendar text; the page
  rows, hrefs, escaping, the hint, nothing in the preview; the editor's
  chips and rows); test/db.test.js (version 13 and its CHECK);
  test/leaks.test.js (every kind of detail on the event every caller
  walks). Checked by hand in the browser at 375 px and 1024 px: the page
  signed in and out, adding a link row, a `javascript:` value refused
  under its row with focus on it, then fixed, a row removed, and Save
  storing the new list.
- **(You)** Phone and link are one line each, no heading: a link is
  its text, or with none its address shortened (no scheme, `www.` or
  last slash; cut at 48 characters with "…", and CSS ellipsizes what
  doesn't fit; the whole address in `title`); a phone is the number as a
  `tel:` link, with "label · " in front when it has one.
- **A phone's label is kept in the API and on the page, but the web
  editor no longer asks for one**: the row is the number alone, one line
  like the page; a label an app set rides along on the row
  (`data-label`) and is sent back unchanged. · The owner's example has
  none, and it keeps the row one line; dropping it from the API would
  break nothing today but take away "Venue" vs "Ana's cell" for no gain.
  · `detailEditRow`.
- **The editor's link row is the address first, then the link text,
  whose placeholder is what the page will show without one** (the
  shortened address, updated as it's typed; "Link text" before there is
  one). That's the editor's preview of the one-line link. · n/a ·
  views/editor.html.
- **The other types keep their heading-and-text layout, short or not.**
  · "Dress code" over "Black tie" reads at a glance, and one rule is
  simpler for the apps than a length cutoff. · n/a
- **Detail inputs carry no `autocomplete` or `name` of their own** (the
  editor's `noAutofill()` from main covers every field, rows added later
  included); `inputmode` sets the keyboard. · The orchestrator's note. ·
  n/a

## Guest menu (queued after event details)

- **(You)** Guests get a ⋯ menu on the event page with: Mute event,
  Remove me from event, Opt out of all invites from this host.
- Assumed: mute stops wall posts, RSVP chatter and co-host news, but
  keeps the essentials (cancelled, time or place changed). Leaving
  deletes your row, invitation and notifications, and frees your spot
  for the waitlist. The link still works for you as a fresh visitor, so
  it's a deliberate exit, not the withdrawn "take back my answer".
  Opt-out silently skips that host's future invites; the host only sees
  a generic "couldn't invite", never why. Undo from the friends page
  (and the app's Profile).

## No taking answers back

- **An answer can change but is never withdrawn.** The owner's call,
  like Partiful: once you've answered you can switch between going,
  maybe and can't go, but there's no going back to no answer (or to
  `invited`). "Can't Go" is how you leave: you stay on the list as
  `not_going` (counted in `counts.notGoing`), your spot goes to the
  waitlist through the same `setAnswer` path as any change, your "going"
  leaves the wall, and the event drops out of your calendar. · As
  asked. · routes/rsvps.js, lib/store/rsvps.js.
- **Removed:** `DELETE /api/v1/events/{id}/rsvp` and `withdrawAnswer`
  (with its `backToInvited` statement; `remove` stays for uninviting),
  openapi.yaml's `withdrawRsvp`, the "Take back my answer" button
  (`event.withdraw` in public/copy.js, its markup in public/ui.js, its
  handler in views/event.html; `answer()` there now always PUTs), and
  the CSS that left room for it under the answer buttons. Earlier
  entries in this log that mention withdrawing describe how it was. ·
  n/a
- **A DELETE to that path is 404 `not_found`**, JSON with a reason, from
  the API's catch-all for unknown routes, not a 405. · Nothing else in
  the API answers 405 for a known path with the wrong method; one
  special case would be the only one. · server.js.
- **What stays:** a host can still take back an invitation nobody has
  answered (`DELETE .../invites/{personId}`, 409 `already_responded`
  once answered), and remove a guest. Removing someone and then undoing
  it still leaves them `invited` with no answer: that's the host's
  doing, not a way for a guest to take an answer back. A host inviting
  someone who already answered marks them invited and keeps the answer.
- **Inbox guard test:** test/inbox-links.test.js used withdraw as the
  one way a guest leaves the list while keeping their notifications.
  No route does that now (removing and uninviting clear the inbox), so
  the test checks that a can't-go guest still sees the event, then
  deletes the row behind the API's back to keep the "no event for
  people off the list" guard covered. · n/a
- **The queued guest menu's "Remove me from event"** (see "Guest menu"
  above) is a separate, deliberate exit, not this: it isn't built, and
  until it is, a guest who has answered stays on the list. · n/a
- **Still to do elsewhere:** the iOS app's mock still has a withdraw
  repository method to remove (`withdrawRSVP` in
  EventsRepository.swift and MockEventsRepository+Guests.swift, and the
  comment in MockEventRecord.swift), and its ARCHITECTURE.md mentions
  withdrawing. · n/a
- **Tests:** the DELETE route answers 404 for someone with an answer and
  someone without, a removed guest included; nothing a guest can do
  (PUT `invited`, a host inviting again, a host uninviting) gets an
  answered guest back to invited or no answer; tests that withdrew to
  free a spot (capacity, wall, calendar) now say can't go and check the
  person stays on as `not_going`; the concurrency test has everyone
  going say can't go at once; the store-level rollback test uses
  `setAnswer(..., 'not_going')`; the event page has no withdraw button.
- **(You)** No autofill on any event-editor field (contacts, addresses,
  emails, passwords). The form and every field get `autocomplete="off"`
  plus the password managers' opt-outs (1Password, LastPass, Bitwarden,
  Dashlane), applied by script to fields added later too. · Browsers
  treat `off` as a hint (Chrome ignores it for fields it takes for
  addresses, Safari guesses from labels), so it's best-effort. · The
  iOS editor should match (no textContentType on its fields).

## Guest menu: mute, leave, opt out

On `feat/guest-menu`, after event details, on top of "No taking answers
back". **(You)** asked for a ⋯ menu for guests with Mute, Remove me and
Opt out of a host's invites (see "Guest menu (queued after event
details)" above for the assumptions it started from). The rest:

- **Schema version 14: `event_mutes` (event_id → events ON DELETE
  CASCADE, person_id) and `invite_optouts` (person_id, host_id, CHECK
  they differ).** · One row per choice; no row is the default. · A step
  that drops both.
- **Who gets the menu: anyone with a row on the event (invited or any
  answer) who isn't hosting and wasn't removed.** Someone who only opened
  the link has nothing to mute or leave. The API says the same: 409
  `is_host`, `not_on_event`, `removed` for mute and leave. · As asked. ·
  `guestRefusal` in routes/guestMenu.js.
- **Mute skips `wall_post`, `rsvp` and `cohost_added`; it keeps
  `event_changed` (time or place), `event_cancelled`,
  `event_uncancelled`, and also `waitlist_promoted` and `invited`.** The
  last two weren't in the brief's list either way: a spot opening up and
  being invited are about you, not chatter. · `MUTED_TYPES` in
  lib/notify.js, filtered in `notify()` itself so no trigger can forget.
- **A host is never muted.** Today `rsvp` only goes to hosts and
  `cohost_added` only to the person being made one, so for a muted guest
  the brief's "other guests' RSVPs and co-host additions" would only ever
  bite when they become a host; a co-host silently not hearing they'd
  been made one, or not hearing answers to an event they host, would be
  wrong. So the filter ignores a mute row whose person hosts the event
  (and `viewer.muted` is false for a host); stepping down brings the mute
  back. Both types stay in MUTED_TYPES for any future fan-out to guests.
  · `mutedOn` in lib/store/optouts.js.
- **Mute and unmute answer `{event}`; unmute is fine for anyone, muted or
  not; mute twice is fine.** Nothing on the guest list shows it. · n/a
- **Leave is `POST .../leave`, answering `{event}` as a fresh visitor sees
  it.** In one transaction: the row deleted (invitation or answer), their
  notifications about the event deleted, the mute deleted, their
  "going"/"off the waitlist" wall entry deleted, then the waitlist
  promoted (the same `waitlist.promote` can't-go uses). Their own posts
  stay (they were there and said it; removal hides posts, leaving isn't
  removal). Friend edges made by an invitation stay (one way, and taking
  them back would be a second, unasked-for effect). Nobody is notified
  except whoever gets the spot. · As asked. · `leaveEvent` in
  lib/store/rsvps.js.
- **The web asks first** with `confirm()` (as cancelling and removing
  do), then fetches the page's data again: they now see it as anyone
  opening the link, with going / maybe / can't go. · n/a
- **Opt-outs: one menu item per host of the event** ("Opt out of invites
  from Ana", "... from Cy"), creator first, by first name (short name
  when two hosts share one; a former member isn't offered). · A co-host
  can invite too, so opting out of only the creator would leave the
  co-host's invitations getting through; events have few co-hosts, so the
  menu stays short. · `guestMenu` in public/ui.js.
- **The vague outcome is `not_found`**, the one the invite answer already
  uses for an id with no account, not a new `not_invitable`: a reason
  used only for opt-outs would say exactly what it's meant to hide. If the
  opted-out person is already on that event (or hosting it, or removed
  from it), they get the reason anyone would (`already_on_list`, ...),
  so the answer never stands out, and nothing about their row changes
  (no `invited` mark, no friendship). · As asked, refined. ·
  routes/rsvps.js.
- **Opting out is allowed for anyone with an account, not only someone
  who hosts something of yours**; 404 `person_not_found` otherwise, 409
  `is_you` for yourself. PUT and DELETE are idempotent (Undo after
  another tab already undid it just works). · The app's Profile may want
  it outside an event. · routes/guestMenu.js.
- **`GET /me/invite-optouts` is `{hosts: [Person]}`, oldest first, not
  paginated.** · A short, personal list. · n/a
- **The menu reuses the host menu's popover** (same button, same
  keyboard handling: views/event.html's `menuParts` finds whichever is on
  the page), at the right of the answer card's heading (or of the
  "cancelled"/"has ended" line on a past or cancelled event, where muting
  and leaving still make sense). What it did is said under the heading
  ("Muted. You'll still hear if it's cancelled or moved."). · As asked.
- **Friends page: an "Opted out of invites from" card under the friends
  list, only when there's someone in it, each with Undo; the last Undo
  takes the card away.** · As asked. · `optoutsSection`, views/friends.html.
- **Tests**: test/guestMenu.test.js (notify's filter type by type; mute's
  who-may, a wall post skipped and moved/cancelled/back-on kept, a
  co-host never muted, unmute; leave: hosts and co-hosts refused, the row
  gone and not counted, the waitlist promoted and told, the wall, inbox,
  lists and calendar entry gone, rejoining as a fresh visitor, an
  invitation left; opt-out: the vague `not_found` next to a real no-account
  id, no invitation or friendship, `already_on_list` for someone on it,
  other hosts unaffected, undo; the pages' menu items, toggled labels,
  no menu for hosts, signed out or a visitor with no row, the friends
  card); test/db.test.js (version 14); test/leaks.test.js walks the
  opt-out list for every caller. Checked by hand at 375 px: the menu
  opening over the answer buttons, Mute, Opt out of Ana (the item turned
  into "Allow invites from Ana"), Remove me (the confirm, then the page as
  a fresh visitor), and Undo on the friends page.
- **(You) Red was unreachable on the color slider.** Two causes: accents
  were Canopy green turned to the event's hue, which carried green's 16°
  offset (a red page got a pink accent), and green's fixed lightness, at
  which red can only be coral. Now `accentTrio(h)` puts the accent at the
  event's own hue, at that hue's most vivid lightness (clamped between
  the 5:1 dark-text minimum and 0.80), with chroma capped at 0.21 (near
  Canopy green's) so nothing goes neon. Hue 30 → `#f14634` (red). Canopy
  green itself is unchanged. The worst dark-text contrast is now 5.0:1
  (was 6.8:1), still above AA. The iOS port must follow (docs/api.md
  has the exact rule and sample values).

## Home tabs and status badges

On `feat/home-tabs`. **(You)** asked for tabs on the home page (All ·
Invited · Hosting · Past) and a fixed-color status badge on every card,
with hosting blue. The rest:

- **A new list, `GET /api/v1/me/events/all`, not the browser merging
  three.** One more entry in `LISTS` (lib/store/events.js): hosting,
  upcoming (going, maybe, waitlisted) and invitations OR'd in one query,
  so each event comes once, soonest first, with one cursor; same rules
  for cancelled as the lists it joins (a host's or attendee's cancelled
  event stays, a cancelled invitation doesn't). No schema change. ·
  Merging three paginated lists with "Show more" means three cursors and
  holding back rows that might sort after another list's unseen ones;
  one SQL list pages exactly. The app can use it too. · Merge client-side.
- **The page loads every tab's first page** (all, invitations, hosting,
  past: 20, 20, 20, 10) and draws the one `?tab=` picks; switching tabs in
  the browser is instant, with no request. Four list requests, as
  before (upcoming is no longer fetched). · As cheap as today's page. ·
  Fetch each tab on first open.
- **`?tab=invited|hosting|past`; All is plain `/`.** Anything else
  (unknown, empty, repeated, wrong case) is All. The browser *replaces*
  the address on a tab change rather than pushing one, so a reload and
  coming back to the page keep the tab, but Back leaves the page rather
  than stepping through tabs. · Tabs read as a filter, not as pages. ·
  pushState with a popstate handler.
- **Tabs are links** (`<a role="tab" href="/?tab=…">`) in a
  `role="tablist"`, with `aria-selected`, roving `tabindex`,
  `aria-controls` to one `role="tabpanel"` (`#homePanel`, labelled by
  the selected tab). Arrow keys (wrapping), Home and End move and select
  (automatic activation: everything's already loaded). A modified or
  middle click is left to the link, so a tab opens in a new tab. ·
  Works before the script runs. · Buttons.
- **Look: a segmented control on dark blurred glass, the selected
  segment white with the page's near-black on it (19:1), the rest white.
  Sticky at the top on every width**, inside the lists' box, so it lets
  go before the Calendar card. Checked at 375 px and in the desktop pane.
  · Green for the selected segment would read as "Going". · n/a
- **No section headings in a panel**; the tab names it. **Empty states:**
  All "Nothing coming up yet.", Invited "No invitations right now.",
  Hosting "You're not hosting anything yet.", Past "No past events
  yet." The old empty lines (`home.empty`, `home.emptyHost`) and the
  list headings (`home.invitations` etc.) are gone. · No help text.
- **Unverified:** the "Confirm your email to make your own events." line
  stays where it was, under the heading in the place of "+ New event",
  on every tab; their Hosting tab shows the plain empty line under it
  rather than a second copy. · One line, not two. · n/a
- **An invitation is the same card on All as on Invited**: the Invited
  badge and the Going / Can't Go buttons. Answering reloads All and
  Invited: Going turns it into a Going card on All, Can't Go takes it
  off both. The button says "Can't Go" (`status.not_going`), matching
  the event page. Two buttons, so 1:1; the event page's 2:1:1 is
  unchanged. · The default tab keeps one-tap answering. · Buttons only
  on Invited.
- **Badge colors, fixed (never the event's theme or accent), dark text
  on a light pill:** hosting `#6cb4ff`/`#03122a` 8.55:1, going
  `#2ec44f`/`#03190a` 7.95:1 (Canopy green as a literal, since an
  event's `--accent` can change), maybe `#f2c94c`/`#1f1600` 11.28:1
  (amber), waitlisted `#ff8a3d`/`#2a1100` 7.60:1 (orange), invited
  `#c4ccc7`/`#121815` 10.97:1 (gray). CSS custom properties
  `--status-<status>` and `--status-on-<status>` in public/events.css;
  the table is in docs/api.md, "Status colors". Maybe and the waitlist
  had no colors of their own before (both plain glass), so they're new.
  · Light pills match the existing green one. · Light text on dark pills.
- **Co-hosting shows "Hosting" everywhere**, on cards and on the invite
  and co-host pages (it said "Co-hosting" there). Can't go and removed
  stay plain glass. **A cancelled event keeps its badge and adds
  "Cancelled"** (before, Cancelled replaced it). **The Hosting badge
  shows on the Hosting tab too** ("every card"). One function,
  `statusTag`, draws them all. · As asked; consistent. · n/a
- **Tests:** each tab's events (a host's event in All and Hosting, an
  invitation in All and Invited with its buttons, a past one only in
  Past, going only in All), `?tab=` honored and bad values falling back
  to All, the tab ARIA and roving tabindex, the Calendar card below, the
  unverified line on Hosting; badges' class and text for every status,
  on themed and gray-with-accent events, cancelled, and on the invite
  and co-host pages; the CSS hexes, their ≥4.5:1 contrast and that
  docs/api.md lists the same values; `/me/events/all`'s contents, order,
  paging and 401 (test/me.test.js); the leak walker and the inbox test
  read `/all` (and `/declined`); the boundary test is unchanged and
  passes. Checked by hand at 375 px and in the desktop pane: clicking,
  arrows, Home/End and wrap, the address changing, answering Going on
  Invited moving it to a Going card on All, the sticky bar over the
  list.
- **(You)** The Invited tab also shows upcoming events you declined, under
  a "Declined" heading below the unanswered invitations. Each has just a
  Going button to change your mind (an answer can change, never be
  withdrawn). Declined events aren't on All. · routes/pages.js loads
  `/me/events/declined` with the other lists (UI.HOME_LOADS).

## Backgrounds from TMDB (in progress, feat/backgrounds)

- **(You)** Hosts can pick a cover from a curated set of TMDB backdrops.
  **Only the picker fetches from TMDB.** Choosing one saves it as an
  ordinary uploaded cover (our copy, through the normal cover pipeline),
  so event pages, link previews, apps and the calendar never depend on
  TMDB. No images are in the repo.
- Assumed: curation is a TMDB list you maintain (`TMDB_LIST_ID`), with
  the token in `TMDB_TOKEN` on the server only. The feature is off until
  both are set. Textless backdrops are preferred. TMDB's attribution goes
  in the picker and on a small credits line. Search is left for later.
- **(You)** On phones, a list row's picture fills the card's left edge,
  top to bottom, as a 108px square cropped from the middle of the cover
  (rounded only by the card's own corners). A taller row (a two-line
  title) stretches it a little taller rather than leaving a gap. Desktop
  keeps the inset 3:2 thumbnail. Invitation cards do the same. The
  srcset hint asks for 162px (a 3:2 crop is drawn wider than its square).
- **(You)** The Calendar card moved from the bottom of the home page
  into a popover, opened by a calendar icon button next to "+ New event"
  (shown to unverified people too). It's a dialog (it holds a link and a
  switch): Escape or a tap outside closes it and focus returns to the
  button.
- **(You)** Card titles are one size everywhere: 22px, weight 800
  (Attending's), for the event page's cards, the editor's, the friends
  page's and the Calendar card. "You're hosting" → **Hosting** ("You're
  co-hosting" → **Co-hosting**).

## Backgrounds from TMDB

On `feat/backgrounds`. **(You)** asked for a curated background picker
sourced from TMDB: a TMDB list (`TMDB_TOKEN`, `TMDB_LIST_ID`), cached
for a day, `GET /api/v1/backgrounds`, and `PUT
/api/v1/events/{id}/cover/background` saving the choice exactly as an
upload, hosts only, same limits, no SSRF; a second hero button in the
editor; TMDB's attribution. Then: **(You)** the set is mainly a
hand-picked manifest of exact images, `config/backgrounds.json`, with
the list optional after it; and the first 23 picks (Mean Girls 9, The
Devil Wears Prada 7, The Wizard of Oz 1, Wicked 5, Schitt's Creek 1),
kept even where they have text on them. Where this differs from the
"in progress" note above (the feature being off without both TMDB
settings), this is what was built. The rest:

- **The manifest needs no token.** Its entries are exact file paths on
  TMDB's public image CDN; nothing asks TMDB's API about them (thumbnail,
  hue and the download on choose are all image.tmdb.org). The feature is
  on when the set isn't empty: manifest entries, or list backdrops with
  `TMDB_TOKEN` + `TMDB_LIST_ID`. · Fewer settings for the common case;
  the token only matters for the list. · Require the token in
  `createBackgrounds` (lib/backgrounds.js) for both.
- **The hue is worked out on the server, once per image, in the cover
  worker** (`measureThumb`: the 300 px thumbnail through the same
  `hueOf` as covers), and the API gives `hue`/`grayscale` per
  background. image.tmdb.org does send `Access-Control-Allow-Origin: *`
  (checked: a w300 backdrop answers with it), so the browser's canvas
  match would work, but this way the iOS app gets the hue without a
  canvas, the web doesn't depend on a CDN header, and it costs one small
  download per image per server start. Measured in the worker, behind
  any upload. · The editor could use `matchPicked(thumbUrl)` with
  `crossOrigin = 'anonymous'` instead; `hue` would then be droppable.
- **`width`/`height` are the thumbnail's** (300 × 169 for 16:9), measured
  from the image itself, since manifest entries have no other source for
  them without the API. They're for the shape. · Ask TMDB's images
  endpoint for each title's originals when there's a token.
- **`previewUrl` (w780) added** next to `thumbUrl` (w300): the hero shows
  the 780 while the host decides (the 300 is blurry that big), and the
  grid uses it as the 2x `srcset`. · Drop it and preview the thumbnail.
- **`year` is optional in the manifest** (null when absent); the list
  path takes it from the release or first-air date. · n/a
- **The id is the file path, base64url**, looked up in the current set;
  a path or URL is never taken from a request. Paths are checked against
  `/^\/[A-Za-z0-9]{8,64}\.(jpg|jpeg|png|webp)$/` whether they came from
  the manifest or TMDB's API, and fetches refuse redirects. An id no
  longer in the set (a refresh dropped it) is 400 `bad_background`;
  TMDB's CDN failing on choose is a new 502 `background_unreachable`. ·
  SSRF. · n/a
- **The download** is TMDB's `original` (backdrops are up to 3840 px),
  then `w1280` if that fails, at most 15 MB (the upload's limit), 20 s;
  then the upload's own pixel limits and pipeline. The rate limit is the
  upload's counter: uploads and backgrounds count together, 30 a day. ·
  As asked. · n/a
- **Cache: loaded at startup, refreshed every 24 h on a timer** (not on
  the next request), retried after 10 minutes when anything failed. A
  failed list load keeps the last list; a title whose images fail keeps
  its last ones; a thumbnail is fetched once per image and kept, so a CDN
  outage doesn't empty the set. An image whose thumbnail never loaded
  isn't shown (so a mistyped `filePath` drops out, with a count in the
  log). The first answer after a start waits up to 5 s for the first
  load. · Simple; nothing survives a restart, which is fine at a day's
  staleness. · `REFRESH_MS`, `RETRY_MS`, `FIRST_LOAD_WAIT_MS`.
- **The list path:** up to 10 pages and 200 titles, 4 requests at a time,
  3 backdrops per title (`include_image_language=null`, sorted by
  `vote_average` then `width`; when a title has none, a second call
  without the parameter, any language). A list item that's a person is
  ignored. · n/a
- **Grouping:** a title's manifest entries are put together where the
  title first appears; the same image in both sources is shown once (the
  manifest's). The API says "consecutive entries with the same title and
  year are a group" rather than adding a group field. · Add `group` if
  two different titles ever share a name and year.
- **`GET /backgrounds` says `Cache-Control: private, max-age=3600`**, the
  one exception to no-store: it's the same for everyone and changes
  daily. Signed in only (requirePerson), not verified-only. · Remove the
  override in routes/backgrounds.js.
- **The pages ask the API** (`apiGet('/backgrounds')`, so the boundary
  test still holds): the editor (the button, and the sheet drawn
  server-side, hidden, with lazy images) and Your Events (the credit).
  A failure there means no picker, never a broken page. · n/a
- **The picker** is a dialog sheet like the time zone search: 2 per row
  on phones, 3 on wider screens, 3:2 tiles, the title (and year) small
  under each group, each tile a button labelled "Title (year), n of m",
  `aria-pressed` on the chosen one, Escape and the backdrop close it,
  Tab stays inside, focus returns to the button. The page behind doesn't
  scroll while it's open. Choosing closes it. · n/a
- **The new-event flow** reuses the upload-on-save path: the choice is
  the pending `coverChange`, sent right after the event is made; a
  refusal sends a new event to its editor with `?coverError=` like a
  failed upload. · n/a
- **Attribution:** TMDB's official "blue short" logo, inlined as SVG in
  public/ui.js (from themoviedb.org/about/logos-attribution, one path,
  its own gradient, `role="img" aria-label="TMDB"`), with their sentence,
  at the foot of the picker and small at the foot of Your Events, shown
  only while there are backgrounds. Their sentence is used as they word
  it. No image file was added. · n/a
- **Overrides:** `TMDB_API_BASE`, `TMDB_IMAGE_BASE` and
  `BACKGROUNDS_REFRESH_MS` are ignored with `NODE_ENV=production`;
  `BACKGROUNDS_FILE` (a path, or empty for none) works everywhere. The
  test harness sets it empty, so no test reaches the real TMDB. · n/a
- **No schema change.** · n/a
- **Tests** (test/backgrounds.test.js, against test/fakeTmdb.js): the
  manifest's validation and that the shipped file is all good entries;
  off without settings (empty set, no button, no credit, choosing
  refused); the set's shape, order, grouping, hues and the skipped bad
  entry; textless first and the fallback; pagination; the cache (no
  TMDB requests on repeat); choosing makes a real cover (every size, no
  EXIF, `coverHue`, `themeHue` untouched, a gray one, an app's bearer
  token); hosts only, co-hosts yes, the Origin check; 13 ids and 5
  bodies that aren't in the set, with TMDB asked nothing; the CDN down
  on choose (502); the shared daily limit; the editor's markup, labels,
  captions and credit, and Your Events' credit; an outage keeping the
  set, then a refresh picking up a change; a manifest without a token
  never asking the API. The harness now checks every API answer for the
  token (`noTmdbToken`), and the leak walker reads `/backgrounds`. The
  spec check and the boundary test pass unchanged. Checked by hand at
  375 px and in the desktop pane against the real image.tmdb.org with
  the 23 picks: opening, scrolling, Escape, picking (hero, slider to
  the server's hue), Create event saving it as a local cover, and the
  credit on Your Events.
- **(You)** The home header reads "+ New event" then the calendar button,
  both 44px tall; the calendar icon is plain white, not green.
- **(You)** "Wall" is now **Updates** in everything people read (the
  heading, the hidden note, the delete confirm, the remove-guest copy).
  The API keeps its names (`/wall`, `wall_post`) so apps don't break.
- **(You)** A declined event's card shows your answer as a small
  dropdown (Can't Go, or change it to Going or Maybe) where its badge
  was, not a big Going button.
- **(You)** The background picker is one grid with no title headings
  (each tile's screen-reader label still names its title). TMDB's credit
  appears only at the foot of the picker, not on the home page.

## Lists and the inviter (in progress, feat/lists-inviter)

- **(You)** "Lists", not groups. Lists are owned by a person and private,
  and people join one themselves by a link or QR code. Weekly Drag Race:
  newcomers join the list at the event and get invited to the next one.
- Assumed: only the owner sees members. Joining asks first ("Join
  Naren's Drag Race? Naren will be able to invite you to events").
  Attaching a list to an event invites its members, and anyone who joins
  later is auto-invited to that list's upcoming attached events. Guests
  not on the list see "Get invited next time: Join <list>". Hosts get
  "Show list QR" in their ⋯ menu.
- **(You)** The inviter, all approved: an invite sheet over the event
  page; one search field that also does phone/Instagram lookup;
  Suggested first (frequent, recent co-attendees); lists with "Invite
  all"; "Invite everyone from…" a past event; a selection tray with
  "Invite N"; people already on the event greyed with their status.
