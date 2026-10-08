// Sending a page: a file from views/ with its placeholders filled, and
// its scripts and stylesheet put inline. The pages' content is drawn by
// public/ui.js, which the browser runs too, so what the server sends and
// what the page draws after a change are the same code.
//
// Placeholders in a view:
//
//   __PAGE_TITLE__       the <title>
//   <!-- PAGE:META -->   link preview tags (the event page)
//   <!-- PAGE:HEADER --> the logo, your events, friends, your photo
//   <!-- PAGE:BANNER --> "confirm your email", for an unverified person
//   <!-- PAGE:MAIN -->   the page's content, drawn here
//   <!-- PAGE:FOOTER --> sign out
//   __PAGE_DATA__        the API answers the page was drawn from, as JSON,
//                        so its script starts from them without asking
//
// They're filled in one pass over the view, so nothing a person typed
// (a title, a name) is ever read as a placeholder.

const fs = require('fs');
const path = require('path');
const { t } = require('../public/copy.js');
const UI = require('../public/ui.js');
const { isVerified } = require('./people');
const { publicBase } = require('./domain');

const ROOT = path.join(__dirname, '..');

// The app's own scripts go inside each page rather than being fetched
// separately, so a page and its scripts always come from the same copy of
// the app. The account service and tickets learned why: Cloudflare gives
// .js files a 4-hour browser cache whatever this server says, and during
// a deploy a phone can get the old file (or a 404) under the new URL and
// keep it. Read once at startup.
const INLINE_SCRIPTS = ['copy.js', 'ui.js', 'events.js'].map((name) => {
  // `</script` inside the source would end the inline tag early.
  const source = fs.readFileSync(path.join(ROOT, 'public', name), 'utf8').replace(/<\/script/gi, '<\\/script');
  return { tag: `<script src="/${name}"></script>`, inline: `<script>/* ${name} */\n${source}\n</script>` };
});
// The shared stylesheet, the same way.
const INLINE_STYLES = ['events.css'].map((name) => {
  const source = fs.readFileSync(path.join(ROOT, 'public', name), 'utf8').replace(/<\/style/gi, '<\\/style');
  return { tag: '<link rel="stylesheet" href="/' + name + '">', inline: `<style>/* ${name} */\n${source}\n</style>` };
});

const esc = UI.esc;

