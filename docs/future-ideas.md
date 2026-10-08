# Future ideas

Things we've thought through but aren't building yet. Each one says what
it would take and what's awkward about it, so the thinking doesn't have
to be redone. Nothing here is decided. Decided things go in
`decisions.md`, and the calls made along the way go in
`decision-log.md`.

## Proving someone owns their Instagram handle

**Why:** a phone number or handle on a Canopy profile is self-reported.
Lookup by Instagram finds unverified accounts (on purpose, because most
people on a new network never confirm their email). So someone can
claim a handle that isn't theirs, along with that person's name, and
be the one a host finds and invites. Contested handles find nobody, so
this only works while the real owner hasn't typed in their own handle.
Proving the handle closes it.

**Meta's login doesn't do it (as of late 2026; check, this changes
often):**

- Instagram Basic Display, which let any Instagram user sign in and
  gave back their username, was shut down in December 2024.
- "Instagram API with Instagram Login" works only for professional
  accounts (Business/Creator). Most people's accounts are personal.
- Facebook Login doesn't give you an Instagram handle, except for
  business accounts linked to a Page.

**What would work: they DM us a code.**

1. Canopy has its own Instagram professional account.
2. To verify, the person sends it a code we show them (e.g.
   `CANOPY 482913`) from their own account. A deep link can open
   Instagram with the message ready.
3. Meta's messaging webhook tells us about the DM. We match the code and
   read the sender's username, so whoever sent it controls that handle.

It works for personal accounts because they start the conversation.

**What it takes:** a Meta developer app, business verification, app
review for the messaging permission (`instagram_manage_messages` or its
current name), a public privacy policy, and a webhook endpoint
(probably in the account service). That's mostly paperwork: days to
weeks.

**Avoid:** "put this code in your bio" and then reading the public
profile. That's scraping, against Instagram's terms, and gets blocked.

**Once it exists:** profiles carry `instagramVerifiedAt`, lookup prefers
(or only returns) verified handles, and an unverified claim to a
verified handle is ignored instead of making it contested.

## RSVP from your own calendar app

**The idea:** events show up in someone's calendar as invitations, and
tapping Accept, Maybe or Decline there RSVPs them on Canopy.

**A subscribed feed can't.** A `webcal://` subscription (the shared
Canopy calendar on `feat/calendar`) is read-only everywhere: Apple
Calendar, Google Calendar and Outlook show its events with no RSVP
buttons and send nothing back.

**Real calendar invitations can (iTIP/iMIP, RFC 5546/6047):**

1. Canopy emails the guest an invitation: an `.ics` with
   `METHOD:REQUEST`, an `ATTENDEE` (them) and an `ORGANIZER` set to a
   per-guest, per-event address like `rsvp-<random token>@canopysf.com`.
2. Their calendar app shows the normal **Accept / Maybe / Decline**,
   which maps exactly to going / maybe / can't go (`PARTSTAT` ACCEPTED /
   TENTATIVE / DECLINED).
3. Tapping one makes their calendar email a `METHOD:REPLY` to the
   organizer address.
4. Canopy receives it, checks the token (the real lock), the sender
   against the person's email, and the provider's DKIM verdict, and
   records the RSVP.

**What comes free:**

- Updates: a changed time or place is re-sent as `METHOD:REQUEST` with
  a higher `SEQUENCE`, and calendars update quietly. A cancelled event
  is sent as `METHOD:CANCEL` and disappears.
- Email verification: a reply to a per-guest token address proves they
  read that inbox. It could mark a quick account verified, which helps
  with the bootstrap problem (people don't confirm emails).

**What it costs:**

- **Inbound mail.** Today mail is send-only, through iCloud SMTP. Replies
  need a provider with inbound handling (Postmark, Amazon SES, or
  Cloudflare Email Routing feeding a Worker). Outgoing mail should
  probably move to the same provider too, because iCloud's ~1,000/day,
  "personal use" sending won't stretch to invitations and updates.
- **It's email,** and push is the chosen channel. So it should be opt-in
  per person ("Send events to my calendar as invites"), and perhaps only
  for verified emails (or only once someone has answered once), to stay
  off spam lists.
- **Duplicates** with the subscribed feed: the same event appearing in
  both. Either people pick one, or the feed leaves out events already
  sent as invitations to that person.
- **Client quirks:** Gmail auto-adds invitations, Outlook rewrites
  replies, and Apple's handling varies by account type (iCloud vs
  Exchange vs Google). Plan a round of real-device testing.
- **Spoofed replies:** without the token, a reply proves nothing. With
  it, someone would need the invitation email itself.

**Where it would live:** sending invitations and parsing replies fit
the events service (it owns RSVPs). The inbound webhook could live
there too. The account service only needs to keep owning email
addresses.
