// The web pages: an event (/e/<id>, what a shared link opens, where
// hosts invite people from a sheet; /e/<id>/invite opens it), your
// events (/), making and editing one (/new, /e/<id>/edit), adding
// co-hosts (/e/<id>/cohosts), your friends, your friend link and your
// lists (/friends), someone else's friend link (/f/<code>), and a list's
// link (/l/<code>, with its QR code at /l/<code>/qr.svg).
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
const { EVENT_ID_RE, FRIEND_CODE_RE, LIST_CODE_RE } = require('../lib/ids');
const { qrSvg } = require('../lib/qr');
const { isVerified } = require('../lib/people');
const { publicBase } = require('../lib/domain');

// How many of a list a page asks for at once. An event's page asks for
// 50 guests, for the faces (and the list without the script). (The
// sheets read what they need themselves, in the browser: the invite
// sheet, the guest list and a list of yours; public/sheets.js.)
const GUESTS_SHOWN = 50;
const WALL_SHOWN = 20;
const FRIENDS_SHOWN = 50;
const LIST_SHOWN = 20;
const PAST_SHOWN = 10;
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
    const [settings, ...answers] = await Promise.all([apiGet(req, '/me/settings')]
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
      + '<div class="home-actions">' + make + cal + '</div></div>';
    if (!me.emailVerified) {
      main += '<p class="small" id="verifyToHost" style="color:var(--on-bg);margin:0 2px"><a href="'
        + UI.esc(canopy.verifyUrl(req, render.hereUrl(req))) + '">' + UI.tx('home.verifyToHost') + '</a></p>';
    }
    main += '<div id="lists" class="home-lists">' + UI.homeLists(data, { viewerZone: render.viewerZone(req) }) + '</div>';
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
      // ?guests=1: "View all" without the script, the list under the faces.
      guestsInline: req.query.guests !== undefined,
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
    // ?from=<id>: a duplicate (the host ⋯ menu's Duplicate). Still a new
    // event, started from the API's draft of that one: everything but the
    // date and times. Nothing exists until it's saved.
    let draft = null;
    if (req.query.from !== undefined) {
      const from = String(req.query.from);
      const r = EVENT_ID_RE.test(from) ? await apiGet(req, `/events/${from}/duplicate-draft`) : { status: 404 };
      if (r.status === 404) {
        return render.message(req, res, 404, { heading: t('event.notFoundHeading'), text: t('event.notFound'), button: { href: '/', label: t('common.yourEvents') } });
      }
      if (r.status === 403) {
        const ev = want(await apiGet(req, `/events/${from}`)).event;
        return hostsOnly(req, res, ev, 'editor.duplicateNotHost');
      }
      draft = want(r).draft;
    }
    const data = { me: meView(req.person), event: null, draft, backgrounds: await backgroundsFor(req) };
    render.page(req, res, 'editor.html', {
      title: t('editor.newHeading'),
      main: UI.editorForm(data, { zone: render.viewerZone(req), viewerZone: render.viewerZone(req) }),
      data,
      theme: draft ? UI.themeKeyOf(draft) : undefined,
      accent: draft ? UI.accentKeyOf(draft) : undefined
    });
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

  // ---------------- Inviting ----------------

  // Inviting is a sheet over the event page now (public/ui.js
  // inviteSheet). This old address still works: hosts go to the event with
  // the sheet open (?invite=1); anyone else is told it's for hosts.
  router.get('/e/:id/invite', attach, signedIn, pageRoute(async (req, res) => {
    const event = await loadEvent(req, res);
    if (!event) return;
    if (!event.viewer || !event.viewer.canEdit) return hostsOnly(req, res, event, 'invite.notHost');
    res.redirect(302, `/e/${event.id}?invite=1`);
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
    const [link, friends, optouts, lists, memberships] = await Promise.all([
      apiGet(req, '/me/friend-link'), apiGet(req, `/me/friends?limit=${FRIENDS_SHOWN}`), apiGet(req, '/me/invite-optouts'),
      apiGet(req, '/me/lists'), apiGet(req, '/me/list-memberships')
    ]);
    // Your lists, a row each: who's on one is in its sheet, which the
    // page's script loads when it opens.
    const own = want(lists).lists;
    const me = meView(req.person);
    const data = {
      me, link: want(link), friends: want(friends).friends, nextCursor: want(friends).nextCursor,
      lists: own, memberships: want(memberships).lists,
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

  // A list's link: the list and its owner, and (signed in) "Join Ana's
  // Drag Race?" with one button. Opening it joins nobody. Signed out, sign
  // in or quick-sign-up and come back here.
  router.get('/l/:code', attach, pageRoute(async (req, res) => {
    const r = LIST_CODE_RE.test(req.params.code) ? await apiGet(req, `/list-links/${req.params.code}`) : { status: 404 };
    if (r.status === 404 || r.status === 429) {
      return render.message(req, res, r.status, {
        heading: t('listLink.notFoundHeading'),
        text: t(r.status === 429 ? 'listLink.tooMany' : 'listLink.notFound'),
        button: req.person ? { href: '/', label: t('common.yourEvents') } : null
      });
    }
    const { list, owner, viewer } = want(r);
    const here = `${publicBase(req)}/l/${req.params.code}`;
    const data = {
      me: meView(req.person), list, owner, viewer, code: req.params.code,
      links: req.person ? null : { quickSignUp: canopy.quickSignUpUrl(req, here), signIn: canopy.signInUrl(req, here) }
    };
    render.page(req, res, 'list-link.html', {
      title: t('listLink.pageTitle', { list: list.name }),
      meta: render.listLinkMeta(list, owner, here),
      main: UI.listLinkPage(data),
      data
    });
  }));

  // A list link's QR code, as an SVG image (lib/qr.js): what the friends
  // page and an event's "Show list QR" show. It's the link, drawn, so it
  // says nothing the link doesn't, and it's drawn for any code shaped like
  // one without asking whether it's real.
  router.get('/l/:code/qr.svg', (req, res) => {
    if (!LIST_CODE_RE.test(req.params.code)) return res.status(404).type('text/plain').send('Not found.\n');
    const { svg } = qrSvg(`${publicBase(req)}/l/${req.params.code}`);
    res.set('Content-Type', 'image/svg+xml; charset=utf-8');
    res.set('Cache-Control', 'private, max-age=86400');
    res.send(svg);
  });

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
