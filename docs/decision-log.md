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
