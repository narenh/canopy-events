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
    yourAccount: 'Your Canopy Account',
    canopyAccount: 'Canopy Account',
    // Can't be closed. Unverified people (a quick sign-up) can answer
    // and be invited, but can't make events.
    verifyBanner: "Confirm your email. Until you do, you can answer invitations but you can't make your own events.",
    verifyButton: 'Confirm email',
    unreachable: "Couldn't reach the server. Try again.",
    accountsDown: "Canopy Accounts can't be reached right now. Try again in a minute.",
    failed: 'Something went wrong. Try again.',
    showMore: 'Show more',
    pageNotFound: "There's nothing at this address.",
    formerMember: 'Former member'
  },

  // ---------------- Answers, wherever they're shown ----------------
  status: {
    going: 'Going',
    maybe: 'Maybe',
    not_going: "Can't Go",
    waitlisted: 'On the waitlist',
    invited: 'Invited',
    // Only hosts ever see this one, on their own guest list; a removed
    // person is told in event.removedHeading's words instead.
    removed: 'Removed',
    hosting: 'Hosting',
    cohosting: 'Co-hosting',
    cancelled: 'Cancelled',
    over: 'Ended',
    now: 'Happening now'
  },

  // ---------------- How soon, on an event and in lists ----------------
  // Counted in days on the event's own clock. "Happening now" and
  // "Ended" are status.now and status.over.
  when: {
    today: 'Today',
    tonight: 'Tonight',
    tomorrow: 'Tomorrow',
    thisWeekday: 'This {day}',
    nextWeekday: 'Next {day}',
    inWeeks: 'In {count} weeks',
    inMonth: 'In a month',
    inMonths: 'In {count} months'
  },

  // ---------------- An event, at /e/<id> ----------------
  event: {
    // Shown under the time when the event's time zone isn't yours.
    // {zone} is its friendly name: "Pacific Time", "Arizona", "London".
    zone: 'Times are in {zone}.',
    // Signed out: the street address waits for signing in (link
    // previews are kept by machines, and a home address shouldn't be).
    addressHidden: 'The address shows once you sign in.',
    // The host's extra details, under the place: each one's heading when
    // the host didn't write their own. (A link shows its own text.)
    detailHeadings: {
      link: 'Link',
      info: 'Info',
      dress_code: 'Dress code',
      food: 'Food',
      parking: 'Parking',
      accommodation: 'Where to stay',
      phone: 'Phone'
    },
    // Signed out: parking, a place to stay and phone numbers wait for
    // signing in, like the address.
    detailsHidden: 'More details show once you sign in.',
    openMap: 'Open in Maps',
    hostedBy: 'Hosted by {names}',
    and: '{first} and {last}',
    cancelled: 'This event has been cancelled.',
    over: 'This event has ended.',
    // Signed out, the big button goes to the quick sign-up.
    rsvpHint: "New to Canopy? It's just your name, your email and a passkey.",
    haveAccount: 'I have a Canopy Account, sign in',
    // Signed in, not hosting.
    question: 'RSVP',
    invitedQuestion: 'RSVP',
    yourAnswer: 'You said: {status}.',
    waitlisted: "You're on the waitlist. You'll move up if a spot opens.",
    // The host's area.
    hostingHeading: "You're hosting",
    copied: 'Link copied.',
    cancelConfirm: "Cancel this event? Everyone on the list will see it's off. You can bring it back later.",
    restoreConfirm: 'Bring this event back? It will show as on again for everyone.',
    restoreHint: 'This event is cancelled. You can bring it back.',
    // A co-host can't cancel or bring back.
    restoreHintCohost: 'This event is cancelled. Only the person who made it can bring it back.',
    // Friends going.
    friendsGoing: '{count} friends going',
    friendGoing: '1 friend going',
    friendsGoingHidden: 'Answer to see which of your friends are going.',
    // The guest list.
    guestsHeading: "Who's coming",
    noAnswers: 'No answers yet.',
    hiddenList: "The host shows who's coming to people who've answered. Answer to see the list.",
    invitedGroup: "Invited, hasn't answered",
    waitlistGroup: 'Waitlist',
    removedGroup: 'Removed',
    removedGroupHint: "Only hosts see this. They can't answer, or see the address, the guest list or the wall.",
    // Plus-ones, in counts and on the guest list.
    plusGuests: '+{count} guests',
    plusGuest: '+1 guest',
    overLimit: 'more than now allowed',
    // Capacity.
    spotsLeft: '{count} spots left',
    spotLeft: '1 spot left',
    full: 'Full. New answers join the waitlist.',
    fullHint: "It's full. If you say going, you'll join the waitlist and move up if a spot opens.",
    // The RSVP's plus-ones.
    bringing: "Guests you're bringing",
    bringingHint: 'You can bring up to {count}.',
    bringingHintOne: 'You can bring 1 guest.',
    overLimitNote: "The host now allows {allowed} guests each, and you're down for {guests}. That stands; if you change your answer, it'll be {allowed}.",
    fewerGuest: 'One fewer guest',
    moreGuest: 'One more guest',
    nowWaitlisted: "It's full, so you're on the waitlist. You'll move up if a spot opens.",
    // Someone a host removed from the event. Calm, and no details.
    // A guest's ⋯ menu. {name} is a host's first name.
    mute: 'Mute event',
    unmute: 'Unmute event',
    leave: 'Remove me from event',
    optOutInvites: 'Opt out of invites from {name}',
    allowInvites: 'Allow invites from {name}',
    muted: "Muted. You'll still hear if it's cancelled or moved.",
    unmuted: 'Unmuted.',
    optedOut: "You won't get invites from {name}.",
    optedIn: 'Invites from {name} can reach you again.',
    leaveConfirm: "Remove yourself from this event? You'll be off the guest list, and it leaves your events and your calendar.",
    removedHeading: "You're not on the list for this event.",
    removedHint: "A host has taken you off it, so you can't answer. If you think that's a mistake, ask whoever invited you.",
    // Refusals when answering, by the API's `reason`. Anything not listed
    // shows the API's own sentence.
    errors: {
      no_room: "There isn't room for that many guests. Your answer is as it was.",
      too_many_guests: "That's more guests than the host allows.",
      removed: "You're not on the list for this event.",
      event_cancelled: 'This event has been cancelled.',
      event_over: 'This event has ended.',
      host_cannot_rsvp: "You're hosting this event."
    },
    // Co-hosts, in the host's area.
    cohostingHeading: "You're co-hosting",
    cohostsHeading: 'Co-hosts',
    cohostsHint: 'Co-hosts can edit the event, invite people and see everyone.',
    removeCohostConfirm: "Take {name} off as a co-host? They'll stay invited, and can answer like anyone else.",
    stepDownConfirm: "Step down as a co-host? You'll stay invited, and can answer like anyone else.",
    // The host's ⋯ menu.
    moreActions: 'More',
    deleteConfirm: 'Delete “{title}”? This can’t be undone: the link stops working and everything on it goes.',
    deleteConfirmComing: 'Delete “{title}”? {count} people have said they’re coming. Deleting doesn’t tell them, but cancelling does, and keeps the event for them to see it’s off. Delete anyway? This can’t be undone.',
    deleteConfirmOne: 'Delete “{title}”? 1 person has said they’re coming. Deleting doesn’t tell them, but cancelling does, and keeps the event for them to see it’s off. Delete anyway? This can’t be undone.',
    // Removing a guest, and undoing it.
    removeGuestConfirm: "Remove {name} from this event? They won't be able to answer, or see the address, the guest list or the wall. You can undo this.",
    // A new link.
    newLinkConfirm: 'Make a new link? The link you have now stops working straight away, for everyone. Everyone on the list keeps their place, but anyone you sent the old link to will need the new one.',
    newLinkMade: "New link made. The old one doesn't work anymore. Share this one:",
    newLinkLabel: 'The new link',
    notFound: "There's no event at this link. Check it with whoever sent it.",
    notFoundHeading: 'Event not found'
  },

  // ---------------- Who's coming, on an event ----------------
  attend: {
    heading: 'Attending',
    going: '{count} Going',
    maybe: '{count} Maybe',
    waitlist: '{count} Waitlist',
    viewAll: 'View all',
    hide: 'Hide',
    more: '{count} more'
  },

  // ---------------- The activity wall, on an event ----------------
  wall: {
    heading: 'Wall',
    hidden: "The host shows the wall to people who've answered. Answer to see it.",
    empty: 'Nothing here yet.',
    emptyCanPost: 'Nothing here yet. Say hello to everyone coming.',
    placeholder: 'Write something for everyone coming',
    deleteConfirm: 'Delete this post?',
    deleteEntryConfirm: 'Take this off the wall?',
    justNow: 'just now',
    minutesAgo: '{count}m',
    hoursAgo: '{count}h',
    // The server's own entries, by their type. {name} is who it's about
    // (or the host who did it).
    entries: {
      going: '{name} is going.',
      off_waitlist: '{name} got a spot off the waitlist.',
      time_changed: '{name} moved it to {when}.',
      place_changed: '{name} changed the place to {place}.',
      place_cleared: '{name} took the place off.',
      cancelled: '{name} cancelled the event.',
      uncancelled: '{name} brought the event back.',
      cohost_added: '{name} is co-hosting.'
    },
    errors: {
      answer_first: "Say you're going or maybe to post here.",
      bad_text: 'A post needs some text, up to 1,000 characters.',
      rate_limited: "That's a lot of posts. Try again in a bit.",
      not_yours: 'You can only delete your own posts.'
    }
  },

  // ---------------- Adding co-hosts, at /e/<id>/cohosts ----------------
  cohosts: {
    heading: 'Add a Co-host',
    hint: "Pick from your friends. Co-hosts can edit the event, invite people and see everyone. If they'd answered, hosting takes the place of their answer.",
    added: '{name} is now a co-host.',
    creatorOnly: 'Only the person who made this event can add co-hosts.',
    closed: "Co-hosts can't be added: this event is over or cancelled.",
    noFriends: "You don't have friends here yet. Add some on the Friends page, or after an event everyone who was there shows up.",
    noMatch: 'No friends by that name.',
    errors: {
      email_unverified: "{name} can't co-host yet. A co-host needs a confirmed email, and to have opened Canopy Events with it at least once.",
      too_many_cohosts: 'An event can have at most 10 co-hosts.',
      creator_only: 'Only the person who made this event can add co-hosts.',
      event_cancelled: 'This event has been cancelled.',
      event_over: 'This event has ended.',
      is_creator: "You're already this event's host."
    }
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
    // The Calendar card: your Canopy calendar feed, and invitations in it.
    calendarHeading: 'Calendar',
    calendarHint: "Everything you're hosting or going to, in your phone's calendar, through your Canopy calendar link.",
    calendarAdd: 'Add to your calendar',
    calendarInvites: "Show events I'm invited to",
    // Signed out.
    signedOutHeading: 'Canopy Events',
    signedOutHint: "Make an event, share its link, and see who's going. Your friends are the people you've been to things with.",
    signedOutLink: 'Got an event link? Open it to answer.'
  },

  // ---------------- Making or editing an event, at /new and /e/<id>/edit ----------------
  editor: {
    // Read out, not shown: the editor looks like the event page.
    newHeading: 'New Event',
    editHeading: 'Edit Event',
    title: 'Title',
    titlePlaceholder: 'Event title',
    // When, drawn big like the page. Each piece is tapped to change.
    date: 'Date',
    datePlaceholder: 'Pick a date',
    startTime: 'Start time',
    endTime: 'End time',
    addEnd: '+ End time',
    removeEnd: 'Remove end time',
    // The time zone, small under the time, and its menu.
    timeZone: 'Time zone',
    zoneChange: 'Change',
    zoneChangeLabel: 'Change time zone',
    zoneYours: 'Your time zone',
    zoneOther: 'Other time zones…',
    zoneSearch: 'Search time zones',
    zoneClose: 'Close',
    zoneNoMatch: 'No time zones match.',
    // Where, and what it's about.
    locationName: 'Place',
    locationNamePlaceholder: 'Add a place',
    locationAddress: 'Address',
    locationAddressPlaceholder: 'Address (only signed-in guests see it)',
    description: 'Description',
    descriptionPlaceholder: "What's happening, what to bring, anything people should know",
    // The details under the description: the chips' group, and each row's
    // inputs. A row's heading starts as the type's own (event.detailHeadings).
    detailAdd: 'Add details',
    detailHeading: 'Heading for {name}',
    detailLinkText: 'Link text',
    detailAddress: 'Link address',
    detailRemove: 'Remove {name}',
    detailPlaceholders: {
      link: 'Paste a link',
      info: 'Anything else people should know',
      dress_code: 'What to wear',
      food: "What's on the menu, or what to bring",
      parking: 'Where to park',
      accommodation: 'Where people can stay',
      phone: 'Phone number'
    },
    // Who's coming.
    guests: 'Guests',
    guestList: 'Who sees the guest list',
    everyone: 'Everyone with the link',
    responded: "Only people who've answered",
    guestsAllowed: '+1s',
    noGuests: 'None',
    capacity: 'Capacity',
    capacityPlaceholder: 'No limit',
    // The cover: the buttons on the photo.
    coverAdd: 'Add cover photo',
    coverChange: 'Change cover photo',
    coverRemove: 'Remove cover photo',
    coverNoPreview: "This photo can't be previewed here. It will show once it's saved.",
    coverNotSaved: "The event is saved, but its cover didn't upload.",
    // The event's colour.
    theme: 'Color',
    themeDefault: 'Canopy green',
    themeGrey: 'No color',
    themeMatch: 'Match photo',
    // A grey event's accent: white, or a hue.
    accent: 'Accent',
    accentWhite: 'White',
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
      rate_limited: "That's a lot of events for one day. Try again tomorrow.",
      bad_guests_allowed: 'Pick from 0 to 10 guests.',
      bad_capacity: 'Capacity is a whole number from 1 to 10,000, or empty for no limit.',
      bad_theme_hue: 'Pick a color on the slider.',
      bad_theme_grayscale: 'Pick a color on the slider.',
      // The details, shown under the row they're about.
      bad_detail_url: "That doesn't look like a web link. Paste the whole address.",
      bad_detail_phone: "That doesn't look like a phone number.",
      bad_detail_value: 'Fill this in, or remove it.',
      detail_too_long: "That's too long.",
      too_many_details: 'An event can have up to 10 details.'
    },
    // The cover's own refusals, by the API's `reason`.
    coverErrors: {
      too_large: 'That photo is too big. A cover can be up to 15 MB.',
      bad_image: "That file isn't a photo we can use. Try a JPEG, PNG, WebP or HEIC.",
      rate_limited: "That's a lot of covers for one day. Try again tomorrow."
    }
  },

  // ---------------- Inviting friends, at /e/<id>/invite ----------------
  invite: {
    heading: 'Invite Friends',
    hint: "Your friends: people you've been to events with, and people you've added. They'll see this in their invitations.",
    search: 'Search by name',
    noFriends: "You don't have friends here yet. Share the link instead, or add friends on the Friends page.",
    noMatch: 'No friends by that name.',
    inviteSome: 'Invite {count}',
    invited: 'Invited {count} friends.',
    invitedOne: 'Invited 1 friend.',
    together: '{count} events together',
    togetherOne: '1 event together',
    closed: "This event isn't taking invitations: it's over or cancelled.",
    notHost: 'Only a host can invite people to this event.',
    // Finding someone by phone number or Instagram.
    lookupHeading: 'Invite by phone number or Instagram',
    lookupHint: 'Type their number or Instagram username exactly. Only people who let themselves be found will show up.',
    lookupPlaceholder: 'Number or @username',
    lookupVerify: 'Confirm your email to find people by phone number or Instagram.',
    lookupOff: "Finding people by phone number or Instagram isn't available yet.",
    lookupNone: 'No one found. Check the number or username, or share the link with them instead.',
    lookupInvited: 'Invited {name}.',
    lookupRemoved: "You've removed them from this event. Undo that from the guest list first.",
    lookupErrors: {
      bad_phone: "That doesn't look like a phone number.",
      bad_instagram: 'An Instagram username is letters, numbers, dots and underscores.',
      one_of: 'Type a phone number or an Instagram username.',
      rate_limited: "That's a lot of lookups. Try again later.",
      email_unverified: 'Confirm your email to find people by phone number or Instagram.'
    },
    back: 'Back to the event'
  },

  // ---------------- Your friends, at /friends ----------------
  friends: {
    // Hosts whose invitations you opted out of (an event's ⋯ menu).
    optoutsHeading: 'Opted out of invites from',
    heading: 'Friends',
    hint: "People you've been to an event with, and people you've added. Only you see this list.",
    empty: "No friends yet. Share your friend link, or add someone by phone or Instagram. Everyone you go to an event with shows up here too.",
    together: '{count} events together',
    togetherOne: '1 event together',
    lastTogether: 'last {date}',
    // How someone is in your list, under their name.
    source: {
      added: 'Added',
      link: 'Friend link',
      invite: 'Invitation'
    },
    // Your friend link and its QR code.
    linkHeading: 'Your friend link',
    linkHint: "Anyone who opens it and says yes is your friend, and you're theirs.",
    reset: 'Reset link',
    resetConfirm: 'Make a new link? The old link and QR code stop working. Friends you made with it stay friends.',
    copied: 'Link copied.',
    // Adding by phone or Instagram.
    lookupHeading: 'Add by phone or Instagram',
    lookupHint: "Type their number or Instagram username exactly. Only people who let themselves be found will show up. They aren't told.",
    lookupVerify: 'Confirm your email to add people by phone number or Instagram.',
    lookupNone: 'No one found. Check the number or username, or send them your friend link instead.',
    lookupOff: "Finding people by phone number or Instagram isn't available yet.",
    added: 'Added {name}.',
    alreadyTag: 'Friend',
    removeConfirm: "Remove {name} from your friends? They won't be told, and they won't come back unless you add them.",
    errors: {
      bad_phone: "That doesn't look like a phone number.",
      bad_instagram: 'An Instagram username is letters, numbers, dots and underscores.',
      one_of: 'Type a phone number or an Instagram username.',
      rate_limited: "That's a lot for one day. Try again tomorrow.",
      email_unverified: 'Confirm your email to add people by phone number or Instagram.'
    }
  },

  // ---------------- Someone's friend link, at /f/<code> ----------------
  friendLink: {
    signedOutHeading: '{name} on Canopy',
    signedOutHint: "Sign in or make a quick account to add {first} as a friend. You'll be in each other's friends.",
    signUp: 'Sign up to add {first}',
    signIn: 'I have a Canopy Account, sign in',
    confirm: 'Add {name} as a friend?',
    confirmHint: "You'll be in each other's friends, for inviting and seeing who's going.",
    yoursHeading: 'This is your friend link',
    yoursHint: 'Share it, and whoever opens it can add you.',
    alreadyHeading: "You and {first} are friends",
    toFriends: 'See your friends',
    notFoundHeading: "This link doesn't work",
    notFound: 'It may have been reset. Ask for a new one.',
    tooMany: "That's a lot of links that didn't work. Try again later.",
    pageTitle: 'Add {first}',
    // Link previews (iMessage, WhatsApp): the first name only, no photo.
    previewTitle: 'Add {first} on Canopy',
    previewText: "{first}'s friend link on Canopy Events.",
    errors: {
      own_link: "That's your own friend link.",
      friend_link_not_found: "This link doesn't work any more. It may have been reset.",
      rate_limited: "That's a lot of friends for one day. Try again tomorrow."
    }
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
