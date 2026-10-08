// The calendar feed's one question: every event someone has a part in,
// from `since` on (routes/calendar.js and lib/rules.js calendarStatus say
// which of them go in the feed, and how). Their part: hosting (`role`,
// with when they were made a host) and their answer (`rsvp`, with when it
// last changed, and when they were invited). Answers that never put an
// event in a calendar (can't go, removed) aren't asked for; an invitation
// with no answer is, and lib/rules.js leaves it out for someone who's
// turned invitations off.

const { eventRow } = require('./events');

module.exports = function calendarStore(db) {
  const q = {
    eventsFor: db.prepare(`
      SELECT e.*, h.role AS my_role, h.added_at AS my_host_at,
             r.status AS my_rsvp, r.guests AS my_guests, r.status_at AS my_rsvp_at, r.responded_at AS my_responded_at,
             r.invited_at AS my_invited_at
      FROM events e
      LEFT JOIN hosts h ON h.event_id = e.id AND h.person_id = @me
      LEFT JOIN rsvps r ON r.event_id = e.id AND r.person_id = @me
      WHERE e.id IN (
          SELECT event_id FROM hosts WHERE person_id = @me
          UNION
          SELECT event_id FROM rsvps WHERE person_id = @me AND status IN ('going', 'maybe', 'waitlisted', 'invited'))
        AND e.starts_at >= @since
      ORDER BY e.starts_at, e.id`)
  };

  return {
    // [{ event (as getEvent has it), role, hostAt, rsvp,
    // guests, rsvpAt, respondedAt, invitedAt }], soonest first.
    calendarEventsFor(personId, since) {
      return q.eventsFor.all({ me: String(personId), since }).map((r) => ({
        event: eventRow(r),
        role: r.my_role || null,
        hostAt: r.my_host_at || null,
        rsvp: r.my_rsvp || null,
        guests: r.my_guests || 0,
        rsvpAt: r.my_rsvp_at || null,
        respondedAt: r.my_responded_at || null,
        invitedAt: r.my_invited_at || null
      }));
    }
  };
};
