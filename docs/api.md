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
- Every answer is `Cache-Control: no-store` (except `GET /backgrounds`). Don't cache answers about
  people longer than the screen that shows them.
- Fields the server doesn't know are ignored, so an app built against a
  newer version still works against an older server.

## Signing in

Everyone is a Canopy Account (`account.canopysf.com`). Events keeps no
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
  "person": { "id": "…", "firstName": "Ana", "emailVerified": false, "…": "…" },
  "verifyUrl": "https://account.canopysf.com/profile?verify=1&return=https%3A%2F%2Fevents.canopysf.com%2F",
  "hasHosted": false
}
```

`hasHosted` is true once you've hosted or co-hosted any event: show the
Hosting tab only then. Once a host, always a host: it stays true after a
co-host steps down (or is taken off), and when every event they hosted is
over or cancelled, so the tab doesn't come and go.

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
for a host looking at their own guests, and not even your own: events
doesn't have them. The app reads and changes your own at Canopy Accounts,
`GET`/`PATCH /api/native/v1/me`. Don't build features that need someone
else's.

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
`locationAddress`, `latitude`, `longitude` and `applePlaceId` (see
"Where: the location" below), `guestListVisibility` (`everyone`, the
default, or `responded`).

`PATCH /api/v1/events/{id}` edits it (hosts only: the creator and any
co-hosts). Send only what changes; `null` or `""` clears an optional
field. `{"status": "cancelled"}` cancels it, and `{"status": "active"}`
takes that back; only the creator can do either (403 `creator_only`).
A cancelled event keeps its link and guest list so people can see it's
off, and they're notified (`event_cancelled`).

`DELETE /api/v1/events/{id}` deletes it for good (the creator only; 403
`creator_only` for anyone else): its hosts, answers, invitations, wall,
everyone's notifications about it and its cover all go, and the link is
a 404 `event_not_found` afterwards. **Nobody is notified**, so when
people have answered going or maybe, suggest cancelling instead (the web
page's confirm does) and delete only if the host still wants to.

`guestsAllowed` (0 to 10, 0 by default) is how many plus-ones each answer
may bring. See "Plus-ones" below.

`details` are the host's extra fields under the description (a link,
the dress code, parking...). See "Event details" below.

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
- **not** where it is on a map, for the same reason: `latitude`,
  `longitude` and `applePlaceId` are null (and `locationAddressHidden` is
  true when there's a pin, even with no address);
- **not** the `parking`, `accommodation` or `phone` details, for the
  address's reason (they can hold an address, a door code or a number):
  `details` has only the others, and `hiddenDetails` counts the ones left
  out;
- **not** the guest list (`GET /guests` is 401), `viewer` is null, and
  there's no `friendsGoing`.

Signed in (even unverified), you get the address, every detail, `viewer`
(your part in it) and `friendsGoing`. Someone a host removed gets what
someone signed out gets.

### Where: the location

An event's location is five fields:

| Field | What | Who sees it |
|---|---|---|
| `locationName` | a named place: "Dolores Park", "Zeitgeist" | everyone with the link, link previews too |
| `locationAddress` | the address, or a place typed by hand | signed-in guests (not someone removed) |
| `latitude`, `longitude` | where it is on a map, in degrees (both, or neither) | as the address |
| `applePlaceId` | Apple Maps' id for the place | as the address |

The web editor has one **Location** field. As the host types (2
characters or more), it suggests places from Apple Maps; the first
suggestion is always `Use "<what they typed>"`, as it is. What each
choice is saved as, and what an app should send for the same:

- **A named place** (`kind: poi`): `locationName` its name,
  `locationAddress` its address, and its `latitude`, `longitude` and
  `applePlaceId`.
- **A street address** (`kind: address`): `locationAddress` only, with
  `locationName` null, plus the pin. A street address is never public.
  (A `locationName` that's the same as the address's first line is
  dropped by the server for that reason.)
- **Typed by hand** (`Use "…"`, or Apple Maps not set up): the text as
  `locationAddress`, with `locationName`, the pin and the id null. Typed
  text may well be someone's home address, so it's private: someone
  signed out sees no location at all, and "sign in to see the address".

Sending `locationName` or `locationAddress` changed, without the pin, clears
the pin and `applePlaceId` (they were for the old place). Sending only
other fields leaves them as they are. Refusals: `bad_coordinates` (half a
pair, out of range, not numbers, or a pin with no name or address) and
`bad_apple_place_id`.

**On iOS**, use MapKit for the suggestions and the place, not this
server: an `MKLocalSearchCompleter` (`resultTypes = [.pointOfInterest,
.address]`) as the host types, then an `MKLocalSearch` with the picked
completion for the `MKMapItem`. Send:

```json
{
  "locationName": "Dolores Park",
  "locationAddress": "19th St & Dolores St, San Francisco, CA 94114, United States",
  "latitude": 37.759773,
  "longitude": -122.427063,
  "applePlaceId": "I5B8A0D4E1F2C3B7A"
}
```

- `locationName`: `mapItem.name` for a point of interest
  (`mapItem.pointOfInterestCategory != nil`, or the completion's
  subtitle is the address); **null** when the pick is an address (its
  name is the street address).
- `locationAddress`: the placemark's address, one line (iOS 26's
  `mapItem.address?.fullAddress`, or `CNPostalAddressFormatter` on
  `placemark.postalAddress`, lines joined with ", ").
- `latitude`, `longitude`: `mapItem.location.coordinate` (or
  `placemark.coordinate`); 6 decimals is plenty.
- `applePlaceId`: `mapItem.identifier?.rawValue` (iOS 18+), or null.
- Typed text, not picked: `locationAddress` only, everything else null.

**Places from the server** (the web, or an app without MapKit):

```bash
curl -s "$BASE/api/v1/places/autocomplete?q=dolores&near=37.77,-122.42" \
  -H "Authorization: Bearer $TOKEN" -H "Accept-Language: en-US"
# -> {"enabled": true, "results": [
#      {"id": "L3YxL3Nl…", "name": "Dolores Park", "address": "19th St & Dolores St, San Francisco, CA 94114, United States", "kind": "poi"},
#      {"id": "L3YxL3Nl…", "name": "1 Dolores St", "address": "San Francisco, CA 94103, United States", "kind": "address"}]}

curl -s "$BASE/api/v1/places/L3YxL3Nl…" -H "Authorization: Bearer $TOKEN"
# -> {"place": {"name": "Dolores Park", "address": "19th St & Dolores St, San Francisco, CA 94114, United States",
#     "addressLines": ["19th St & Dolores St", "San Francisco, CA 94114", "United States"],
#     "lat": 37.759773, "lng": -122.427063, "applePlaceId": "I5B8A0D4E1F2C3B7A", "kind": "poi"}}
```

Both are for people who can host (verified). Autocomplete gives at most 8,
from 2 characters; `near` ("lat,lng") favors places near it (otherwise the
server's default, San Francisco), and `Accept-Language` sets the language.
`enabled: false` means places are off on this server (no Apple Maps key):
the field is plain text. **A 502 `places_unavailable`** means Apple
couldn't be asked: let the host type it. 120 calls a minute per person,
the two together (429 `rate_limited`). A place's `id` is opaque; 404
`place_not_found` for one that isn't a suggestion's.

**On the event page**, with a pin, the address is a link to directions:
Apple Maps on an iPhone, iPad or Mac
(`https://maps.apple.com/?q=<name>&ll=<lat>,<lng>`), Google Maps
elsewhere (`https://www.google.com/maps/dir/?api=1&destination=<lat>,<lng>`).
Without one, the address and "Open in Maps", as before.

