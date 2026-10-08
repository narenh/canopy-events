// Who may do what to an event, in one place, so the API, the pages that
// come later and the tests all ask the same questions.

// An event with no end time counts as over this long after it starts: an
// evening's worth. It's what moves it from "upcoming" to "past". Friends
// don't use it (they count from when an event starts).
const ASSUMED_LENGTH_MS = 6 * 60 * 60 * 1000;

function overAtFor(startsAt, endsAt) {
  return endsAt != null ? endsAt : startsAt + ASSUMED_LENGTH_MS;
}

function isOver(event, now = Date.now()) {
  return event.overAt <= now;
}

// The answers. 'invited' is the state before one; 'waitlisted' is a
// "going" past the capacity, set by the server, never asked for.
const ANSWERS = ['going', 'maybe', 'not_going'];
const ANSWERED = ['going', 'maybe', 'not_going', 'waitlisted'];
const ALL_STATUSES = ['invited', ...ANSWERED];

// Hosts (the creator and any co-hosts) can edit an event and see all of
// its guest list. `role` is from store.hostRole: 'creator', 'cohost' or null.
function isHost(role) {
  return role === 'creator' || role === 'cohost';
}

// Whether the guest list's names are shown to this viewer. Never to
// someone signed out (counts only); always to hosts; to everyone else
// when the host chose 'everyone', or once they've answered when the host
// chose 'responded'. An invitation alone isn't an answer.
function canSeeGuestNames(event, { person, role, rsvp }) {
  if (!person) return false;
  if (isHost(role)) return true;
  if (event.guestListVisibility === 'everyone') return true;
  return !!rsvp && ANSWERED.includes(rsvp.status);
}

// Which statuses' names a viewer who can see names gets. Hosts see who's
// been invited and hasn't answered; guests don't (that's between the host
// and the person invited).
function visibleStatuses(role) {
  return isHost(role) ? ALL_STATUSES : ANSWERED;
}

// The activity wall. Anyone who can see the guest list's names can read
// it (it's full of them: "Ana is going"). Hosts can post, and so can
// anyone whose answer says they might be there: going, maybe, or on the
// waitlist. Invited-but-silent and can't-go people read but don't post.
const POSTERS = ['going', 'maybe', 'waitlisted'];

function canReadWall(event, viewer) {
  return canSeeGuestNames(event, viewer);
}

function canPost(role, rsvp) {
  return isHost(role) || (!!rsvp && POSTERS.includes(rsvp.status));
}

// Authors delete their own posts; hosts delete anything on the wall.
function canDeleteWallEntry(entry, { person, role }) {
  if (!person) return false;
  if (isHost(role)) return true;
  return entry.type === 'post' && entry.personId === person.id;
}

// Why this person can't answer this event right now, as [status, reason,
// sentence], or null if they can.
function answerRefusal(event, role, now = Date.now()) {
  if (event.status === 'cancelled') return [409, 'event_cancelled', 'this event has been cancelled'];
  if (isOver(event, now)) return [409, 'event_over', 'this event is over'];
  if (isHost(role)) return [409, 'host_cannot_rsvp', "you're hosting this event"];
  return null;
}

// Why nobody can be invited to this event right now, or null.
function inviteRefusal(event, now = Date.now()) {
  if (event.status === 'cancelled') return [409, 'event_cancelled', 'this event has been cancelled'];
  if (isOver(event, now)) return [409, 'event_over', 'this event is over'];
  return null;
}

module.exports = {
  ASSUMED_LENGTH_MS, ANSWERS, ANSWERED, ALL_STATUSES,
  overAtFor, isOver, isHost, canSeeGuestNames, visibleStatuses, answerRefusal, inviteRefusal,
  canReadWall, canPost, canDeleteWallEntry
};
