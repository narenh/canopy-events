// Push notifications: sending a message to someone's phones. lib/notify.js
// is the only caller, so nothing is pushed without also landing in the
// inbox.
//
// A sender is { name, send(device, message) }: device is { platform:
// 'ios' | 'android', token }, and send resolves to { ok } or { ok: false,
// invalidToken: true } when the push service says the token is dead (the
// app was deleted), which unregisters it. The APNs and FCM senders come
// with the apps, since they need keys; until then the default sender only
// logs, with the token cut to its last 6 characters (a token is as good as
// an address for that phone).
//
// The message is typed, like the inbox: { type, notificationId, eventId,
// eventTitle, actorId, details, badge }. The real senders turn it into an
// APNs `loc-key` / FCM `body_loc_key` with arguments, so the apps word it
// in the phone's language, the same as they word the inbox.
//
// queue() returns at once and sends after the request has been answered:
// a slow push service never slows an RSVP down, and a failure is logged,
// never thrown at the person who caused it.

const logSender = {
  name: 'log',
  async send(device, message) {
    console.log(`[push] ${device.platform} …${String(device.token).slice(-6)} ${message.type} #${message.notificationId}`);
    return { ok: true };
  }
};

function createPush({ store, sender = logSender }) {
  function queue(personId, message) {
    setImmediate(async () => {
      for (const device of store.devicesOf(personId)) {
        try {
          const result = await sender.send(device, message);
          if (result && result.invalidToken) store.removeDevice(device.token);
        } catch (err) {
          console.error(`[push] ${sender.name} failed for a ${device.platform} device: ${err.message}`);
        }
      }
    });
  }
  return { queue, sender };
}

module.exports = { createPush, logSender };