### Event details

Optional extra fields a host adds, like Partiful's "+ Link" and "+ Dress
code" chips. Every event has `details`, an ordered list (up to 10; `[]`
for none) of:

```json
{ "type": "link", "label": "Tickets", "value": "https://tickets.example.com/x", "href": "https://tickets.example.com/x" }
```

| `type` | Heading when `label` is null | SF Symbol | `value` | `href` | Signed out |
|---|---|---|---|---|---|
| `link` | none (one line: see below) | `link` | an http(s) address | the same | shown |
| `info` | Info | `info.circle` | text | null | shown |
| `dress_code` | Dress code | `tshirt` | text | null | shown |
| `food` | Food | `fork.knife` | text | null | shown |
| `parking` | Parking | `parkingsign` | text | null | hidden |
| `accommodation` | Where to stay | `bed.double` | text | null | hidden |
| `phone` | none (one line: see below) | `phone` | a number, as typed | `tel:` and its digits | hidden |

- `label` (up to 60 characters, one line, or null) is a link's text, a
  phone's label, or a heading in place of the type's own ("Potluck" for
  a `food`).
- Text values are plain (up to 500 characters) and keep their line
  breaks. Draw them as text; don't turn anything in them into links.
- A link opens in the browser (the web page opens a new tab, with no
  referrer); tapping a phone dials `href`. Only ever open a `link`'s
  `href` (always http or https) and a `phone`'s (always `tel:`).
- Several of one type are fine (two links). Show them in the order they
  come. Show nothing for a `type` you don't know: more may come.
- **How to draw them** (the web does this; match it): each is a row
  like the place's, its icon in the event's accent, after the hosts and
  spots and before the description.
  - **A link is one line, with no heading**: the icon, then its text as
    the link. With no `label`, the text is the address itself, shortened:
    drop `http://` or `https://`, a leading `www.` and a slash at the
    end, keep the rest, and past 48 characters cut it to 47 and an
    ellipsis ("…"); also let the line end in an ellipsis wherever it
    doesn't fit. The whole address is the link's title (a long-press
    preview in the app).
  - **A phone is one line, with no heading**: the icon, then the number as
    the `tel:` link; with a `label`, "<label> · <number>" (the label in
    bold, the number the link). The web's editor doesn't ask for a phone
    label, but keeps one an app set.
  - **The rest** are two lines: the heading (`label`, or the type's from
    the table) in bold, then the text under it, smaller, line breaks kept.
  - Signed out, with `hiddenDetails` above 0, a line under them: "More
    details show once you sign in."

**Setting them**: `details` on `POST` and `PATCH /events`, a list of
`{type, label?, value}`. A `PATCH` replaces the whole list (send all of
them, in order, to change one); `null` or `[]` takes them all off; leave
it out to leave them alone. A `link`'s value is checked and tidied: http
and https only (`javascript:`, `data:`, `mailto:` and the rest are 400
`bad_detail_url`, and so is an address with a user name in it), and one
typed without a scheme ("partiful.com/e/x") gets `https://`. A `phone` is
digits with spaces, dashes, dots, brackets or a leading `+` (3 to 20
digits), kept as typed but trimmed. A refusal about one detail says which
in `index` (from 0):

```json
{ "error": "a link is a web address, starting http:// or https://", "reason": "bad_detail_url", "index": 1 }
```

The reasons: `bad_details` (not a list), `too_many_details` (over 10),
and, with `index`, `bad_detail` (not an object), `bad_detail_type`,
`bad_detail_label`, `bad_detail_value` (missing or empty),
`bad_detail_url`, `bad_detail_phone` and `detail_too_long`.

In someone's Canopy calendar, an entry's description lists every detail
after the host's description ("Dress code: Warm layers"); everyone with
the entry is on the event.

### Duplicating an event

A host's "Duplicate" (the web has it in the host's ⋯ menu) makes a new
event like one they host: the weekly watch party, next week. An event
can't exist without a start, so it's two steps, and nothing is made
until the host saves:

1. `GET /api/v1/events/{id}/duplicate-draft` (any host who may make
   events: 403 `hosts_only` for anyone else, 403 `email_unverified` for
   an unverified account) answers with `draft`: the fields to start your
   new-event editor with. Show it as a new event, with the date and
   times empty for the host to pick.
2. On save, `POST /api/v1/events` with the draft's fields as the host
   left them, plus `startsAt` (and `endsAt` if they set one). The answer
   is the new event, as for any other.

**Copied:** title, description, place and address, time zone, details
(every one, the private ones too: you're a host), who sees the guest
list, plus-ones, capacity, the color (`themeHue`, `themeGrayscale`,
`accentHue`) and the cover.
**Not copied:** the date and times; guests, invitations and answers;
co-hosts (the one duplicating is the new event's creator and only host);
the wall; and lists. Attaching a list invites everyone on it, so it's
the host's to do: `draft.lists` is your own lists that were on the
original (`[{id, name}]`), to offer once the copy exists (`PUT
/api/v1/events/{newId}/lists/{listId}`). The web opens the new event
with its Lists… panel showing.

**The cover.** `draft.coverImageUrl` and `coverImages` are the
original's, to show in the editor (with `coverHue` and `coverGrayscale`
for a "match photo" button). Send `draft.coverFrom` (the original's id,
null when it has no cover) as `coverFrom` in the POST, and the server
copies the stored files under the new event, with its own URL: removing
or replacing either event's cover never touches the other. If the host
takes the cover off, send no `coverFrom`; if they pick another photo or
background, send no `coverFrom` and upload it after making the event, as
usual. `coverFrom` is refused, with nothing made, unless you host that
event (403 `hosts_only`), it's an event (400 `bad_cover_from`), and it
still has a cover (400 `no_cover`: another host took it off meanwhile;
say so, and send it again without).

The draft's other fields (`coverImageUrl`, `coverImages`, `coverHue`,
`coverGrayscale`, `lists`) are only for showing; the server ignores them
if you send the whole draft back.

```sh
curl -s https://events.canopysf.com/api/v1/events/4fQ9xKpL2mZa/duplicate-draft -H "Authorization: Bearer $TOKEN"
# -> {"draft": {"title": "Drag Race night", ..., "coverFrom": "4fQ9xKpL2mZa", "lists": [{"id": "Lw3Kp9QzX2aB", "name": "Drag Race"}]}}
curl -s -X POST https://events.canopysf.com/api/v1/events -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"title": "Drag Race night", ..., "coverFrom": "4fQ9xKpL2mZa", "startsAt": "2026-10-16T19:00:00-07:00"}'
# -> 201 {"event": {"id": "Zt8mR2kQ4vNc", "coverImageUrl": "https://events.canopysf.com/covers/Hn5Wq7Lp3sYd.jpg?v=…", ...}}
```

## Answering: the RSVP state machine

Your place on an event is `viewer.rsvp`: null (nothing), or one of these
statuses.

```
                 a host invites you
   (nothing) ─────────────────────────▶ invited
       │                                  │
       │ you answer                       │ you answer
       ▼                                  ▼
   going ◀──▶ maybe ◀──▶ not_going

   invited ── the host takes the invitation back ──▶ (nothing)

   anything ── a host removes you ──▶ removed ── a host undoes it ──▶ invited
```

**Answers can change, but never be withdrawn.** Once you've answered you
can switch between `going`, `maybe` and `not_going` as often as you like,
but nothing you can do takes you back to `invited` or to no answer.
`not_going` is how you leave: you stay on the list as `not_going`
(counted in `counts.notGoing`), any spot you held goes to the waitlist,
and the event drops out of your calendar.

