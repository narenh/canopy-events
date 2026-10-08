# Canopy Events API: a guide for app developers

This is the narrative half of the API's documentation, for whoever builds
the iOS and Android apps. The other half is `openapi.yaml` (OpenAPI 3.1),
which is the contract: every route, every field, every error. It's served
at `https://events.canopysf.com/api/v1/openapi.yaml` and rendered at
`https://events.canopysf.com/docs`. The server's tests check every answer
against it, so when this guide and the spec disagree, the spec wins.

The web pages use exactly this API. Anything a page can do, an app can.

## The shape of things

- Everything is under `/api/v1`. JSON in (`Content-Type:
  application/json`) and JSON out.
- **Times** come back as ISO 8601 UTC strings: `2026-11-01T02:30:00.000Z`.
  Times you send need `Z` or an offset (`2026-10-31T19:30:00-07:00`). A bare
  `2026-10-31T19:30` is refused, because it doesn't say which 7:30.
- **Every event has an IANA time zone** (`America/Los_Angeles`). Show its
  times in that zone, not the phone's: "7:30pm" means the host's 7:30pm.
- **Ids are strings.** Event ids are 12 characters of base62
  (`4fQ9xKpL2mZa`), and an event's link is
  `https://events.canopysf.com/e/<id>`. Person ids are the account
  service's UUIDs.
- Every answer is `Cache-Control: no-store`. Don't cache answers about
  people longer than the screen that shows them.
- Fields the server doesn't know are ignored, so an app built against a
  newer version still works against an older server.

## Signing in

Everyone is a Canopy account (`account.canopysf.com`). Events keeps no
names, emails or photos of its own.

**Apps send a bearer token**: `Authorization: Bearer <token>`. The token is
a `canopy_session` value, 43 characters of base64url. The account service
will grow a native sign-in flow that hands an app one; **it isn't built
yet**. Until then, for development, sign in on the web
(`account.canopysf.com`, or `localhost:3000` locally) and copy the
`canopy_session` cookie out of the browser.

What to know about the token:

- A request with a bearer header is signed in by that token and nothing
  else, even if it also carries a cookie. A malformed token is signed out.
- Bearer requests skip the Origin check (below) and never get a
  `Set-Cookie` back.
- It lasts a year from when it was last used. Signing out anywhere on
  Canopy ends it.
- Treat it like a password: the Keychain on iOS, EncryptedSharedPreferences
  or the Keystore on Android. Never log it.

The web pages use the `canopy_session` cookie instead, which the browser
sends by itself. A change made with the cookie (POST, PUT, PATCH, DELETE)
has to carry an `Origin` header for a Canopy page, or it's refused with
403 `bad_origin`. That's the guard against other websites. Apps don't send
`Origin` and don't need to: a bearer request can't be forged by a website.

**Signed out.** Most calls answer 401 `sign_in_required` with two links:

```json
{
  "error": "sign in first",
  "reason": "sign_in_required",
  "signIn": "https://account.canopysf.com/?return=https%3A%2F%2Fevents.canopysf.com%2Fe%2F4fQ9xKpL2mZa",
  "quickSignUp": "https://account.canopysf.com/?quick=1&return=https%3A%2F%2Fevents.canopysf.com%2Fe%2F4fQ9xKpL2mZa"
}
```

`quickSignUp` is for someone who has never used Canopy: first name, last
name, email and a passkey, no emailed code. Offer it next to "sign in".

