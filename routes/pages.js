// The web pages: an event (/e/<id>, what a shared link opens), your
// events (/), making and editing one (/new, /e/<id>/edit), inviting
// friends or anyone by phone or Instagram (/e/<id>/invite), adding
// co-hosts (/e/<id>/cohosts), your friends and your friend link
// (/friends), and someone else's friend link (/f/<code>).
//
// **The pages are a client of the API, the same as the apps.** Each page
// asks this server's own /api/v1 for what it shows (over loopback, as
// the visitor, with their cookie), draws it with public/ui.js, and sends
// it with those same answers inside for its script to start from. So a
// page can never show more than the API would give that visitor: the
// signed-out view, the guest list's visibility rule and the never-leak
// rule are the API's, applied in one place (lib/views.js, lib/rules.js),
// and anything the API learns later (plus-ones, the waitlist) reaches
// the pages without a second copy of the rules here. The cost is one
// local request per list on the page, which is cheap: the account
// service's answer about who's asking is cached, so it isn't asked again.
//
// Changes (answering, editing, inviting) are made by the page's script,
// straight to the API with fetch.

const express = require('express');
const http = require('http');
const createRender = require('../lib/render');
const UI = require('../public/ui.js');
const { t } = require('../public/copy.js');
const { EVENT_ID_RE, FRIEND_CODE_RE } = require('../lib/ids');
const { qrSvg } = require('../lib/qr');
const { isVerified } = require('../lib/people');
const { publicBase } = require('../lib/domain');

// How many of a list a page asks for at once. The guest list shows 50 and
// then "show more"; inviting reads everyone already on the list, up to
// MAX_PAGES pages of 100, so it can mark them.
const GUESTS_SHOWN = 50;
const WALL_SHOWN = 20;
const FRIENDS_SHOWN = 50;
const LIST_SHOWN = 20;
const PAST_SHOWN = 10;
const MAX_PAGES = 20;
// The account service, for links to the Canopy profile.
const ACCOUNT_BASE = String(process.env.CANOPY_ACCOUNT_URL || '').replace(/\/+$/, '');