- `PUT /api/v1/events/{id}/rsvp` with `{"status": "going"}` (or `maybe`,
  `not_going`) answers or changes the answer. Anyone signed in with the
  link may answer, invited or not.
- There's no `DELETE /api/v1/events/{id}/rsvp`: it's 404 `not_found`,
  like any unknown route.
- A host can take back an invitation (`DELETE
  /api/v1/events/{id}/invites/{personId}`) only while it has no answer.
- **Refused with 409**: a cancelled event (`event_cancelled`), one that's
  over (`event_over`), and a host answering their own event
  (`host_cannot_rsvp`; hosting is being there).
- `guests` (plus-ones): send `{"status": "going", "guests": 2}`, up to the
  event's `guestsAllowed`. More is 400 `too_many_guests`. Left out, it's
  0; with `not_going` it's always 0. See "Plus-ones".
- **`waitlisted`**: with a `capacity`, a `going` that doesn't fit is
  saved as `waitlisted`, and the answer has `"waitlisted": true`. Show
  "you're on the waitlist". See "Capacity and the waitlist".

It answers with the whole event, so the screen can redraw from the
answer, and `waitlisted`.

## Capacity and the waitlist

A host can set `capacity`: the most people going, **plus-ones included**
(`counts.total.going`). `spotsLeft` on the event is what's left (null with
no cap).

- A `going` that doesn't fit, with its plus-ones, is saved as
  `waitlisted` instead (`"waitlisted": true` in the answer).
- Someone already going who asks for more plus-ones than there's room for
  gets **409 `no_room`** and keeps their spot as it was. Asking for one
  more shouldn't cost you the one you had.
- **A freed spot goes to the waitlist at once**: someone changing to
  `maybe` or `not_going`, bringing fewer guests, being removed or made a
  co-host, or the host raising or clearing the capacity. The earliest waitlisted answer that fits, plus-ones included,
  becomes `going`; then the next, until nothing fits. A big party that
  doesn't fit is passed over for a smaller one behind it, and stays first
  in line. The person promoted gets an `off_waitlist` entry on the wall.
- **Lowering the capacity bumps nobody.** It only means new `going`
  answers wait until enough people leave.
- A cancelled event promotes nobody; when it's back on, the waitlist is
  filled.
- `maybe` isn't capped.

## Cover images

`PUT /api/v1/events/{id}/cover` (hosts) uploads one, as
`multipart/form-data` with the image in a field named `cover`: JPEG, PNG,
WebP or HEIC, up to 15 MB and 50 megapixels (**HEIC up to 25
megapixels**: the 12 and 24 megapixel photos iPhones take by default are
fine, but shrink a 48-megapixel "HEIF Max" one, or send it as a JPEG).
Send the photo as it is: the server turns it upright, shrinks it to fit
1600 px, and stores a JPEG with **no EXIF**, so where it was taken never
leaves the phone, along with narrower copies (below). `DELETE` removes it.

```bash
curl -s "${auth[@]}" -X PUT -F cover=@IMG_0001.HEIC $API/events/4fQ9xKpL2mZa/cover
```

The event's `coverImageUrl` is where it is. **Covers are public**: anyone
with that URL can load it, no sign-in, because link previews (iMessage,
Slack) fetch it without anyone's session. The URL is random and isn't the
event's link, and every upload makes a new one (the old one stops
working), so cache by URL. `null` is no cover.

**Sizes: download the one you need.** `coverImageUrl` is the full size
(up to 1600 px on its longer side), meant for link previews. To draw
the cover, use `coverImages`: every size it's stored at, all JPEG,
narrowest first, the last being the full size at `coverImageUrl`:

```json
"coverImages": [
  { "width": 400,  "height": 300,  "url": "https://events.canopysf.com/covers/Qm7Zc2pR9xTa-400.jpg?v=1759870000000" },
  { "width": 800,  "height": 600,  "url": "https://events.canopysf.com/covers/Qm7Zc2pR9xTa-800.jpg?v=1759870000000" },
  { "width": 1200, "height": 900,  "url": "https://events.canopysf.com/covers/Qm7Zc2pR9xTa-1200.jpg?v=1759870000000" },
  { "width": 1600, "height": 1200, "url": "https://events.canopysf.com/covers/Qm7Zc2pR9xTa.jpg?v=1759870000000" }
]
```

The widths are 400, 800 and 1200, those narrower than the photo, then
the photo's own (a 600 px photo has 400 and 600; a 300 px one, just
300). **iOS: pick the narrowest entry whose `width` is at least the
width you draw it at × the screen's scale** (`UIScreen.main.scale`, or
the trait collection's `displayScale`), else the last. A frame filled
aspect-fill crops a photo wider than the frame, so multiply by
max(1, (width ÷ height) ÷ (frame width ÷ frame height)) too. On a 375 pt
iPhone at 3×, the full-width hero needs 1125 px (the 1200), and a
116 pt thumbnail 348 px (the 400). Take the new URL when the frame grows
(rotation, iPad split view), not before. Like `coverImageUrl`, every URL
changes with every upload.

`coverImages` is `[]` with no cover, and also, for a little while after
a deploy, for a cover uploaded before sizes existed, while the server
makes them: use `coverImageUrl` then. The notification's event summary
has `coverImages` too.