`GET /api/v1/events/{id}` is the one call that works signed out (see "What
a signed-out caller sees").

## Unverified accounts and the banner

A quick sign-up makes an **unverified** account: nobody has proven the
email yet. Events lets them in. They can answer, be invited and see guest
lists. They **can't make events** (403 `email_unverified`) or be co-hosts.

`GET /api/v1/me` says which:

```json
{
  "person": { "id": "…", "email": "ana@example.com", "firstName": "Ana", "emailVerified": false, "…": "…" },
  "verifyUrl": "https://account.canopysf.com/profile?verify=1&return=https%3A%2F%2Fevents.canopysf.com%2F",
  "hasHosted": false
}
```

`hasHosted` is true once you host or co-host any event, cancelled and past
ones included: show the Hosting tab only then. (A co-host who steps down
from their only event is back to false; there'd be nothing in the tab.)

While `emailVerified` is false, **show a verify-your-email banner on every
screen, and don't let it be dismissed**. It's never a hard block: the app
works under it. The banner opens `verifyUrl` (in an in-app browser), where
they get a code by email. Once they've typed it, `emailVerified` turns true
within about a minute (the server caches who you are for up to 60 seconds)
and `verifyUrl` is null. Fetch `/me` again when the app comes back to the
foreground.

A 403 `email_unverified` always comes with a `verify` link too, so a
"make an event" button can send them straight there.

## People, and what you'll never get

**Contact details never leak.** Anyone other than you is only ever a
`Person`:

```json
{ "id": "6f1c…", "firstName": "Ana", "lastName": "Lima", "shortName": "Ana L", "photoUrl": "https://account.canopysf.com/photo/6f1c…?v=1759870000000" }
```

No email, phone, Instagram, Venmo or Cash App, for anyone, ever, not even
for a host looking at their own guests. Only `GET /api/v1/me` has those,
and they're yours. Don't build features that need someone else's.

- `photoUrl` is null for no photo. It's on `account.canopysf.com` and
  served only to a Canopy session (anyone else gets a 404). Today that
  endpoint reads only the cookie, so an app loads it with the header
  `Cookie: canopy_session=<token>`. Cache it: the `?v=` changes whenever
  the photo does.
- Someone whose account has been deleted is a **former member**:
  `firstName: "Former member"`, `lastName: ""`, `shortName: "Former
  member"`, `photoUrl: null`. Their answers still count.

## Events

`POST /api/v1/events` makes one (verified people only, 20 a day). You're
its creator and only host. Required: `title`, `startsAt`, `timeZone`.
Optional: `description`, `endsAt` (after `startsAt`), `locationName`,
`locationAddress`, `guestListVisibility` (`everyone`, the default, or
`responded`).

`PATCH /api/v1/events/{id}` edits it (hosts only: the creator and any
co-hosts). Send only what changes; `null` or `""` clears an optional
field. `{"status": "cancelled"}` cancels it, and `{"status": "active"}`
takes that back; only the creator can do either (403 `creator_only`).
There's no delete: a cancelled event keeps its link and guest list so
people can see it's off.

`guestsAllowed` (0 to 10, 0 by default) is how many plus-ones each answer
may bring. See "Plus-ones" below.

An event with no `endsAt` counts as **over** 6 hours after it starts.
Over is what moves it from "upcoming" to "past", and an event that's over
takes no more answers or invitations.

### What a signed-out caller sees

`GET /api/v1/events/{id}` answers anyone with the link, so a link preview
or a "sign in to answer" screen can show the event:

- the title, description, times, time zone, `locationName`, the hosts,
  the status and the counts;
- **not** the street address: `locationAddress` is null and
  `locationAddressHidden` is true when there is one. Link previews are
  fetched and kept by machines, and a home address shouldn't sit in their
  caches;
- **not** the guest list (`GET /guests` is 401), `viewer` is null, and
  there's no `friendsGoing`.

Signed in (even unverified), you get the address, `viewer` (your part in
it) and `friendsGoing`.

## Answering: the RSVP state machine

Your place on an event is `viewer.rsvp`: null (nothing), or one of these
statuses.

```
                 a host invites you
   (nothing) ─────────────────────────▶ invited
       │                                  │  ▲
       │ you answer                       │  │ you take your answer back
       ▼                                  ▼  │ (you were invited)
   going ◀──▶ maybe ◀──▶ not_going ───────────┘
       │
       └── you take your answer back (not invited) ──▶ (nothing)

   invited ── the host takes the invitation back ──▶ (nothing)
```

- `PUT /api/v1/events/{id}/rsvp` with `{"status": "going"}` (or `maybe`,
  `not_going`) answers or changes the answer. Anyone signed in with the
  link may answer, invited or not.
- `DELETE /api/v1/events/{id}/rsvp` takes it back: invited again if a host
  invited you (`viewer.rsvp.invited` says so), otherwise nothing.
- A host can take back an invitation (`DELETE
  /api/v1/events/{id}/invites/{personId}`) only while it has no answer.
- **Refused with 409**: a cancelled event (`event_cancelled`), one that's
  over (`event_over`), and a host answering their own event
  (`host_cannot_rsvp`; hosting is being there).
- `guests` (plus-ones): send `{"status": "going", "guests": 2}`, up to the
  event's `guestsAllowed`. More is 400 `too_many_guests`. Left out, it's
  0; with `not_going` it's always 0. See "Plus-ones".
- **`waitlisted`** is coming with capacity: a `going` past the cap
  becomes `waitlisted`, and a freed spot promotes the earliest. Nothing
  sets it yet, but handle it now: show it as "on the waitlist".

Both calls answer with the whole event, so the screen can redraw from the
answer.

## Plus-ones

The host sets `guestsAllowed` on the event (0 to 10). Each answer then
carries `guests`, how many people they're bringing besides themselves.
`maybe` can bring guests too; `not_going` never does.

**Counts give people and plus-ones apart, and together.** The top-level
numbers in `counts` are people. `counts.guests` is their plus-ones, and
`counts.total` is the two added up, for the statuses that bring anyone:

```json
"counts": {
  "going": 4, "maybe": 1, "notGoing": 1, "invited": 3, "waitlisted": 0,
  "guests": { "going": 2, "maybe": 0, "waitlisted": 0 },
  "total":  { "going": 6, "maybe": 1, "waitlisted": 0 }
}
```

"6 going" on a screen is `total.going`; "4 people (+2)" is `going` and
`guests.going`.

**When the host lowers `guestsAllowed`**, answers that already bring more
are kept as they are: nobody's plus-one disappears without them knowing.
They're flagged `guestsOverLimit: true`, on your own `viewer.rsvp` and on
each guest-list entry, so the app can ask the guest to update, and a host
can see who's over. The next change to that answer has to fit the new
number, even if it's the same answer sent again.

## Co-hosts

An event has one **creator** and up to 10 **co-hosts** (`hosts`, each with
a `role`). Co-hosts can do what hosts do: edit the event, invite people,
see the whole guest list. Three things are the creator's alone: managing
co-hosts, cancelling (and un-cancelling), and making a new link.
`viewer.role` says which you are.

- `POST /api/v1/events/{id}/cohosts` with `{"personId": "…"}` (the
  creator) makes someone a co-host. Doing it twice is fine.
- `DELETE /api/v1/events/{id}/cohosts/{personId}` takes them off. The
  creator can take off anyone; a co-host can take themselves off (step
  down).

**Co-hosts have to be verified.** The account service doesn't tell sites
whether someone else's email is proven, so events goes by what it saw the
last time that person used it, signed in. Someone who has never opened
Canopy Events with a verified email gets **403 `email_unverified` with no
`verify` link**. (When the 403 has a `verify` link, it's about your own
email; without one, it's about the person you picked.) Tell the host to
have them open the event link once, then try again.

**A co-host doesn't answer.** Hosting is being there, like the creator.
Becoming a co-host replaces any answer or invitation they had (plus-ones
included), so they drop out of the counts. Taking them off, or stepping
down, leaves them **invited**: the event is in their invitations and they
can answer like anyone else.

## The guest list, and who sees it

`GET /api/v1/events/{id}/guests` (signed in). **Counts are always there.**
Names depend on the host's `guestListVisibility`:

| You are | `everyone` | `responded` |
|---|---|---|
| a host | everything | everything |
| answered (any answer, `not_going` too) | names | names |
| invited, no answer yet | names | counts only |
| anyone else signed in | names | counts only |
| signed out | 401 | 401 |

With counts only, `guestsVisible` is false and `guests` is empty.
`viewer.canSeeGuestList` on the event says the same thing in advance.

Non-hosts see the answers (`going`, `maybe`, `not_going`, `waitlisted`).
Hosts also see who's `invited` and hasn't answered. `?status=going` (or
any status) narrows the list; `?status=invited` is 403 `hosts_only` for
anyone else. The list is in the order people got their status.

`friendsGoing` on an event follows the same rule: the count always, the
names (up to 12) only when you can see the guest list's names.

## Friends and invitations

There are no friend requests. **Two people are friends once they've both
been at the same event**: hosting it, or answering `going`, on an event
that has started and wasn't cancelled. `maybe` doesn't count, and an
event still to come doesn't either.

`GET /api/v1/me/friends` lists yours, most events in common first, with
`eventsInCommon` and `lastTogetherAt`.

A host invites with `POST /api/v1/events/{id}/invites` and
`{"personIds": [...]}` (1 to 100). Offer friends in the app; the API takes
any Canopy person id, so a "find by phone number or Instagram" lookup can
feed it later. Each id comes back in `invited`, or in `skipped` with a
reason: `already_on_list`, `is_host` or `not_found`. 300 invitations per
host a day.

## Your events

Five lists, each a page at a time:

| | What's in it | Order |
|---|---|---|
| `GET /api/v1/me/events/hosting` | events you host that aren't over, cancelled included | soonest first |
| `GET /api/v1/me/events/upcoming` | not over, and you said `going` or `maybe` (or are waitlisted); cancelled stay, so they show as off | soonest first |
| `GET /api/v1/me/events/invitations` | invited, no answer yet, not over, not cancelled | soonest first |
| `GET /api/v1/me/events/declined` | you said `not_going`, not over, not cancelled (so you can change your mind) | soonest first |
| `GET /api/v1/me/events/past` | over, and you hosted or said `going` or `maybe` | most recent first |

Each item is a whole `Event` as you see it (with `viewer`), minus
`friendsGoing`, which is only on a single event.

## Pagination

Lists take `?limit=` (1 to 100, 20 by default) and `?cursor=`, and answer
with `nextCursor`:

```
GET /api/v1/me/friends?limit=20                 -> { "friends": [...], "nextCursor": "WzMsIjA..." }
GET /api/v1/me/friends?limit=20&cursor=WzMsIjA...  -> { "friends": [...], "nextCursor": null }
```

- Pass `nextCursor` back as `?cursor=` for the next page. **Null means the
  end**, and only null does: a page can hold fewer than `limit` items with
  more to come (deleted accounts are left out of a friends page, say).
- Cursors are opaque. Don't build or parse them. A bad one is 400
  `bad_cursor`; start again from the first page.
- They're keyed on the last item rather than a position, so an event made
  or an answer changed while someone scrolls doesn't skip or repeat rows.

## Errors

```json
{ "error": "an event has to end after it starts", "reason": "ends_before_start" }
```

Branch on `reason`; `error` is a sentence you can show. The ones to
expect:

| Status | `reason` | What to do |
|---|---|---|
| 400 | `bad_json`, `bad_title`, `bad_starts_at`, `bad_ends_at`, `ends_before_start`, `bad_time_zone`, `bad_guest_list_visibility`, `bad_description`, `bad_location_name`, `bad_location_address`, `bad_status`, `bad_guests`, `too_many_guests`, `bad_guests_allowed`, `bad_person_ids`, `bad_person_id`, `bad_cursor`, `bad_limit` | fix the request; most are form errors to show |
| 401 | `sign_in_required` | sign in (`signIn`) or quick-sign-up (`quickSignUp`) |
| 403 | `email_unverified` | with `verify`: send them there. Without: the person they picked to co-host isn't known to be verified |
| 403 | `hosts_only` | hide the control: `viewer.canEdit` says who's a host |
| 403 | `creator_only` | hide the control: `viewer.role` is `creator` for the one person who can |
| 403 | `bad_origin` | a web page's problem; apps never see it |
| 404 | `event_not_found`, `not_invited`, `person_not_found`, `not_cohost`, `not_found` | the link is wrong, or it's gone |
| 409 | `event_cancelled`, `event_over`, `host_cannot_rsvp`, `already_responded`, `is_creator`, `too_many_cohosts` | redraw from the event |
| 413 | `too_large` | the body is over 100 KB |
| 429 | `rate_limited` | try again later |
| 503 | `accounts_unreachable` | Canopy accounts is down; retry in a minute |
| 500 | `server_error` | our bug; retry once, then tell us |

## Limits

| What | Per person | Per address | Everyone |
|---|---|---|---|
| Making events | 20 a day | 60 a day | 1,000 a day |
| Invitations (each person invited counts one) | 300 a day | 600 a day | 5,000 a day |
| Invitations in one request | 100 | | |

Text fields are capped: title 120 characters (longer is cut), description
5,000, place name 200, address 500. A request body is at most 100 KB.

## Worked examples

Locally (account service on :3000, events on :3001), with a token copied
from the `canopy_session` cookie:

```bash
TOKEN=q3Xb...           # 43 characters
API=http://localhost:3001/api/v1
auth=(-H "Authorization: Bearer $TOKEN")
```

Who am I?

```bash
curl -s "${auth[@]}" $API/me
```

Make an event:

```bash
curl -s "${auth[@]}" -H 'Content-Type: application/json' -X POST $API/events -d '{
  "title": "Rooftop dinner",
  "startsAt": "2026-10-31T19:30:00-07:00",
  "endsAt": "2026-10-31T23:00:00-07:00",
  "timeZone": "America/Los_Angeles",
  "locationName": "Ana'\''s place",
  "locationAddress": "1 Market St, San Francisco",
  "guestListVisibility": "responded"
}'
# -> 201 {"event": {"id": "4fQ9xKpL2mZa", "url": "http://localhost:3001/e/4fQ9xKpL2mZa", ...}}
```

See it signed out, the way a link preview does:

```bash
curl -s $API/events/4fQ9xKpL2mZa
# -> {"event": {..., "locationAddress": null, "locationAddressHidden": true, "viewer": null}}
```

Invite two friends:

```bash
curl -s "${auth[@]}" $API/me/friends
curl -s "${auth[@]}" -H 'Content-Type: application/json' -X POST $API/events/4fQ9xKpL2mZa/invites \
  -d '{"personIds": ["0b7e5a1f-9c2d-4e8b-8f3a-1d2c3b4a5e6f", "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"]}'
# -> {"invited": [{"id": "0b7e…", "firstName": "Ben", ...}], "skipped": [{"personId": "9a8b…", "reason": "not_found"}]}
```

Answer, as a guest (with their token):

```bash
curl -s -H "Authorization: Bearer $GUEST_TOKEN" -H 'Content-Type: application/json' \
  -X PUT $API/events/4fQ9xKpL2mZa/rsvp -d '{"status": "going"}'
# -> {"event": {..., "viewer": {"role": null, "rsvp": {"status": "going", "guests": 0, "invited": true, ...}}}}
```

The guest list, two at a time:

```bash
curl -s "${auth[@]}" "$API/events/4fQ9xKpL2mZa/guests?limit=2"
curl -s "${auth[@]}" "$API/events/4fQ9xKpL2mZa/guests?limit=2&cursor=<nextCursor>"
```

Cancel it:

```bash
curl -s "${auth[@]}" -H 'Content-Type: application/json' -X PATCH $API/events/4fQ9xKpL2mZa -d '{"status": "cancelled"}'
```

What's coming up, and what I've been invited to:

```bash
curl -s "${auth[@]}" $API/me/events/upcoming
curl -s "${auth[@]}" $API/me/events/invitations
```
