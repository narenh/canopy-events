// Your inbox and your phones. Mounted at /api/v1; everything needs you
// signed in. What lands in the inbox, and when, is lib/notify.js and the
// routes that call it.

const express = require('express');
const { handle, fail, pageParams, paginate } = require('../lib/api');
const { notificationViews } = require('../lib/views');

const MAX_READ_PER_REQUEST = 100;
const NOTIFICATION_ID_RE = /^[1-9][0-9]{0,15}$/;
const PLATFORMS = ['ios', 'android'];
// APNs tokens are 64 hex characters; FCM's are longer, with : - _ in them.
const TOKEN_RE = /^[A-Za-z0-9:_.-]{16,4096}$/;

module.exports = function notificationRoutes(ctx) {
  const { store, auth } = ctx;
  const router = express.Router();

  // Your inbox, newest first, with how many are unread.
  router.get('/me/notifications', auth.requirePerson, handle(async (req, res) => {
    const page = pageParams(req, res);
    if (!page) return;
    const rows = store.listNotifications(req.person.id, { after: page.after, limit: page.limit + 1 });
    const { items, nextCursor } = paginate(rows, page.limit, (n) => [n.updatedAt, n.id]);
    res.json({
      notifications: await notificationViews(ctx, req, items),
      unreadCount: store.unreadCount(req.person.id),
      nextCursor
    });
  }));

  // Just the number, for a badge.
  router.get('/me/notifications/unread', auth.requirePerson, (req, res) => {
    res.json({ unreadCount: store.unreadCount(req.person.id) });
  });

  // Marks some read: { ids: [...] }. Ids that aren't yours (or aren't
  // anything) are ignored.
  router.post('/me/notifications/read', auth.requirePerson, (req, res) => {
    const ids = (req.body || {}).ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_READ_PER_REQUEST ||
        !ids.every((id) => typeof id === 'string' && NOTIFICATION_ID_RE.test(id))) {
      return fail(res, 400, 'bad_ids', `ids is a list of 1 to ${MAX_READ_PER_REQUEST} notification ids`);
    }
    store.markRead(req.person.id, ids.map(Number));
    res.json({ unreadCount: store.unreadCount(req.person.id) });
  });

  router.post('/me/notifications/read-all', auth.requirePerson, (req, res) => {
    store.markAllRead(req.person.id);
    res.json({ unreadCount: 0 });
  });

  // A phone to push to: { platform: 'ios' | 'android', token }. Again is
  // fine (it just refreshes it); a token someone else registered moves to
  // you, since it's the phone you're signed in on now.
  router.post('/me/devices', auth.requirePerson, (req, res) => {
    const { platform, token } = req.body || {};
    if (!PLATFORMS.includes(platform)) return fail(res, 400, 'bad_platform', "platform is 'ios' or 'android'");
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return fail(res, 400, 'bad_token', "that isn't a push token");
    store.registerDevice(req.person.id, platform, token);
    res.json({ ok: true });
  });

  // Stops pushing to a phone (signing out on it): { token }. Only your own;
  // a token that isn't yours, or isn't registered, is fine too.
  router.delete('/me/devices', auth.requirePerson, (req, res) => {
    const { token } = req.body || {};
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return fail(res, 400, 'bad_token', "that isn't a push token");
    store.removeDevice(token, req.person.id);
    res.json({ ok: true });
  });

  return router;
};