**How the web draws it.** A frame of **3:2** (height = width × 2/3),
the photo filling it `object-fit: cover` style (centred, cropped). The
frame's top **2:1** (height = width × 1/2) is where the photo shows
clearly; the band below it (the last width × 1/6) is where it has faded
into the page's base color. The fade eases in from 45% of the frame's
height (6% at 52%, 18% at 58%, 34% at 63%, 52% at 68%, 70% at the
band's top, 84% at 82%, 94% at 90%, solid at the bottom), and the
**title starts at the top of that band**, running on below the frame.
The "how soon" pill sits low on the left inside the 2:1. Phones: edge to edge, no
rounded corners; wider: in the column, top corners rounded only. The
crop is display-only: the stored image is the whole photo. An event with
no cover gets a generated picture in the same frame (soft glows in its
colors); draw your own, or use the event's colors below.

**The color that matches the photo.** Every upload works out
`coverHue` (0–359), the hue that suits the photo, or says
`coverGrayscale: true` for an essentially grey one (then `coverHue` is
null). Both are null/false with no cover, and for covers uploaded before
this existed. **An upload never changes the event's color**
(`themeHue`, `themeGrayscale`): it's a suggestion. The web editor jumps
its color slider to it when a photo is picked and has a "Match photo"
button; nothing is saved until the host saves. Do the same in the app:
offer it, and PATCH `themeHue` (or `themeGrayscale: true`) only if the
host takes it.

How it's worked out, if you want to suggest one before uploading: shrink
the photo to fit 64×64; turn each pixel into OKLCH; skip near-greys (C <
0.04), very dark (L < 0.2) and very light (L > 0.93) pixels; add each
other pixel's chroma C into its hue's one-degree bin (360 bins); find
the bin whose ±12° window has the most; the answer is the
chroma-weighted circular mean of the bins in that window, rounded. If
fewer than 4% of the pixels counted, the photo is grey. The code is
`hueFromPixels` in `public/ui.js`.

## Backgrounds (from TMDB)

Instead of uploading a photo, a host can choose one of a curated set of
film and TV backdrops from TMDB (The Movie Database). Choosing one makes
it the cover exactly as an upload would, and from then on it's an
ordinary cover.

`GET /api/v1/backgrounds` (signed in) is the set:

```json
{
  "enabled": true,
  "backgrounds": [
    {
      "id": "L2NnRlY3NjF3eE50UHhmVnNFVlNBTTV4RWtjRy5qcGc",
      "title": "Mean Girls",
      "year": null,
      "thumbUrl": "https://image.tmdb.org/t/p/w300/cgFV761wxNtPxfVsEVSAM5xEkcG.jpg",
      "previewUrl": "https://image.tmdb.org/t/p/w780/cgFV761wxNtPxfVsEVSAM5xEkcG.jpg",
      "width": 300,
      "height": 169,
      "hue": 35,
      "grayscale": false
    }
  ]
}
```

- **`enabled: false`** (and no backgrounds): the feature is off, or
  nothing has loaded yet. Show no picker, and nothing else changes.
- **Order and groups.** They come in display order, with a title's
  backgrounds next to each other: group consecutive entries with the
  same `title` and `year`, and show the title small under each group
  (the web does).
- **Images.** Load `thumbUrl` (300 px wide) straight from TMDB's public
  image CDN for the grid, and `previewUrl` (780 px) as the hero while
  the host decides. `width` × `height` is the thumbnail's size (its
  shape: they're 16:9 or close). The web shows them in 3:2 tiles,
  `object-fit: cover`.
- **The color.** `hue` (0–359, or null with `grayscale: true`) is the
  hue that matches it, worked out on the server the same way as
  `coverHue`. When the host picks one, jump your color control there,
  as for a photo just picked; nothing changes until they save.
- **Caching.** The set changes at most once a day. This is the one
  answer that says `Cache-Control: private, max-age=3600`.
- **Attribution (TMDB's terms).** Wherever you show the backgrounds,
  show TMDB's logo and "This product uses the TMDB API but is not
  endorsed or certified by TMDB." The web has it at the foot of the
  picker and, small, at the foot of Your Events. Logos:
  themoviedb.org/about/logos-attribution.

`PUT /api/v1/events/{id}/cover/background` (hosts) chooses one:

```bash
curl -s "${auth[@]}" -X PUT -H 'Content-Type: application/json' \
  -d '{"backgroundId":"L2NnRlY3NjF3eE50UHhmVnNFVlNBTTV4RWtjRy5qcGc"}' \
  $API/events/4fQ9xKpL2mZa/cover/background
```

It answers exactly as the upload does (`{"event": ...}` with the new
`coverImageUrl`, `coverImages`, `coverHue`), under the same daily limit
(uploads and backgrounds count together). The server downloads TMDB's
full-size image and runs it through the upload's pipeline, so the cover
is served from here, not TMDB. **The `id` is opaque**: send back one the
list gave you. One that isn't in the current set (the set changed, or
the feature is off) is 400 `bad_background`: fetch the list again. If
TMDB doesn't answer, it's 502 `background_unreachable`: try again in a
minute. For a new event, make the event first, then choose (the web
remembers the choice and sends it right after the event is made, as it
does a picked photo).

## Event colors

Every event has two fields for its color:

- `themeHue`: the hue, in degrees (0–359), its page's background is
  turned to, or `null` for Canopy's own green, which is the default.
- `themeGrayscale`: `true` for **no color at all**, a neutral grey page.
  While it's true, `themeHue` is ignored (and kept, so turning grey off
  goes back to it).

Any host sets them, co-hosts included, on `POST /events` or `PATCH
/events/{id}` (400 `bad_theme_hue` for a hue outside 0–359 or not a
whole number, `bad_theme_grayscale` for anything but true or false).
They're on every event, signed out too, since the page a guest opens from
a text is drawn in them. The web's slider is grey at its left end, then
the wheel; an event nobody has colored sits on Canopy green's hue.

The background is the dark Canopy mesh: a base color with five soft
glows, and cards of 30% tinted glass over it. Each color is defined in
**OKLCH** (lightness, chroma, hue). For a `themeHue` of *H*, each
color keeps its lightness and chroma and takes the hue *H + offset*:

| Color | Role | L | C | hue offset | Today's green |
|---|---|---|---|---|---|
| base | the page behind everything | 0.1652 | 0.0266 | +6.4 | `#03120c` |
| glow 1 | top left (12% 18%, to 50%) | 0.3655 | 0.0715 | +1.4 | `#0f4a33` |
| glow 2 | top right (88% 8%, to 45%) | 0.3166 | 0.0559 | +9.8 | `#0a3b2e` |
| glow 3 | the brightest, lower right (72% 78%, to 50%) | 0.4233 | 0.0856 | −0.4 | `#145c3e` |
| glow 4 | lower left (18% 88%, to 55%) | 0.2597 | 0.0466 | +5.8 | `#072b1f` |
| glow 5 | the middle (50% 45%, to 60%) | 0.3122 | 0.0590 | +1.9 | `#0c3a28` |
| card | glass tint, at 30% opacity | 0.2150 | 0.0537 | −11.2 | `#03200b` |

**Grey** (`themeGrayscale: true`): the same lightness L, chroma 0. Every
color becomes a neutral grey exactly as light as its green, so contrast
is the same as for any hue.

Hues wrap at 360. Convert with the standard OKLCH → OKLab → linear sRGB
→ sRGB maths (Björn Ottosson's matrices, as in CSS Color 4). If a
color falls outside sRGB, **lower its chroma** (keep L and hue) until
it fits; at these lightnesses that only happens to the card tint near
yellow. Canopy green is hue **161**: `null` means "use the hex column
exactly", and 161 comes out within 2/255 of it.

Because only the hue turns, every hue is as dark as the green, so white
and light text keep their contrast over it (round the whole wheel, white
on a card over the brightest glow stays at least 9.3:1). The web's code
for all of this is `public/ui.js` (`themeColors`, `themeStyle`).

**The accent** (the main buttons, the "how soon" pill, the photo ring,
icons, links) is a trio for a hue *H* (`accentTrio` in `public/ui.js`):

- **the accent:** OKLCH at hue *H*, chroma 0.21 (lowered to fit sRGB), at
  the lightness *L* where hue *H* is most vivid (the L, in steps of 0.01
  from 0.50 to 0.90, with the largest in-gamut chroma), clamped to at
  least the lightness that keeps the dark text below at 5:1 on it (steps
  of 0.005 from 0.55) and at most 0.80. Red's vivid lightness is low and
  yellow's and cyan's high, so every hue gets its truest accent: red is
  red, not coral or pink;
- **text and icons on it:** `#03190a`'s L and C at hue *H*;
- **links:** `#b6f5c3`'s L and C at hue *H*.

Worst over the wheel: dark text on the accent 5.0:1, links on the base
14.5:1. Canopy green itself (no `themeHue`) keeps `#2ec44f` / `#03190a` /
`#b6f5c3` exactly. Port it line for line and test against the web's own
output (e.g. hue 0 → `#ed458a`, 30 → `#f14634`, 250 → `#0095fe`, 300 →
`#a264f6`).

- **A colored event** (`themeGrayscale` false): the accent is the trio
  turned to `themeHue` (or the trio as it is, for Canopy green).
  `accentHue` is always null on these.
- **A grey event** (`themeGrayscale` true): the accent is never grey
  (grey buttons look disabled). It's `accentHue`:
  - `null` (the default): **white**. The accent is `#ffffff`, text and
    icons on it are the grey page's base (`#0e0e0e`, 19.3:1), and links
    are white too, so set them apart from body text by weight (bold) and
    a thicker underline (the web: 700 and 2px).
  - a hue *A* (0–359): the trio for *A* (above), the same colors a page
    in hue *A* has, on the grey background. Worst over the wheel: dark
    text on the accent 5.0:1, links on the grey base 14.5:1.

  The background, the cards and the status bar stay grey either way.

Any host sets `accentHue` on `POST /events` or `PATCH /events/{id}`:
400 `bad_accent_hue` for anything but null or a whole 0–359, 400
`accent_needs_grayscale` for a hue on an event that isn't (and isn't
being made) grey. Setting `themeGrayscale` to false clears `accentHue` in
the same change; turning grey on again starts from white. The web's
editor shows a second slider, **Accent** (white at its left end, then the
wheel), only while the color slider is in its grey stretch.

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

