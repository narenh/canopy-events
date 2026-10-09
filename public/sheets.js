// Sheets over the page, and the people picker inside some of them, for
// the pages that have them (views/event.html: invite, the guest list and
// the list QR codes; views/friends.html: a list of yours). public/ui.js
// draws them (sheetShell, pickerBody, ...); this opens and runs them.
// Needs copy.js, ui.js and events.js first.

// ---------------- The sheet ----------------
//
// One box at the end of the body (outside the page's content, which is
// drawn again after a change, so redrawing leaves the sheet alone): a
// dialog with everything else on the page made inert. Escape, the close
// button or a tap on the backdrop closes it (or, with `onEscape`, Escape
// does that instead, say to step back); Tab stays inside while it's
// open; focus goes back to whatever opened it.
const sheetBox = document.createElement('div');
sheetBox.id = 'sheetBox';
document.body.appendChild(sheetBox);
let sheet = null; // { opener, onClose, onEscape, fallback }

function sheetFocusables(){
  const panel = sheetBox.querySelector('[role=dialog]');
  return panel ? Array.from(panel.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex="0"]'))
    .filter((el) => el.offsetParent !== null || el === document.activeElement) : [];
}
function sheetFocus(focus){
  const first = (focus && sheetBox.querySelector(focus)) || sheetFocusables()[0];
  if (first) first.focus({ preventScroll: true });
}
function setPageInert(on){
  Array.from(document.body.children).forEach((el) => {
    if (el === sheetBox || el.tagName === 'SCRIPT') return;
    if (on) el.setAttribute('inert', '');
    else el.removeAttribute('inert');
  });
}
// `fallback` is the id of something to focus when the opener has gone.
function openSheet(html, { opener, onClose, onEscape, focus, fallback } = {}){
  sheetBox.innerHTML = html;
  sheet = { opener: opener || document.activeElement, onClose, onEscape, fallback };
  document.body.classList.add('sheet-open');
  setPageInert(true);
  sheetFocus(focus);
}
// The open sheet's content, drawn again (a step inside it), focus on
// `focus` (a selector) or the first thing in it.
function swapSheet(html, focus){
  if (!sheet) return;
  sheetBox.innerHTML = html;
  sheetFocus(focus);
}
function sheetIsOpen(){
  return !!sheet;
}
function closeSheet(){
  if (!sheet) return;
  const { opener, onClose, fallback } = sheet;
  sheet = null;
  sheetBox.innerHTML = '';
  document.body.classList.remove('sheet-open');
  setPageInert(false);
  if (onClose) onClose();
  // The button that opened it may have been drawn again meanwhile.
  const back = opener && document.body.contains(opener) ? opener
    : (opener && opener.id ? document.getElementById(opener.id) : null) || (fallback && document.getElementById(fallback));
  if (back) back.focus();
}
sheetBox.addEventListener('click', (e) => {
  if (e.target.classList && e.target.classList.contains('sheet-backdrop')) closeSheet();
});
document.addEventListener('keydown', (e) => {
  if (!sheet) return;
  if (e.key === 'Escape'){
    e.preventDefault();
    if (sheet.onEscape) sheet.onEscape();
    else closeSheet();
    return;
  }
  if (e.key !== 'Tab') return;
  const inside = sheetFocusables();
  if (!inside.length) return;
  const i = inside.indexOf(document.activeElement);
  if (e.shiftKey && i <= 0){ e.preventDefault(); inside[inside.length - 1].focus(); }
  else if (!e.shiftKey && i === inside.length - 1){ e.preventDefault(); inside[0].focus(); }
});

