// Shared by every events page, in the browser: talking to the API, the
// page's data, photos that won't load, and the viewer's time zone.
// Inlined into each page by lib/render.js, after copy.js and ui.js.

// The data the server drew the page from: the same API answers, so the
// page's script starts where the server left off without asking again.
function pageData(){
  const el = document.getElementById('pageData');
  try{ return el ? JSON.parse(el.textContent) : {}; }catch(e){ return {}; }
}

// The viewer's own time zone, as the browser knows it.
function viewerZone(){
  try{ return Intl.DateTimeFormat().resolvedOptions().timeZone || null; }catch(e){ return null; }
}

// Told to the server as a cookie, so the next page it draws already
// knows whether an event's times need "Los Angeles time" under them. The
// first page anyone sees says it (it can't know), then this redraws it.
(function rememberZone(){
  const zone = viewerZone();
  if (!zone) return;
  const now = (document.cookie.match(/(?:^|;\s*)tz=([^;]*)/) || [])[1];
  if (now && decodeURIComponent(now) === zone) return;
  document.cookie = 'tz=' + encodeURIComponent(zone) + '; path=/; max-age=31536000; samesite=lax';
})();

// "Tomorrow", "This Saturday": the server drew them when it sent the
// page, which may have been a while ago (a tab left open overnight). The
// browser says them again now, and every minute while the page is open.
function refreshRelative(){
  document.querySelectorAll('[data-rel-start]').forEach((el) => {
    const e = {
      startsAt: el.getAttribute('data-rel-start'),
      endsAt: el.getAttribute('data-rel-end') || null,
      timeZone: el.getAttribute('data-rel-zone'),
      status: el.getAttribute('data-rel-status')
    };
    const words = UI.relativeWhen(e);
    if (words && el.textContent !== words) el.textContent = words;
    el.classList.toggle('off', UI.phaseOf(e) === 'over');
  });
}
refreshRelative();
setInterval(refreshRelative, 60000);

// The account menu under your photo in the header: opens under it,
// arrow keys move through it, Escape (or a tap anywhere else) shuts it and
// puts focus back on the photo. Its items are plain links.
(function accountMenu(){
  const btn = document.getElementById('accountMenuBtn');
  const menu = document.getElementById('accountMenu');
  if (!btn || !menu) return;
  const items = () => Array.from(menu.querySelectorAll('[role=menuitem]'));
  function close(focusButton){
    if (menu.hidden) return;
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (focusButton) btn.focus();
  }
  function open(){
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    items()[0].focus();
  }
  btn.addEventListener('click', () => (menu.hidden ? open() : close(true)));
  document.addEventListener('click', (e) => {
    if (menu.hidden || e.target.closest('#accountMenuBtn') || e.target.closest('#accountMenu')) return;
    close(false);
  }, true);
  document.addEventListener('keydown', (e) => {
    if (menu.hidden) return;
    const list = items();
    const at = list.indexOf(document.activeElement);
    if (e.key === 'Escape'){ e.preventDefault(); close(true); }
    else if (e.key === 'ArrowDown'){ e.preventDefault(); list[(at + 1) % list.length].focus(); }
    else if (e.key === 'ArrowUp'){ e.preventDefault(); list[(at - 1 + list.length) % list.length].focus(); }
    else if (e.key === 'Home'){ e.preventDefault(); list[0].focus(); }
    else if (e.key === 'End'){ e.preventDefault(); list[list.length - 1].focus(); }
    else if (e.key === 'Tab') close(false);
  });
})();

// A photo that won't load (signed out, the account service only gives
// photos to a Canopy session) becomes the person's initials.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!img || img.tagName !== 'IMG') return;
  const box = img.closest('.avatar');
  if (!box) return;
  box.textContent = box.getAttribute('data-initials') || '';
}, true);

// The API, with the cookie. Answers { res, data } for the caller to
// look at, except the answers every page treats the same way:
//
//   401 sign_in_required -> off to sign in, and back here;
//   403 email_unverified -> off to confirm the email, and back here
//                           (unless opts.stay: the page says it instead);
//   503 accounts_unreachable -> throws, and busy() says so.
//
// `body` is JSON, or a FormData (a file upload), sent as it is.
class AccountsDown extends Error {}

async function api(method, path, body, opts){
  const form = typeof FormData !== 'undefined' && body instanceof FormData;
  const res = await fetch('/api/v1' + path, {
    method,
    headers: Object.assign({ Accept: 'application/json' }, body === undefined || form ? {} : { 'Content-Type': 'application/json' }),
    body: body === undefined ? undefined : (form ? body : JSON.stringify(body))
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.signIn){ window.location.href = data.signIn; return new Promise(() => {}); }
  if (res.status === 403 && data.reason === 'email_unverified' && data.verify && !(opts && opts.stay)){ window.location.href = data.verify; return new Promise(() => {}); }
  if (res.status === 503) throw new AccountsDown(data.error || '');
  return { res, data };
}

// Disables a button while `work` runs, and turns a network failure (or
// the account service being down) into words in errorEl.
async function busy(btn, errorEl, work){
  if (errorEl) errorEl.textContent = '';
  if (btn) btn.disabled = true;
  try{
    return await work();
  }catch(err){
    if (errorEl) errorEl.textContent = t(err instanceof AccountsDown ? 'common.accountsDown' : 'common.unreachable');
  }finally{
    if (btn) btn.disabled = false;
  }
}

// The API's sentence for a refusal, as a sentence: capital first, full
// stop last.
function sentence(text){
  const s = String(text || '').trim();
  if (!s) return t('common.failed');
  return s.charAt(0).toUpperCase() + s.slice(1) + (/[.!?]$/.test(s) ? '' : '.');
}

// Clicks on anything with data-action="name" go to handlers[name], with
// the element. One listener for the page, so content drawn again after a
// change still works.
function onActions(handlers){
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || !handlers[el.getAttribute('data-action')]) return;
    e.preventDefault();
    handlers[el.getAttribute('data-action')](el, e);
  });
}