`invited` (invited, no answer yet) is **for hosts only**: it's null for
everyone else, signed out included, the same way only hosts see who's
invited on the guest list.

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

`GET /api/v1/events/{id}/guests` (signed in). **Counts are always there**
(`invited` only for hosts, null for anyone else).
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

## The activity wall

`GET /api/v1/events/{id}/wall` is the event's wall, newest first, a page
at a time. It has two kinds of entry:

- **posts**: `type: "post"`, with `text` and the author in `person`;
- **the server's own entries**, when something happens. They're typed,
  not written out, so the app words them (and can translate them):

| `type` | Say something like | `person` | `details` |
|---|---|---|---|
| `going` | "Ana is going" | Ana | null |
| `off_waitlist` | "Ana got a spot" | Ana | null |
| `time_changed` | "Ana moved it to Sat 8pm" | the host | new `startsAt`, `endsAt`, `timeZone` |
| `place_changed` | "Ana moved it to The park" | the host | new `locationName`, `locationAddress` |
| `cancelled` | "Ana cancelled the event" | the host | null |
| `uncancelled` | "It's back on" | the host | null |
| `cohost_added` | "Ben is co-hosting" | the new co-host | null |

Show nothing for a type you don't know: more will come. A person has at
most one `going` (or `off_waitlist`) entry, and it disappears when they
stop going, so the wall never says someone's coming who isn't.

**Who reads it**: whoever can see the guest list's names
(`viewer.canSeeGuestList`), because it's full of them. Anyone else signed
in gets `wallVisible: false` and no entries, like the guest list.

