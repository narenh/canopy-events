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