module.exports = function pagesRoutes(ctx) {
  const { canopy } = ctx;
  const render = createRender({ canopy, accountUrl: process.env.CANOPY_ACCOUNT_URL });
  const router = express.Router();

  // ---------------- Who's asking, and the API ----------------

  // canopy.attach for pages. When the account service can't be reached,
  // the client answers a plain-text 503; a page answers with a page.
  function attach(req, res, next) {
    const send = res.send;
    res.send = function (body) {
      res.send = send;
      if (res.statusCode === 503 && typeof body === 'string') return accountsDown(req, res);
      return send.apply(this, arguments);
    };
    canopy.attach(req, res, (err) => {
      res.send = send;
      next(err);
    });
  }

  function accountsDown(req, res) {
    render.message(req, res, 503, { heading: 'Canopy', text: t('common.accountsDown') });
  }

  // GET this server's own /api/v1<path> as the visitor: their cookie (or
  // token), the host they asked for (event links are built from it
  // outside production) and their address. Answers { status, data }.
  function apiGet(req, path) {
    const headers = { Accept: 'application/json', Host: req.get('host') || 'localhost', 'X-Forwarded-Proto': req.protocol };
    if (req.headers.cookie) headers.Cookie = req.headers.cookie;
    if (req.headers.authorization) headers.Authorization = req.headers.authorization;
    if (req.get('cf-connecting-ip')) headers['CF-Connecting-IP'] = req.get('cf-connecting-ip');
    return new Promise((resolve, reject) => {
      const r = http.get({ host: '127.0.0.1', port: req.socket.localPort, path: '/api/v1' + path, headers }, (answer) => {
        let body = '';
        answer.setEncoding('utf8');
        answer.on('data', (chunk) => { body += chunk; });
        answer.on('end', () => {
          let data = null;
          try { data = JSON.parse(body); } catch (e) {}
          resolve({ status: answer.statusCode, data });
        });
      });
      r.on('error', reject);
      r.setTimeout(15000, () => r.destroy(new Error('the API took too long to answer')));
    });
  }

  // An API answer that isn't the one a page wanted: the account service
  // down gets its page; anything else is our bug, and a 500.
  class ApiFailed extends Error {
    constructor(r) {
      super(`page's API call answered ${r.status}`);
      this.answer = r;
    }
  }
  function want(r, status = 200) {
    if (r.status !== status) throw new ApiFailed(r);
    return r.data;
  }

  // The curated backgrounds (GET /backgrounds), or [] when the feature is
  // off or the API couldn't say: the pages work without them.
  async function backgroundsFor(req) {
    try {
      const r = await apiGet(req, '/backgrounds');
      return r.status === 200 && r.data && r.data.enabled ? r.data.backgrounds : [];
    } catch (e) {
      return [];
    }
  }

  // Async page routes: a rejected promise goes to failed(), never takes
  // the process down.
  function pageRoute(fn) {
    return (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => failed(req, res, err));
  }

  function failed(req, res, err) {
    if (err instanceof ApiFailed && err.answer.status === 503) return accountsDown(req, res);
    // The stack only: an ApiFailed carries the API's whole answer, which
    // has no business in a log.
    console.error((err && err.stack) || String(err));
    if (res.headersSent) return;
    render.message(req, res, 500, { heading: 'Canopy', text: t('common.failed') });
  }

  // You, as the page's script needs you: no contact details, which it
  // never shows.
  function meView(person) {
    if (!person) return null;
    return { id: String(person.id), firstName: person.firstName, emailVerified: isVerified(person) };
  }

  // Signed in, or off to sign in and back here. An unverified person on
  // an account service set up without letting them in here goes to
  // confirm their email instead.
  function signedIn(req, res, next) {
    if (req.person) return next();
    const here = render.hereUrl(req);
    res.redirect(req.canopyUnverified ? canopy.verifyUrl(req, here) : canopy.signInUrl(req, here));
  }

  // The event at :id, as the API gives it to this visitor, or a 404 page.
  async function loadEvent(req, res) {
    const r = EVENT_ID_RE.test(req.params.id) ? await apiGet(req, `/events/${req.params.id}`) : { status: 404 };
    if (r.status === 404) {
      render.message(req, res, 404, {
        heading: t('event.notFoundHeading'),
        text: t('event.notFound'),
        button: req.person ? { href: '/', label: t('common.yourEvents') } : null
      });
      return null;
    }
    return want(r).event;
  }

  function hostsOnly(req, res, event, key) {
    render.message(req, res, 403, { heading: event.title, text: t(key), button: { href: `/e/${event.id}`, label: t('invite.back') } });
  }

  // Every page here is about people: who you are, who's going. No
  // search engine should keep one (events are link-only, with no
  // listing), and the pages say so too.
  router.use((req, res, next) => {
    res.set('X-Robots-Tag', 'noindex, nofollow');
    next();
  });

  // ---------------- Your events ----------------

  router.get('/', attach, pageRoute(async (req, res) => {
    if (!req.person) {
      const main = '<section class="card center" id="welcome"><h1>' + UI.tx('home.signedOutHeading') + '</h1>'
        + '<p class="center" style="margin:10px 0 18px">' + UI.tx('home.signedOutHint') + '</p>'
        + '<a class="button" href="' + UI.esc(canopy.signInUrl(req, render.hereUrl(req))) + '">' + UI.tx('common.signIn') + '</a>'
        + '<p class="center small" style="margin:14px 0 0">' + UI.tx('home.signedOutLink') + '</p></section>';
      return render.page(req, res, 'home.html', { current: 'home', main, data: { me: null } });
    }
    // The tabs (All, Invited, Hosting, Past): ?tab= picks one, anything
    // else is All. Every tab's first page comes with the page, so
    // switching tabs in the browser needs no request.
    const tab = UI.homeTabOf(req.query.tab);
    const sizes = { all: LIST_SHOWN, invitations: LIST_SHOWN, declined: LIST_SHOWN, hosting: LIST_SHOWN, past: PAST_SHOWN };
    const [backgrounds, settings, ...answers] = await Promise.all([backgroundsFor(req), apiGet(req, '/me/settings')]
      .concat(UI.HOME_LOADS.map((name) => apiGet(req, `/me/events/${name}?limit=${sizes[name]}`))));
    const lists = {};
    UI.HOME_LOADS.forEach((name, i) => { lists[name] = want(answers[i]); });
    const me = meView(req.person);
    const data = { me, tab, lists, sizes };
    // The Calendar card: the feed's link lives on the Canopy profile.
    const calendar = { settings: want(settings), calendarUrl: ACCOUNT_BASE ? `${ACCOUNT_BASE}/profile#calendarCard` : null };
    const make = me.emailVerified
      ? '<a class="nav-btn" href="/new" id="newEvent">+ New event</a>'
      : '';
    // Next to "+ New event": a calendar button whose popover is the
    // Calendar card (the feed's link, and invitations in it or not).
    const cal = '<div class="menu-wrap"><button type="button" class="icon-btn" id="calendarBtn" aria-haspopup="dialog" aria-expanded="false" aria-controls="calendarPopover"'
      + ' aria-label="' + UI.tx('home.calendarHeading') + '" title="' + UI.tx('home.calendarHeading') + '">' + UI.ICON_CALENDAR + '</button>'
      + '<div class="popover" id="calendarPopover" role="dialog" aria-labelledby="calendarHeading" hidden>' + UI.calendarCard(calendar) + '</div></div>';
    let main = '<div class="section-heading home-top"><h1 style="color:var(--on-bg);margin:0">' + UI.tx('home.heading') + '</h1>'
      + '<div class="home-actions">' + cal + make + '</div></div>';
    if (!me.emailVerified) {
      main += '<p class="small" id="verifyToHost" style="color:var(--on-bg);margin:0 2px"><a href="'
        + UI.esc(canopy.verifyUrl(req, render.hereUrl(req))) + '">' + UI.tx('home.verifyToHost') + '</a></p>';
    }
    main += '<div id="lists" class="home-lists">' + UI.homeLists(data, { viewerZone: render.viewerZone(req) }) + '</div>';
    // TMDB's attribution, small at the foot, while its backgrounds are
    // offered in the editor.
    if (backgrounds.length) main += UI.tmdbCredit('home-credit');
    render.page(req, res, 'home.html', { current: 'home', main, data });
  }));

  // ---------------- An event ----------------

  router.get('/e/:id', attach, pageRoute(async (req, res) => {
    const event = await loadEvent(req, res);
    if (!event) return;
    const here = `${publicBase(req)}/e/${event.id}`;
    // Signed in, the guest list and the wall as far as they may see them
    // (the API says), and for hosts, who they've removed. Someone a host
    // removed gets neither: the API would only say they can't see them.
    const viewer = event.viewer || {};
    const removedViewer = !!(viewer.rsvp && viewer.rsvp.status === 'removed');
    const insider = !!req.person && !removedViewer;
    // A guest on it (invited or answered) gets the ⋯ menu, which needs
    // whose invitations they've opted out of.
    const guestMenu = insider && !viewer.canEdit && !!viewer.rsvp;
    const [guests, removed, wall, optouts] = await Promise.all([
      insider ? apiGet(req, `/events/${event.id}/guests?limit=${GUESTS_SHOWN}`).then((r) => want(r)) : null,
      insider && viewer.canEdit ? apiGet(req, `/events/${event.id}/guests?status=removed&limit=${GUESTS_SHOWN}`).then((r) => want(r)) : null,
      insider ? apiGet(req, `/events/${event.id}/wall?limit=${WALL_SHOWN}`).then((r) => want(r)) : null,
      guestMenu ? apiGet(req, '/me/invite-optouts').then((r) => want(r)) : null
    ]);
    const data = {
      me: meView(req.person),
      event,
      guests,
      removed,
      wall,
      // Ids only: the menu names the hosts from the event.
      optouts: optouts ? optouts.hosts.map((p) => p.id) : null,
      links: req.person ? null : { quickSignUp: canopy.quickSignUpUrl(req, here), signIn: canopy.signInUrl(req, here) }
    };
    render.page(req, res, 'event.html', {
      theme: UI.themeKeyOf(event),
      accent: UI.accentKeyOf(event),
      title: event.title,
      meta: render.eventMeta(event),
      main: UI.eventPage(data, { viewerZone: render.viewerZone(req) }),
      data
    });
  }));

  // ---------------- Making and editing ----------------

  // Making events is for verified people. Anyone else signed in gets
  // what to do about it rather than a form that would only be refused.
  router.get('/new', attach, signedIn, pageRoute(async (req, res) => {
    if (!isVerified(req.person)) {
      return render.message(req, res, 403, {
        heading: t('editor.verifyHeading'),
        text: t('editor.verifyHint'),
        button: { href: canopy.verifyUrl(req, render.hereUrl(req)), label: t('common.verifyButton') }
      });
    }
    const data = { me: meView(req.person), event: null, backgrounds: await backgroundsFor(req) };
    render.page(req, res, 'editor.html', { title: t('editor.newHeading'), main: UI.editorForm(data, { zone: render.viewerZone(req), viewerZone: render.viewerZone(req) }), data });
  }));

  router.get('/e/:id/edit', attach, signedIn, pageRoute(async (req, res) => {
    const event = await loadEvent(req, res);
    if (!event) return;
    if (!event.viewer || !event.viewer.canEdit) return hostsOnly(req, res, event, 'editor.notHost');
    // ?coverError=<reason>: a new event was made, and its cover didn't
    // upload (views/editor.html sends them here to try again).
    const coverError = /^[a-z_]{1,40}$/.test(String(req.query.coverError || '')) ? req.query.coverError : null;
    const data = { me: meView(req.person), event, coverError, backgrounds: await backgroundsFor(req) };
    render.page(req, res, 'editor.html', { title: t('editor.editHeading'), main: UI.editorForm(data, { viewerZone: render.viewerZone(req) }), data, theme: UI.themeKeyOf(event), accent: UI.accentKeyOf(event) });
  }));

  // ---------------- Inviting friends ----------------

  router.get('/e/:id/invite', attach, signedIn, pageRoute(async (req, res) => {
    const event = await loadEvent(req, res);
    if (!event) return;
    if (!event.viewer || !event.viewer.canEdit) return hostsOnly(req, res, event, 'invite.notHost');
    // The hosts, everyone already on the list, invited or answered, and
    // everyone a host removed, so they're marked rather than offered.
    const onList = {};
    event.hosts.forEach((h) => { onList[h.person.id] = h.role === 'creator' ? 'hosting' : 'cohosting'; });
    for (const status of ['', 'removed']) {
      let cursor = '';
      for (let i = 0; i < MAX_PAGES; i++) {
        const page = want(await apiGet(req, `/events/${event.id}/guests?limit=100${status ? `&status=${status}` : ''}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
        page.guests.forEach((g) => { onList[g.person.id] = g.status; });
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
    }
    const friends = want(await apiGet(req, '/me/friends?limit=100'));
    const me = meView(req.person);
    const data = {
      me, event, onList, friends: friends.friends, nextCursor: friends.nextCursor, phase: UI.phaseOf(event),
      // Finding people by phone or Instagram is for verified people.
      links: me.emailVerified ? null : { verify: canopy.verifyUrl(req, render.hereUrl(req)) }
    };
    render.page(req, res, 'invite.html', { title: t('invite.heading'), main: UI.invitePage(data), data });
  }));

  // ---------------- Adding co-hosts ----------------

  // The creator only, as the API has it. Friends to pick from, the same
  // as inviting; the API says who can't (an unverified email).
  router.get('/e/:id/cohosts', attach, signedIn, pageRoute(async (req, res) => {
    const event = await loadEvent(req, res);
    if (!event) return;
    if (!event.viewer || event.viewer.role !== 'creator') return hostsOnly(req, res, event, 'cohosts.creatorOnly');
    const friends = want(await apiGet(req, '/me/friends?limit=100'));
    const data = { me: meView(req.person), event, friends: friends.friends, nextCursor: friends.nextCursor, phase: UI.phaseOf(event) };
    render.page(req, res, 'cohosts.html', { title: t('cohosts.heading'), main: UI.cohostPage(data), data });
  }));

  // ---------------- Friends ----------------

  // Your friend link (with its QR code, drawn here: lib/qr.js), adding by
  // phone or Instagram, and your list. The QR code is the one thing on a
  // page the API doesn't give: it's the link, drawn.
  router.get('/friends', attach, signedIn, pageRoute(async (req, res) => {
    const [link, friends, optouts] = await Promise.all([
      apiGet(req, '/me/friend-link'), apiGet(req, `/me/friends?limit=${FRIENDS_SHOWN}`), apiGet(req, '/me/invite-optouts')
    ]);
    const me = meView(req.person);
    const data = {
      me, link: want(link), friends: want(friends).friends, nextCursor: want(friends).nextCursor,
      // Whose invitations they've opted out of, with Undo.
      optouts: want(optouts).hosts,
      // Adding by phone or Instagram is for verified people.
      links: me.emailVerified ? null : { verify: canopy.verifyUrl(req, render.hereUrl(req)) }
    };
    const qr = qrSvg(data.link.url, { label: t('friends.linkHeading') }).svg;
    render.page(req, res, 'friends.html', { current: 'friends', title: t('friends.heading'), main: UI.friendsPage(data, { qr }), data });
  }));

  // Someone's friend link: who it is, and (signed in) "Add them?" with one
  // button. Opening it adds nobody, so a link preview or a tap by mistake
  // changes nothing. Signed out, sign in or quick-sign-up and come back.
  router.get('/f/:code', attach, pageRoute(async (req, res) => {
    const r = FRIEND_CODE_RE.test(req.params.code) ? await apiGet(req, `/friend-links/${req.params.code}`) : { status: 404 };
    if (r.status === 404 || r.status === 429) {
      return render.message(req, res, r.status, {
        heading: t('friendLink.notFoundHeading'),
        text: t(r.status === 429 ? 'friendLink.tooMany' : 'friendLink.notFound'),
        button: req.person ? { href: '/friends', label: t('friendLink.toFriends') } : null
      });
    }
    const { person, viewer } = want(r);
    const here = `${publicBase(req)}/f/${req.params.code}`;
    const data = {
      me: meView(req.person), person, viewer, code: req.params.code,
      links: req.person ? null : { quickSignUp: canopy.quickSignUpUrl(req, here), signIn: canopy.signInUrl(req, here) }
    };
    render.page(req, res, 'friend-link.html', {
      title: t('friendLink.pageTitle', { first: person.firstName || person.shortName }),
      meta: render.friendLinkMeta(person, here),
      main: UI.friendLinkPage(data),
      data
    });
  }));

  // Anything else a browser asks for, that nothing above or in public/
  // answered: a page saying so, rather than Express's bare text.
  function notFound(req, res, next) {
    if (req.method !== 'GET' || !String(req.get('accept') || '').includes('text/html')) return next();
    attach(req, res, () => render.message(req, res, 404, {
      heading: 'Canopy', text: t('common.pageNotFound'), button: { href: '/', label: t('common.yourEvents') }
    }));
  }

  return { router, notFound };
};
