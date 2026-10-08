// notify(): the one way anyone hears about anything. It writes the inbox
// entry and queues the push in the same call, so nothing can push without
// landing in the inbox, and every trigger goes through the same rules:
//
//   - the person who did it is never told about it (`actorId` is taken
//     out of `to`);
//   - nobody is told twice by one call (`to` is de-duplicated);
//   - a repeat folded into an unread notification (someone else
//     answering your event, lib/store/notifications.js) updates the inbox
//     but doesn't push again: one buzz per batch, not per guest.
//
// Who's in `to` for each trigger is the caller's business (routes/), with
// store.audienceOf(eventId) for "everyone coming" and store.hostIdsOf for
// the hosts.

function createNotifier({ store, push }) {
  return function notify(type, { to, actorId = null, eventId = null, details = null }) {
    const recipients = Array.from(new Set(to || [])).filter((id) => id && id !== actorId);
    if (!recipients.length) return [];
    const written = store.addNotifications(type, recipients, { eventId, actorId, details });
    const event = eventId ? store.getEvent(eventId) : null;
    written.forEach(({ notification, isNew }) => {
      if (!isNew) return;
      push.queue(notification.personId, {
        type,
        notificationId: String(notification.id),
        eventId: event ? event.publicId || event.id : null,
        eventTitle: event ? event.title : null,
        actorId,
        details,
        badge: store.unreadCount(notification.personId)
      });
    });
    return written;
  };
}

module.exports = { createNotifier };