// Every page of a list (up to `max` pages of 100): { ok, items, first },
// `first` being the first answer.
async function allPages(path, key, max){
  let items = [];
  let cursor = '';
  let first = null;
  for (let i = 0; i < max; i++){
    const { res, data: d } = await api('GET', path + (path.includes('?') ? '&' : '?') + 'limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
    if (!res.ok) return { ok: false, items, first };
    if (!first) first = d;
    items = items.concat(d[key] || []);
    if (!d.nextCursor) break;
    cursor = d.nextCursor;
  }
  return { ok: true, items, first };
}

function fullNameOf(p){
  return [p.firstName, p.lastName].filter(Boolean).join(' ');
}

// ---------------- The picker ----------------
//
// Picking people, in the invite sheet and a list's "Add people": its
// state is `picker.st` (public/ui.js says what's in it), and what it
// needs is fetched the first time: your friends, the suggestions, your
// lists and who's on them, your past events, and who's already there
// (`cfg.loadTaken`, fetched again each time it's shown). Ticking only
// updates the boxes, the lists' buttons and the tray, so focus never
// jumps; typing draws the results again under the search box. Sending is
// the page's own (each sheet sends somewhere else).
//
// `cfg` is { kind: 'invite' | 'list', me, loadTaken: async () => ({ id:
// status }), skipList (a list's id to leave out of "Your lists"),
// skipEvent (an event's id to leave out of the past ones), canSave }.
let activePicker = null;

function makePicker(cfg){
  const p = { st: null, loaded: false, lookupTimer: null, lookups: new Map(), from: new Map() };

  function live(text){
    const el = document.getElementById('inviteLive');
    if (el){ el.textContent = ''; setTimeout(() => { el.textContent = text; }, 30); }
  }
  p.live = live;

  // `sub` is the line under their name, as text; a friend's comes as HTML
  // (`subHtml`, from UI.friendSub).
  function addPerson(person, sub, subHtml){
    if (person && person.id && !p.st.people[person.id]) p.st.people[person.id] = { person, sub: sub || '', subHtml: subHtml || '' };
  }
  p.addPerson = addPerson;

  async function loadAll(){
    const st = p.st;
    const [friends, suggested, lists, past, onList] = await Promise.all([
      allPages('/me/friends', 'friends', 10),
      api('GET', '/me/friends/suggested?limit=30').then((r) => (r.res.ok ? r.data.friends : [])),
      api('GET', '/me/lists').then((r) => (r.res.ok ? r.data.lists : [])),
      api('GET', '/me/events/past?limit=20').then((r) => (r.res.ok ? r.data.events : [])),
      cfg.loadTaken()
    ]);
    // Friends first, so their line ("Invitation, 3 events together") wins
    // over "On Drag Race".
    suggested.concat(friends.items).forEach((f) => addPerson(f.person, '', UI.friendSub(f, 'invite')));
    st.suggestedIds = suggested.map((f) => f.person.id);
    st.lists = await Promise.all(lists.filter((l) => l.id !== cfg.skipList).map(async (l) => {
      const members = await allPages('/me/lists/' + encodeURIComponent(l.id) + '/members', 'members', 10);
      members.items.forEach((m) => addPerson(m.person, t('invite.fromList', { list: l.name })));
      return { id: l.id, name: l.name, memberIds: members.items.map((m) => m.person.id) };
    }));
    st.past = past.filter((e) => e.id !== cfg.skipEvent);
    st.onList = onList;
  }

  // A fresh start (the first time) or the same picks with the search
  // cleared (after that). Returns the state, for drawing the sheet.
  p.start = () => {
    if (!p.st){
      p.st = { kind: cfg.kind, me: cfg.me, people: {}, suggestedIds: [], lists: [], past: [], onList: {}, selected: [], query: '', lookup: null, loading: true, canSave: !!cfg.canSave };
    } else {
      Object.assign(p.st, { query: '', from: null, lookup: null, saving: false });
    }
    activePicker = p;
    return p.st;
  };

  // Loads what it needs (everything the first time; who's there after
  // that), then draws. A failure is said in the sheet.
  p.load = async () => {
    try{
      if (!p.loaded){
        await loadAll();
        p.loaded = true;
      } else {
        p.st.onList = await cfg.loadTaken();
      }
    }catch(e){
      const el = document.getElementById('inviteError');
      if (el) el.textContent = t(e instanceof AccountsDown ? 'common.accountsDown' : 'common.unreachable');
    }
    p.st.loading = false;
    p.st.selected = p.st.selected.filter(p.pickable);
    if (activePicker !== p || !document.getElementById('inviteResults')) return;
    p.drawResults();
    p.drawTray();
  };

  p.drawResults = () => {
    const box = document.getElementById('inviteResults');
    if (box) box.innerHTML = UI.inviteResults(p.st);
  };
  p.drawTray = () => {
    const box = document.getElementById('inviteTray');
    if (box) box.innerHTML = UI.inviteTray(p.st);
  };

  p.pickable = (id) => !p.st.onList[id] && id !== (cfg.me && cfg.me.id);

  // Picks or unpicks `ids`; the boxes, the lists' "Invite all" buttons and
  // the tray follow. The order picked is the tray's.
  p.setPicked = (ids, on) => {
    const st = p.st;
    const now = new Set(st.selected);
    ids.forEach((id) => {
      if (on && p.pickable(id) && !now.has(id)){ st.selected.push(id); now.add(id); }
      if (!on) now.delete(id);
    });
    if (!on) st.selected = st.selected.filter((id) => now.has(id));
    if (!st.selected.length) st.saving = false;
    sheetBox.querySelectorAll('.pick-box').forEach((c) => { c.checked = now.has(c.value); });
    sheetBox.querySelectorAll('.list-row').forEach((row) => {
      const l = st.lists.find((x) => x.id === row.getAttribute('data-list'));
      if (!l) return;
      const focused = row.contains(document.activeElement);
      row.outerHTML = UI.inviteListRow(st, l);
      if (focused){ const again = sheetBox.querySelector('.list-row[data-list="' + l.id + '"] button'); if (again) again.focus(); }
    });
    if (!st.saving) p.drawTray();
    live(t('invite.pickedLive', { count: st.selected.length }));
  };

  // Typing: the results again; and for a whole phone number or @username,
  // a lookup once they stop typing (each asked once).
  p.typed = (value) => {
    const st = p.st;
    st.query = value;
    clearTimeout(p.lookupTimer);
    const q = value.trim();
    const kind = UI.lookupKindOf(q);
    if (!kind || !cfg.me || !cfg.me.emailVerified){ st.lookup = null; p.drawResults(); return; }
    const key = kind + ':' + q.toLowerCase();
    if (p.lookups.has(key)){ st.lookup = Object.assign({ q }, p.lookups.get(key)); p.drawResults(); return; }
    st.lookup = { q, state: 'loading' };
    p.drawResults();
    p.lookupTimer = setTimeout(async () => {
      let found;
      try{
        const { res, data: d } = await api('POST', '/people/lookup', { [kind]: q }, { stay: true });
        if (res.ok){
          const person = d.person && d.person.id !== cfg.me.id ? d.person : null;
          if (person) addPerson(person, t(kind === 'phone' ? 'invite.foundByPhone' : 'invite.foundByInstagram'));
          found = person ? { state: 'found', person } : { state: 'none' };
        } else {
          const words = COPY.invite.lookupErrors[d.reason];
          found = { state: 'error', message: words ? t('invite.lookupErrors.' + d.reason) : sentence(d.error) };
        }
      }catch(e){
        found = { state: 'error', message: t('common.unreachable') };
      }
      if (found.state !== 'error') p.lookups.set(key, found);
      if (st.query.trim() !== q) return;
      st.lookup = Object.assign({ q }, found);
      p.drawResults();
      live(found.state === 'found' ? fullNameOf(found.person) : found.state === 'none' ? t('invite.lookupNone') : found.message);
    }, 450);
  };

  function refocusFrom(){
    const again = document.getElementById('inviteFrom');
    if (again){ again.disabled = false; again.focus(); }
  }

  // "Filter by past event": the list narrows to that event's hosts and its
  // going and maybe guests you can see (the guest list's own rule). Nobody
  // is ticked; the first choice ("Everyone") undoes it. Each event's people
  // are fetched once.
  p.filterByEvent = async (select) => {
    const st = p.st;
    const id = select.value;
    const ev = st.past.find((x) => x.id === id);
    if (!ev){
      st.from = null;
      p.drawResults();
      refocusFrom();
      return;
    }
    select.disabled = true;
    let words = '';
    try{
      let from = p.from.get(id);
      if (!from){
        const base = '/events/' + encodeURIComponent(id) + '/guests?status=';
        const [going, maybe] = await Promise.all([allPages(base + 'going', 'guests', 5), allPages(base + 'maybe', 'guests', 5)]);
        // Its hosts too (not on its guest list, but they were there).
        const hosts = (ev.hosts || []).map((h) => h.person);
        const people = hosts.concat(going.items.concat(maybe.items).map((g) => g.person)).filter((x) => x.id !== cfg.me.id);
        people.forEach((x) => addPerson(x, t('invite.fromEvent', { title: ev.title })));
        from = { id, title: ev.title, ids: [...new Set(people.map((x) => x.id))], hidden: !(going.first && going.first.guestsVisible !== false) };
        p.from.set(id, from);
      }
      st.from = from;
      const n = from.ids.length;
      words = from.hidden ? t('invite.fromHidden', { title: ev.title })
        : !n ? t('invite.fromEmpty', { title: ev.title })
        : n === 1 ? t('invite.fromShowingOne', { title: ev.title }) : t('invite.fromShowing', { count: n, title: ev.title });
      p.drawResults();
    }catch(e){
      const el = document.getElementById('inviteNotice');
      if (el) el.textContent = t('common.unreachable');
    }
    refocusFrom();
    if (words) live(words);
  };

  return p;
}

sheetBox.addEventListener('input', (e) => {
  if (e.target.id === 'inviteSearch' && activePicker && activePicker.st) activePicker.typed(e.target.value);
});
sheetBox.addEventListener('change', (e) => {
  if (!activePicker || !activePicker.st || !document.getElementById('inviteResults')) return;
  if (e.target.classList.contains('pick-box')) activePicker.setPicked([e.target.value], e.target.checked);
  else if (e.target.id === 'inviteFrom') activePicker.filterByEvent(e.target);
});
// Enter in a sheet's search box doesn't send anything; it's a filter.
sheetBox.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.type === 'search') e.preventDefault();
});

onActions({
  'pick-list': (btn) => {
    const p = activePicker;
    const l = p && p.st.lists.find((x) => x.id === btn.getAttribute('data-list'));
    if (!l) return;
    const ids = UI.listPickable(p.st, l);
    p.setPicked(ids, !ids.every((id) => p.st.selected.includes(id)));
  },
  // A face in the tray: unpicked, and focus moves to the next face (or
  // the search box, with none left).
  unpick: (btn) => {
    if (!activePicker) return;
    const faces = Array.from(sheetBox.querySelectorAll('.tray-face'));
    const at = faces.indexOf(btn);
    activePicker.setPicked([btn.getAttribute('data-person')], false);
    const left = Array.from(sheetBox.querySelectorAll('.tray-face'));
    const next = left[Math.min(at, left.length - 1)] || document.getElementById('inviteSearch');
    if (next) next.focus();
  }
});
