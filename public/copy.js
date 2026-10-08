// Every sentence the events pages say out loud, in one place -- the same
// arrangement as the account service's public/copy.js (and tickets').
//
// EDITING: change the text between the quotes, save, reload the page.
// There's no build step. The server reads this file too (it draws each
// page before sending it), so restart the server after an edit to see it
// in the first paint as well.
//
// {braces} are placeholders the code fills in. Keep the name spelled
// exactly as it appears ({name}, {count}) or it'll show through to the
// page verbatim; move it anywhere in the sentence, or drop it.
//
// NOT here, on purpose: one- and two-word button labels (Save, Edit,
// Going), which live next to the buttons they name, and anything only a
// developer sees.
const COPY = {

  // ---------------- On every page ----------------
  common: {
    yourEvents: 'Your events',
    friends: 'Friends',
    signIn: 'Sign in',
    signOut: 'Sign out',
    yourAccount: 'Your Canopy account',
    // Can't be closed. Unverified people (a quick sign-up) can answer
    // and be invited, but can't make events.
    verifyBanner: "Confirm your email. Until you do, you can answer invitations but you can't make your own events.",
    verifyButton: 'Confirm email',
    unreachable: "Couldn't reach the server. Try again.",
    accountsDown: "Canopy accounts can't be reached right now. Try again in a minute.",
    failed: 'Something went wrong. Try again.',
    showMore: 'Show more',
    pageNotFound: "There's nothing at this address.",
    formerMember: 'Former member'
  },

  // ---------------- Answers, wherever they're shown ----------------
  status: {
    going: 'Going',
    maybe: 'Maybe',
    not_going: "Can't go",
    waitlisted: 'On the waitlist',
    invited: 'Invited',
    hosting: 'Hosting',
    cancelled: 'Cancelled',
    over: 'Ended',
    now: 'Happening now'
  },

  // ---------------- An event, at /e/<id> ----------------
  event: {
    // Shown under the time when the event's time zone isn't yours.
    zone: 'Times are {city} time ({zone}).',
    // Signed out: the street address waits for signing in (link
    // previews are kept by machines, and a home address shouldn't be).
    addressHidden: 'The address shows once you sign in.',
    openMap: 'Open in Maps',
    hostedBy: 'Hosted by {names}',
    and: '{first} and {last}',
    cancelled: 'This event has been cancelled.',
    over: 'This event has ended.',
    // Signed out, the big button goes to the quick sign-up.
    rsvpHint: "New to Canopy? It's just your name, your email and a passkey.",
    haveAccount: 'I have a Canopy account, sign in',
    // Signed in, not hosting.
    question: 'Are you going?',
    invitedQuestion: "You're invited. Are you going?",
    yourAnswer: 'You said: {status}.',
    waitlisted: "You're on the waitlist. You'll move up if a spot opens.",
    withdraw: 'Take back my answer',
    // The host's area.
    hostingHeading: "You're hosting",
    hostingHint: 'Share the link with anyone you want there. Anyone with it can see the event.',
    copied: 'Link copied.',
    cancelConfirm: "Cancel this event? Everyone on the list will see it's off. You can bring it back later.",
    restoreConfirm: 'Bring this event back? It will show as on again for everyone.',
    restoreHint: 'This event is cancelled. You can bring it back.',
    // Friends going.
    friendsGoing: '{count} friends going',
    friendGoing: '1 friend going',
    friendsGoingHidden: 'Answer to see which of your friends are going.',
    // The guest list.
    guestsHeading: "Who's coming",
    noAnswers: 'No answers yet.',
    hiddenList: "The host shows who's coming to people who've answered. Answer to see the list.",
    invitedGroup: "Invited, hasn't answered",
    notFound: "There's no event at this link. Check it with whoever sent it.",
    notFoundHeading: 'Event not found'
  },

  // ---------------- Your events, at / ----------------
  home: {
    heading: 'Your Events',
    newEvent: 'New event',
    // Unverified people can't host.
    verifyToHost: 'Confirm your email to make your own events.',
    hosting: 'Hosting',
    invitations: 'Invitations',
    upcoming: 'Coming up',
    past: 'Past',
    empty: "Nothing here yet. When someone sends you an event link, open it and answer, and it'll show up here.",
    emptyHost: 'Make an event, share its link, and see who answers.',
    answered: 'Answered.',
    // Signed out.
    signedOutHeading: 'Canopy Events',
    signedOutHint: "Make an event, share its link, and see who's going. Your friends are the people you've been to things with.",
    signedOutLink: 'Got an event link? Open it to answer.'
  },

  // ---------------- Making or editing an event, at /new and /e/<id>/edit ----------------
  editor: {
    newHeading: 'New Event',
    editHeading: 'Edit Event',
    // The form's parts.
    what: 'What',
    when: 'When',
    where: 'Where',
    guests: 'Guests',
    title: 'Title',
    descriptionPlaceholder: "What's happening, what to bring, anything people should know.",
    description: 'Description',
    starts: 'Starts',
    ends: 'Ends (optional)',
    timeZone: 'Time zone',
    timeZoneHint: 'The times above are in this time zone.',
    locationName: 'Place',
    locationNamePlaceholder: "Ana's place, or Dolores Park",
    locationAddress: 'Address',
    locationAddressHint: 'Only people who are signed in see the address.',
    guestList: 'Guest list',
    everyone: 'Everyone with the link sees who is coming.',
    responded: "People see who is coming once they've answered. Before that, only how many.",
    hostsSeeAll: 'You always see everyone.',
    // Unverified people get this instead of the form.
    verifyHeading: 'Confirm your email first',
    verifyHint: 'To make events, confirm your email. It takes a minute: we email you a code.',
    notHost: 'Only a host can edit this event.',
    // By the API's `reason`. The API's own sentence is shown for any
    // reason not listed here.
    errors: {
      bad_title: 'Give the event a title.',
      bad_starts_at: 'Pick when it starts.',
      bad_ends_at: "That end time doesn't look right.",
      ends_before_start: 'It has to end after it starts.',
      bad_time_zone: 'Pick a time zone.',
      rate_limited: "That's a lot of events for one day. Try again tomorrow."
    }
  },

  // ---------------- Inviting friends, at /e/<id>/invite ----------------
  invite: {
    heading: 'Invite Friends',
    hint: "Your friends are the people you've been to events with. They'll see this in their invitations.",
    search: 'Search by name',
    noFriends: "You don't have friends here yet. Friends are people you've been to an event with. Share the link instead, and after the event they'll be here.",
    noMatch: 'No friends by that name.',
    inviteSome: 'Invite {count}',
    invited: 'Invited {count} friends.',
    invitedOne: 'Invited 1 friend.',
    together: '{count} events together',
    togetherOne: '1 event together',
    closed: "This event isn't taking invitations: it's over or cancelled.",
    notHost: 'Only a host can invite people to this event.',
    back: 'Back to the event'
  },

  // ---------------- Your friends, at /friends ----------------
  friends: {
    heading: 'Friends',
    hint: "People you've been to an event with: hosting it or going, once it happened.",
    empty: "No friends yet. Once you've been to an event, everyone else who was there shows up here.",
    together: '{count} events together',
    togetherOne: '1 event together',
    lastTogether: 'last {date}'
  }
};

// COPY.event.hostedBy, with {braces} swapped for values:
//   t('event.hostedBy', { names: 'Ana Lima' })
// A missing key returns the path itself rather than "undefined", so a
// typo shows up on the page as the thing to go and fix.
function t(path, vars){
  let node = COPY;
  for (const key of path.split('.')){
    if (node == null || typeof node !== 'object') return path;
    node = node[key];
  }
  if (typeof node !== 'string') return path;
  if (!vars) return node;
  return node.replace(/\{(\w+)\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole);
}

// Fills every <element data-copy="some.path"> with its line.
function applyCopy(root){
  (root || document).querySelectorAll('[data-copy]').forEach(el => {
    el.textContent = t(el.getAttribute('data-copy'));
  });
}

// The server draws pages with these too (lib/render.js). In a browser
// there's no `module`, and this does nothing.
if (typeof module === 'object' && module.exports) module.exports = { COPY, t };