// JSON inside a <script> tag: nothing in it can close the tag or start a
// comment, and the two line separators JavaScript once choked on are
// escaped too.
function jsonForScript(data) {
  return JSON.stringify(data === undefined ? {} : data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// The viewer's time zone, from the cookie public/events.js leaves. Only a
// zone this runtime knows; anything else is no zone (and the page labels
// every time with the event's).
function viewerZone(req) {
  const m = /(?:^|;\s*)tz=([^;]*)/.exec(String(req.headers.cookie || ''));
  if (!m) return null;
  let zone;
  try { zone = decodeURIComponent(m[1]); } catch (e) { return null; }
  if (!zone || zone.length > 64) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch (e) {
    return null;
  }
}

module.exports = function createRender({ canopy, accountUrl }) {
  const accountBase = String(accountUrl || '').replace(/\/+$/, '');

  // This page, as links back to it should say (sign in, verify, and come
  // back here).
  function hereUrl(req) {
    return publicBase(req) + req.originalUrl;
  }

  // The logo (home), your events, friends, and your photo, which opens
  // your Canopy profile. Signed out: the logo and "Sign in".
  function header(req, current) {
    const logo = '<a href="/" class="brand"><img src="/canopy-logo.png" alt="Canopy" class="site-logo"></a>';
    if (!req.person) {
      return '<header class="top">' + logo + '<nav><a class="nav-btn" href="' + esc(canopy.signInUrl(req, hereUrl(req))) + '">'
        + esc(t('common.signIn')) + '</a></nav></header>';
    }
    const link = (href, key, name) => '<a href="' + href + '"' + (current === name ? ' class="current" aria-current="page"' : '') + '>' + esc(t(key)) + '</a>';
    return '<header class="top">' + logo + '<nav>'
      + link('/', 'common.yourEvents', 'home')
      + link('/friends', 'common.friends', 'friends')
      + '<a class="me" href="' + esc(accountBase + '/profile') + '" aria-label="' + esc(t('common.yourAccount')) + '">'
      + UI.avatar(req.person, 'header') + '</a>'
      + '</nav></header>';
  }

  // Confirm your email: every page, for an unverified person, and it
  // can't be closed. It never blocks anything; it's how they get to make
  // events.
  function banner(req) {
    const unverified = (req.person && !isVerified(req.person)) || (!req.person && req.canopyUnverified);
    if (!unverified) return '';
    return '<div class="card verify-banner" id="verifyBanner" role="status"><p>' + esc(t('common.verifyBanner')) + '</p>'
      + '<a class="button" href="' + esc(canopy.verifyUrl(req, hereUrl(req))) + '">' + esc(t('common.verifyButton')) + '</a></div>';
  }

  function footer(req) {
    if (!req.person) return '';
    return '<footer class="foot"><a href="' + esc(canopy.signOutUrl(req, publicBase(req) + '/')) + '">' + esc(t('common.signOut')) + '</a></footer>';
  }

  // Sends views/<name> with everything filled in. `main` is the page's
  // content (HTML), `data` what its script starts from.
  function page(req, res, name, { status = 200, title, meta = '', current = null, main = '', data = {} } = {}) {
    let html = fs.readFileSync(path.join(ROOT, 'views', name), 'utf8');
    // Which time zone the server drew the times for (null: it didn't
    // know, and labelled them all), so the script redraws only if the
    // viewer's is different.
    data = Object.assign({ drawnZone: viewerZone(req) }, data);
    const values = {
      '__PAGE_TITLE__': esc(title ? `${title} · Canopy` : 'Canopy Events'),
      '<!-- PAGE:META -->': meta,
      '<!-- PAGE:HEADER -->': header(req, current),
      '<!-- PAGE:BANNER -->': banner(req),
      '<!-- PAGE:MAIN -->': main,
      '<!-- PAGE:FOOTER -->': footer(req),
      '__PAGE_DATA__': jsonForScript(data)
    };
    html = html.replace(/__PAGE_TITLE__|__PAGE_DATA__|<!-- PAGE:(META|HEADER|BANNER|MAIN|FOOTER) -->/g, (token) => values[token]);
    INLINE_SCRIPTS.concat(INLINE_STYLES).forEach(({ tag, inline }) => {
      html = html.replace(tag, () => inline);
    });
    res.status(status);
    res.set('Content-Type', 'text/html; charset=utf-8');
    // Pages say who you are and who's going: never for a cache to keep.
    res.set('Cache-Control', 'no-store');
    res.send(html);
  }

  // A page that's only a message: not found, hosts only, the account
  // service down. `button` is { href, label } or nothing.
  function message(req, res, status, { heading, text, button } = {}) {
    let main = '<section class="card center" id="message">';
    if (heading) main += '<h2>' + esc(heading) + '</h2>';
    if (text) main += '<p class="center" style="margin:8px 0 ' + (button ? '18px' : '0') + '">' + esc(text) + '</p>';
    if (button) main += '<a class="button" href="' + esc(button.href) + '">' + esc(button.label) + '</a>';
    main += '</section>';
    page(req, res, 'message.html', { status, title: heading, main });
  }

  // Link preview tags for an event (iMessage, Slack, WhatsApp...): the
  // title, when and the place's name. Never the street address -- the
  // event here is what a signed-out caller gets, which has none, and
  // previews are kept by the machines that fetch them -- and never the
  // description, which is the host's own words and can say anything.
  function eventMeta(event) {
    const title = event.status === 'cancelled' ? `${t('status.cancelled')}: ${event.title}` : event.title;
    const description = [UI.whenPreview(event), event.locationName].filter(Boolean).join(' · ');
    const cover = UI.coverUrl(event);
    const tags = [
      ['property', 'og:type', 'website'],
      ['property', 'og:site_name', 'Canopy'],
      ['property', 'og:title', title],
      ['property', 'og:description', description],
      ['property', 'og:url', event.url],
      ['name', 'twitter:card', cover ? 'summary_large_image' : 'summary'],
      ['name', 'twitter:title', title],
      ['name', 'twitter:description', description],
      ['name', 'description', description]
    ];
    // The cover image, once events have one (UI.coverUrl says where it
    // comes from). Without one, previews show the title and the line.
    if (cover) tags.push(['property', 'og:image', cover], ['name', 'twitter:image', cover]);
    return tags.map(([attr, key, value]) => `<meta ${attr}="${key}" content="${esc(value)}">`).join('\n');
  }

  return { page, message, eventMeta, hereUrl, viewerZone };
};

module.exports.jsonForScript = jsonForScript;
module.exports.viewerZone = viewerZone;