**Who posts** (`POST` with `{"text": "…"}`, `viewer.canPost` and the
wall's `canPost` say in advance): hosts, and anyone whose answer is
`going`, `maybe` or `waitlisted`. Invited-and-silent and `not_going` can
read but not post (403 `answer_first`). Posts are plain text, 1 to 1,000
characters; it's never HTML, so escape it. A cancelled or finished event
still takes posts. 5 posts a minute, 100 a day per person.

**Who deletes** (`DELETE /api/v1/events/{id}/wall/{entryId}`): you, your
own posts; hosts, anything, the server's entries included. `canDelete` on
each entry says which.

## The guest menu: mute, leave, opt out

A guest (invited, or with any answer, and not hosting) gets a ⋯ menu on
the web, on their answer card's heading line. The app can offer the same
three things. Hosts get 409 `is_host` from all of them except opting
out; someone not on the event gets 409 `not_on_event`; someone a host
removed gets 409 `removed`.

**Mute**: `PUT /api/v1/events/{id}/mute`, undone by `DELETE` (always
fine). `viewer.muted` says whether you have. While muted, your inbox and
pushes skip the event's chatter (`wall_post`, `rsvp`, `cohost_added`)
and still bring the essentials (`event_changed`, `event_cancelled`,
`event_uncancelled`, `waitlist_promoted`, `invited`). Nothing changes on
the guest list, and nobody else can tell. A host is never muted (if a
muted guest is made a co-host, they hear everything a host does). Both
answer `{event}`.

**Leave**: `POST /api/v1/events/{id}/leave`, after asking ("Remove
yourself from this event?"). It can't be undone: your invitation or
answer is deleted (you're off the guest list and its counts, out of your
lists and your calendar), your "going" leaves the wall, your
notifications about the event are deleted, and so is your mute. A spot
you held goes to the waitlist. Your posts stay. It isn't a host's
removal: the link still works and you can answer again, as anyone
opening it could. It answers `{event}` as you now see it (`viewer.rsvp`
null). An answer is otherwise never taken back, so this is the way off
an event; a co-host steps down instead (`DELETE
.../cohosts/{personId}`).

**Opt out of a host's invitations**: `PUT
/api/v1/me/invite-optouts/{personId}`, undone by `DELETE` (both always
fine; 409 `is_you` for yourself, 404 `person_not_found` for an id with
no account). `GET /api/v1/me/invite-optouts` is `{hosts: [Person]}`,
oldest first, only ever yours. From then on that person's invitations to
you are skipped, and **deliberately, they aren't told why**: their
`POST .../invites` answer lists you in `skipped` with `not_found`, the
same as an id with no account (or, if you're already on that event,
`already_on_list`, which is what anyone would get). Their invitations
make no friendship either. It doesn't take you off any event you're on.
The web offers one item per host of the event ("Opt out of invites from
Ana"; "Allow invites from Ana" once you have), and lists them on the
friends page with Undo; the app's Profile can do the same.

## Host moderation

**Removing someone** (`PUT /api/v1/events/{id}/removed/{personId}`, any
host): their status becomes `removed`.

- They can't answer again (409 `removed`) or post, and can't be invited
  (`skipped` with `removed`).
- They're off the guest list and its counts for everyone. A host sees
  them only by asking: `GET /guests?status=removed`.
- Their "going" leaves the wall and their posts are hidden. A spot they
  held goes to the waitlist.
- **They can still open the link**, and see exactly what someone signed
  out sees (no address, no guest list, no wall, no friends going), with
  `viewer.rsvp.status: "removed"` so the app can say so. The link is the
  event, and hiding it from them alone would hide nothing: they could
  sign out and look. If that's not enough, make a new link (below).
- Nobody is notified, and their own notifications about the event are
  deleted (so their inbox can't hand them a new link).
- You can remove someone before they've answered, or been invited.

`DELETE /api/v1/events/{id}/removed/{personId}` undoes it: they're left
**invited**, so the event is back in their invitations and they can
answer.

**Making a new link** (`POST /api/v1/events/{id}/new-link`, the creator
only) is for a link that got out. The event gets a new `id` and `url`;
the old id answers 404 `event_not_found` at once, exactly like a link
that never existed. Everything else stays: the hosts, every answer, the
wall, the cover, the waitlist, and the event's place in everyone's lists
(where it now has its new id). Nobody is notified, so the host shares the
new link with whoever should have it. An app holding an event id it gets
a 404 for should drop it and refresh its lists.

## Notifications and push

Push is how people hear about things (there's no email or text). Every
push also lands in the person's **inbox**, `GET /api/v1/me/notifications`,
so an app that missed one, or was offline, catches up there.

**Register the phone** after sign-in, and again whenever iOS or Android
hands you a new token:

```bash
curl -s "${auth[@]}" -H 'Content-Type: application/json' -X POST $API/me/devices \
  -d '{"platform": "ios", "token": "5f2a9c0e…"}'
```

`platform` is `ios` (an APNs device token, hex) or `android` (an FCM
registration token). Registering again is fine. A token is one phone: if
someone else signs in on it and registers it, it's theirs from then on.
Up to 10 phones each. On sign-out, `DELETE /api/v1/me/devices` with
`{"token": "…"}` in the body.

**The real push senders aren't built yet** (they need the APNs and FCM
keys, which come with the apps). Until then the server logs each push
instead of sending it. Everything else (the inbox, registration, who gets
what) is real, so build against it.

**Notifications are typed, not sentences.** Each has a `type`, the
`actor` (a `Person`, or null), the `event` (a short summary with `id`,
`title`, `startsAt`, `timeZone`, `status`, `coverImageUrl`,
`coverImages`), `details`,
and `count`. Word them in the app:

| `type` | Say something like | Who gets it |
|---|---|---|
| `invited` | "Ana invited you to Rooftop dinner" | the person invited |
| `event_changed` | "Ana changed the time and place" (`details.changed`: `time`, `place`) | everyone going, maybe or waitlisted, and the other hosts |
| `event_cancelled` | "Rooftop dinner is cancelled" | the same |
| `event_uncancelled` | "Rooftop dinner is back on" | the same |
| `cohost_added` | "Ana made you a co-host" | the new co-host |
| `waitlist_promoted` | "You got a spot! You're going" | whoever got it |
| `wall_post` | "Ana posted: Parking is round the back…" (`details.text`, the first 200 characters; `details.entryId`) | everyone going, maybe or waitlisted, and the other hosts, when a host posts |
| `rsvp` | "Ben and 3 others answered" (`count`; `actor` and `details.status` are the latest) | the hosts |

- **Nobody is notified of their own doing.** A host who moves the event
  isn't told it moved.
- **Answers to your event fold together** while unread: the next answer
  updates the unread `rsvp` notification (`count` goes up, `actor` is the
  newest, it moves to the top) instead of making another, and only the
  first one of a batch pushes. Once it's read, the next answer starts a
  new one. A change of plus-ones alone isn't news.
- **`event` can be null**: once you're no longer on the event (a host
  took your invitation back or removed you, or you took back an answer
  you gave without being invited), the inbox stops giving you its link,
  because a host may have made a new one to keep you out. Show the line
  without a way to open it. Being removed or uninvited also deletes your
  notifications about that event.
- The push carries the same `type`, the notification's id, the event's id
  and title, and `badge` (the unread count). The senders will turn it into
  a localized alert (`loc-key` and its arguments) for the app to word.
- Skip a type you don't know: more will come.

The inbox is newest first (by when the latest thing in each happened),
with `unreadCount`. `GET /api/v1/me/notifications/unread` is just the
count, for the badge. `POST /api/v1/me/notifications/read` with
`{"ids": [...]}` (up to 100) marks some read, and
`POST /api/v1/me/notifications/read-all` marks the lot. Both answer with
the unread count.

## Friends and invitations

**Your friends are the people in your list.** It's one way, like
following: having someone in your list doesn't put you in theirs, adding
someone needs no OK from them, and nobody is told they were added. Only
you ever see your list. Someone is in it when:

- **you were both at an event** (`source: "shared_events"`): hosting it,
  or answering `going`, on an event that has started and wasn't
  cancelled. `maybe` doesn't count, and an event still to come doesn't
  either. Nothing to do; it's worked out.
- **you added them** (`"added"`), by id, usually after finding them by
  phone or Instagram (below). Verified people only.
- **a friend link** (`"link"`): you said yes to theirs, or they said yes
  to yours. That one is **both ways**: sharing your link is saying yes in
  advance.
- **an invitation** (`"invite"`): a host invites you, or you invite
  someone. Both ways too, and hosts and co-hosts count alike. Taking the
  invitation back leaves the friendship.

`GET /api/v1/me/friends` lists yours: most events in common first, then
the people you only added. Each is `{person, source, eventsInCommon,
lastTogetherAt}`. When someone is in your list both ways (a link, and
events together), `source` is the way in, and `eventsInCommon` still
counts the events. **`eventsInCommon` can be 0 and `lastTogetherAt` can be
null** (someone you added and haven't been to anything with): decode it as
optional. "Friends going" on an event and the invite picker use the same
list.

**Taking someone out**: `DELETE /api/v1/me/friends/{personId}`, whatever
way they're in it. They stay out (another event together, or them
inviting you, doesn't bring them back) until you add them again yourself:
by id, by their link, or by inviting them. They aren't told, and their
own list is untouched. 404 `not_a_friend` if they weren't in it. Ask
first; it's quiet but it sticks.

**Adding by id**: `POST /api/v1/me/friends` with `{"personId": "…"}`
answers `{"friend": {...}}`. Already in your list changes nothing.
Verified only (403 `email_unverified`, with `verify`), 404
`person_not_found`, 409 `is_you`, and limited (429 `rate_limited`).

**Your friend link** is `GET /api/v1/me/friend-link`:

```json
{ "url": "https://events.canopysf.com/f/7Hq2mXc9LpRt", "code": "7Hq2mXc9LpRt" }
```

Made the first time you ask; the same after that. Share `url`, and show
it as a **QR code whose text is exactly `url`** (on iOS,
`CIFilter.qrCodeGenerator()` with the URL's UTF-8 bytes, correction level
`M`; scale it up with nearest-neighbour, no smoothing, and keep a white
margin of four modules round it). Quick (unverified) accounts have a link
too. `POST /api/v1/me/friend-link/reset` makes a new one; the old one
stops working at once, and friends made with it stay friends.

**Opening someone's link** (the app should claim `/f/<code>` as a
universal link, and the camera opens the QR code's URL in it):

1. `GET /api/v1/friend-links/{code}` is the owner, `{person, viewer}`,
   for anyone, signed in or not. `viewer` is null signed out, or
   `{isYou, isFriend}`. 404 `friend_link_not_found` for a wrong or reset
   code. **Opening adds nobody.**
2. Show who it is and ask: "Add Ana Lima as a friend?" Your own link
   (`isYou`): say so. `isFriend`: say you're already friends.
3. On yes, `POST /api/v1/friend-links/{code}/accept` answers
   `{"friend": {...}}` (the owner, as your friend). 409 `own_link` for your
   own. Anyone signed in can, quick accounts included. Signed out, the 401
   has `signIn` and `quickSignUp` coming back to `/f/<code>`.

A host invites with `POST /api/v1/events/{id}/invites` and
`{"personIds": [...]}` (1 to 100). Offer friends in the app; the API takes
any Canopy person id, so the lookup below feeds straight into it.

**Finding someone by phone or Instagram**:
`POST /api/v1/people/lookup` with `{"phone": "(415) 555-1234"}` or
`{"instagram": "@ana.lima"}`, exactly one of them, as typed, as a string.
It's a POST so the number never sits in a URL (URLs end up in logs; don't
log the body in the app either). It
answers `{"person": {...}}` (the public `Person`, never the number or
handle asked about) or `{"person": null}`, with no hint why. Matches are
exact, never by prefix, and only find people who let themselves be found.
Verified people only. It's tightly limited (429 `rate_limited`), per
person, per network address and overall, so look up when they press
"find", never as they type. 400 `bad_phone` or `bad_instagram` is a form
error to show; 403 `lookup_not_allowed` means it isn't switched on. Each id comes back in `invited`, or in `skipped` with a
reason: `already_on_list`, `is_host`, `not_found` or `removed`. 300
invitations per host a day.

**Who to suggest first when inviting**: `GET /api/v1/me/friends/suggested`
(`?limit=` 1 to 50, 10 by default) is your friends with a `score`, best
first, not paginated. Each event you were both at (the friends rule:
hosting or `going`, started, not cancelled) adds `2^(-d/90)`, where `d` is
the days since it started, so an event three months ago counts half as
much as one today; **an event you hosted counts double** (its guests are
the people you invite back). A way into your list other than events adds a
little, fading the same way from when it was made: an invitation (either
way) 0.5, a friend link or adding by id 0.25. Only friends with a score
above 0 are in it; ties go to whoever you were with last, then by id.

**An invite picker, the way the web's works** (the sheet over an event
page, public/ui.js `inviteSheet`), from calls that already exist:

1. One search box. A name filters what's loaded (friends, the people on
   your lists, anyone picked from a past event), accents aside. When the
   text is a whole phone number (10 to 15 digits, with `+ ( ) - .` and
   spaces) or an `@username`, look it up (`POST /api/v1/people/lookup`,
   once they stop typing, each text once) and offer the person first.
   Never look up a name: the lookup is tightly limited.
2. Your lists (`GET /api/v1/me/lists`, then each one's `.../members`),
   each with "Invite all <n>", `n` being its people not on the event yet.
   Picking them isn't attaching the list (`PUT .../lists/{listId}` is
   that, from the host's "Lists…").
3. "Invite everyone from…" one of `GET /api/v1/me/events/past`: its hosts
   and its `going` and `maybe` guests (`GET .../guests?status=going`, and
   `maybe`), which the guest list's own visibility rule already limits.
4. Suggested: the first eight of `GET /api/v1/me/friends/suggested?limit=30`
   who aren't on the event. Then everyone else A to Z.
5. Everyone already on the event (its `hosts`, and `GET .../guests` plus
   `?status=removed` for a host) stays in the list, greyed, with their
   status, and can't be picked.
6. Send the picked with `POST .../invites`, 100 at a time.

## Lists

A list is **one person's own list of people**, who joined it themselves
by its link or QR code or whom the owner added, for inviting them all at
once. The case it's for:
someone hosts a weekly night, shows the list's QR code at the door,
newcomers join, and they're invited to the next one without the host
remembering them.

**Privacy.** Only the owner ever sees who's on a list (as `Person`, with
when they joined) and how many. A member sees the list's name, its owner
and that they're on it, never anyone else on it, nor a count. Anyone else
sees nothing, except through a link: the name and the owner.

**Yours** (verified people only, like making events):

| Call | What |
|---|---|
| `GET /api/v1/me/lists` | yours, oldest first: `{id, name, code, url, memberCount, createdAt}`, at most 50, not paginated |
| `POST /api/v1/me/lists` `{name}` | 201 `{list}`. 1 to 60 characters (400 `bad_name`); 409 `too_many_lists`; 429 |
| `PATCH /api/v1/me/lists/{listId}` `{name}` | rename |
| `DELETE /api/v1/me/lists/{listId}` | gone, with its members and its place on events; invitations it made stay |
| `POST /api/v1/me/lists/{listId}/reset-link` | a new `code` and `url`; the old link stops working; members stay |
| `GET /api/v1/me/lists/{listId}/members` | `{members: [{person, joinedAt, source}], nextCursor}`, newest first, paginated; `source` is `link` (joined) or `added` (you added them) |
| `POST /api/v1/me/lists/{listId}/members` `{personIds}` | add people (below): `{added, alreadyOn, skipped, invitedTo, list}` |
| `DELETE /api/v1/me/lists/{listId}/members/{personId}` | take someone off (404 `not_a_member`); they aren't told |

Someone else's list, or none, is always 404 `list_not_found`: whether it
exists is its owner's business. `id` is for the API only; `url`
(`https://events.canopysf.com/l/<code>`) is what's shared, and the text of
its QR code (drawn exactly like the friend link's, above).

**Adding people** (`POST /api/v1/me/lists/{listId}/members`,
`{personIds: [...]}`, 1 to 100 a request). The owner may add **the same
people they could invite** to an event: any Canopy Account, friends or
not (from the invite picker's sources, below). Each id comes back in
`added` (a `Person`), `alreadyOn` (nothing changes), or `skipped` with
`is_you` or `not_found`; `not_found` is also how someone who opted out of
your invitations is skipped, so the answer never says who did. **Being
added is the same as joining**: in the same step they're invited, by you,
to every event the list is on that isn't over or cancelled, with the
usual `invited` notification; `invitedTo` counts those events, for "Added
5 people. Invited them to 1 event." There's no other notification: the
list appears in their `list-memberships`, where they can leave it. All or
nothing at 1,000 people (409 `list_full`); 300 people added a day (429).
`list` is the list with its new `memberCount`. A picker for it is the
invite picker below with the list's members greyed ("On list") instead of
the event's guests, and "Add 5" for "Invite 5".

**Ones you're on**: `GET /api/v1/me/list-memberships` is `{lists: [{id,
name, owner, joinedAt}]}`, newest first; `DELETE
/api/v1/me/list-memberships/{listId}` leaves (404 `not_a_member`). The
owner isn't told.

**Joining** (claim `/l/<code>` as a universal link, as with `/f/`):

1. `GET /api/v1/list-links/{code}` is `{list: {name}, owner, viewer}` for
   anyone, signed in or not; `viewer` is null signed out, or `{isOwner,
   isMember}`. 404 `list_link_not_found` for a wrong or reset code
   (misses are limited per address). **Opening it joins nobody.**
2. Ask: "Join Ana's Drag Race? Ana will be able to invite you to events."
   (`isOwner`: say it's theirs; `isMember`: say they're on it.)
3. On yes, `POST /api/v1/list-links/{code}/join` answers `{list, invitedTo}`.
   `list` is the membership (as above); `invitedTo` is how many events
   they were just invited to (below). 409 `own_list` for your own,
   `list_full` at 1,000 people; 429 like adding friends. Quick accounts
   can join. Signed out, the 401's links come back to `/l/<code>`.

**Joining makes no friends by itself.** The owner and a member become
friends the way everyone does: the owner's invitation (both ways), or an
event together.

**On events.** A host puts one of their own lists on an event with `PUT
/api/v1/events/{id}/lists/{listId}` (co-hosts too, each with their own
lists; anyone else's is 404 `list_not_found`). That **invites everyone on
it**, by the list's owner, by the same rules as `POST .../invites`:
anyone who opted out of the owner's invitations is skipped without a word,
and so are the event's hosts and anyone a host removed. It answers
`{event, invitedCount}`. From then on, **anyone who joins the list is
invited too**, in the same step, with the usual `invited` notification,
until the event is over or cancelled (an event happening now counts). Up
to 10 lists on an event (409 `too_many_lists`); 409 `event_over` or
`event_cancelled` for those. List invitations don't count against the
daily invitation limit: everyone on a list asked to be. `DELETE` takes it
off (its owner, or the event's creator; another co-host gets 403
`not_your_list`); nobody's invitation changes. A co-host's lists come off
an event when they stop hosting it.

**On the event's answer** (`GET /api/v1/events/{id}`, and every answer
about one event, never lists of events):

- `hostLists`: to hosts, every list on it, `{id, name, code, url, owner,
  isYours, memberCount, attachedAt}`, in the order they were put on;
  `memberCount` is null for a co-host's list. Null for anyone else. Use
  `url` for a big QR code at the door.
- `joinableList`: `{code, name, url, owner}`, a list on the event the
  viewer isn't on and could join, for a "Get invited next time" card with
  "Join Drag Race". Signed out too (send them to `url`); null for hosts,
  for someone a host removed, and when they're on every list. With
  several, the creator's first, then the one put on first. Joining from
  the event is the same `POST /api/v1/list-links/{code}/join`.

## Your events

Six lists, each a page at a time:

| | What's in it | Order |
|---|---|---|
| `GET /api/v1/me/events/hosting` | events you host that aren't over, cancelled included | soonest first |
| `GET /api/v1/me/events/upcoming` | not over, and you said `going` or `maybe` (or are waitlisted); cancelled stay, so they show as off | soonest first |
| `GET /api/v1/me/events/invitations` | invited, no answer yet, not over, not cancelled | soonest first |
| `GET /api/v1/me/events/declined` | you said `not_going`, not over, not cancelled (so you can change your mind) | soonest first |
| `GET /api/v1/me/events/all` | `hosting`, `upcoming` and `invitations` together, each event once (the web's All tab); cancelled stay if you host them or said you'd come | soonest first |
| `GET /api/v1/me/events/past` | over, and you hosted or said `going` or `maybe` | most recent first |

Each item is a whole `Event` as you see it (with `viewer`), minus
`friendsGoing`, which is only on a single event.

### Status colors

The web shows your part in an event (from `viewer`: `canEdit` is
hosting, otherwise `viewer.rsvp.status`) as a colored badge on every
card, and the same badge wherever it shows someone's status (inviting,
co-hosts). The colors are fixed: they never follow the event's theme or
accent, so blue means hosting on every card. Apps should use the same
ones. Text is dark on the light pill (public/events.css, `--status-*`):

| Status | Badge text | Pill | Text | Contrast |
|---|---|---|---|---|
| hosting (co-hosting too) | Hosting | `#6CB4FF` | `#03122A` | 8.55:1 |
| `going` | Going | `#2EC44F` | `#03190A` | 7.95:1 |
| `maybe` | Maybe | `#F2C94C` | `#1F1600` | 11.28:1 |
| `waitlisted` | On the waitlist | `#FF8A3D` | `#2A1100` | 7.60:1 |
| `invited` | Invited | `#C4CCC7` | `#121815` | 10.97:1 |

`not_going` and `removed` are plain glass, not colored. A cancelled
event keeps its status badge and adds "Cancelled".

### In their phone's calendar

Not from here. Each person's **Canopy calendar** is one link from the
account service (`GET /api/native/v1/me/calendar`, see its
`docs/native-api.md`), which a calendar app subscribes to, with events
they host, co-host or answered `going` (confirmed), `maybe` or are
waitlisted for (tentative), invitations they haven't answered
(tentative, titled `[INVITED] <title>`), and cancelled ones they were on.
Answering an invitation updates that same entry. The account
service gets events' part of it from `GET /api/calendar/{personId}`,
which is in `openapi.yaml` under **Site to site**: it's signed by the
account service, and an app can't call it.

### Settings

`GET /api/v1/me/settings` is `{"calendarInvites": true}`: your settings,
each at its default until changed. `PATCH /api/v1/me/settings` with only
the ones to change (`{"calendarInvites": false}`) answers the settings
after. A setting it doesn't know is 400 `unknown_setting`, a value of
the wrong type 400 `bad_calendar_invites`, and nothing changes on a 400.

- **`calendarInvites`** (default `true`): events you're invited to and
  haven't answered are in your Canopy calendar, tentative, titled
  `[INVITED] <title>`, the description starting "You're invited. Answer
  here: <link>". The Profile's toggle, "Show events I'm invited to". Off,
  they're left out (cancelled ones too). Calendar apps pick a change up
  when they next refresh the feed, which can take hours; say nothing
  about timing in the app.

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
| 400 | `bad_json`, `bad_title`, `bad_starts_at`, `bad_ends_at`, `ends_before_start`, `bad_time_zone`, `bad_guest_list_visibility`, `bad_description`, `bad_location_name`, `bad_location_address`, `bad_coordinates`, `bad_apple_place_id`, `bad_near`, `bad_query`, `bad_status`, `bad_guests`, `too_many_guests`, `bad_guests_allowed`, `bad_person_ids`, `bad_person_id`, `bad_name`, `bad_text`, `bad_capacity`, `bad_theme_hue`, `bad_theme_grayscale`, `bad_accent_hue`, `accent_needs_grayscale`, `bad_details`, `too_many_details`, `bad_detail`, `bad_detail_type`, `bad_detail_label`, `bad_detail_value`, `bad_detail_url`, `bad_detail_phone`, `detail_too_long` (with `index`), `bad_image`, `bad_background`, `bad_ids`, `bad_platform`, `bad_token`, `one_of`, `bad_phone`, `bad_instagram`, `bad_cursor`, `bad_limit`, `bad_request` | fix the request; most are form errors to show (`bad_request`: the request couldn't be read at all, like a URL with a broken `%` escape) |
| 401 | `sign_in_required` | sign in (`signIn`) or quick-sign-up (`quickSignUp`) |
| 403 | `email_unverified` | with `verify`: send them there. Without: the person they picked to co-host isn't known to be verified |
| 403 | `hosts_only` | hide the control: `viewer.canEdit` says who's a host |
| 403 | `creator_only` | hide the control: `viewer.role` is `creator` for the one person who can |
| 403 | `answer_first` | posting on the wall before answering going or maybe: `viewer.canPost` |
| 403 | `not_yours` | deleting someone else's post: `canDelete` |
| 403 | `not_your_list` | taking another co-host's list off an event: only its owner or the creator can (`hostLists[].isYours`) |
| 403 | `lookup_not_allowed` | finding people isn't switched on for this site: hide the search |
| 403 | `bad_origin` | a web page's problem; apps never see it |
| 404 | `event_not_found`, `not_invited`, `person_not_found`, `not_cohost`, `entry_not_found`, `not_removed`, `not_found` | the link is wrong, or it's gone (or the host made a new one) |
| 404 | `friend_link_not_found`, `not_a_friend` | the friend link is wrong or was reset; they weren't in your list |
| 404 | `list_not_found`, `list_link_not_found`, `not_a_member` | not a list of yours (or gone); the list link is wrong or was reset; they (or you) aren't on it |
| 404 | `place_not_found` | that place id isn't a suggestion's, or Apple no longer finds it |
| 409 | `event_cancelled`, `event_over`, `host_cannot_rsvp`, `already_responded`, `is_creator`, `too_many_cohosts`, `no_room`, `removed`, `is_host`, `not_on_event` | redraw from the event |
| 409 | `is_you`, `own_link` | adding yourself, or saying yes to your own friend link |
| 409 | `own_list`, `list_full`, `too_many_lists` | joining your own list; a list at 1,000 people; more than 50 lists, or more than 10 on one event |
| 413 | `too_large` | the body is over 100 KB (an image, 15 MB) |
| 429 | `rate_limited` | try again later |
| 502 | `background_unreachable` | TMDB didn't give the background just now; retry in a minute |
| 502 | `places_unavailable` | Apple Maps couldn't be asked (or isn't set up): let the host type the place |
| 503 | `accounts_unreachable` | Canopy Accounts is down; retry in a minute |
| 500 | `server_error` | our bug; retry once, then tell us |

## Limits

| What | Per person | Per address | Everyone |
|---|---|---|---|
| Making events | 20 a day | 60 a day | 1,000 a day |
| Invitations (each person invited counts one) | 300 a day | 600 a day | 5,000 a day |
| Invitations in one request | 100 | | |
| Wall posts | 5 a minute, 100 a day | 20 a minute, 300 a day | 300 a minute, 5,000 a day |
| Cover uploads (and backgrounds chosen, counted together) | 30 a day | 100 a day | 2,000 a day |
| Adding friends (by id, or saying yes to a link; every try counts) | 200 a day | 500 a day | 5,000 a day |
| Friend links that find nobody | | 60 an hour | |
| Making lists | 20 a day (50 in all) | 60 a day | 1,000 a day |
| Joining lists (every try counts) | 200 a day | 500 a day | 5,000 a day |
| Adding people to your lists (each person added counts one; 100 in one request) | 300 a day | 600 a day | 5,000 a day |
| List links that find nothing | | 60 an hour | |
| Place suggestions and places (together) | 120 a minute | | |

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
