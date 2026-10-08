// A grey event's accent (accentHue): white by default (null), or a hue;
// only for a grey event, and cleared when it stops being grey. The page
// draws it: a grey background with the accent's colours, the browser's
// bar staying grey. The editor shows its slider only while the colour is
// grey. And the contrast holds for every accent on the grey page.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, makeEvent } = require('./harness');
const UI = require('../public/ui.js');

function lum(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a, b) {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
const vars = (style) => Object.fromEntries(style.split(';').filter(Boolean).map((d) => d.split(':')));

test('accentHue: grey events only, cleared on leaving grey, seen by everyone', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const ana = client(server, 'ana');
  const anon = client(server, null);

  // Not grey: no accent of its own.
  const green = await makeEvent(ana, { title: 'Green' });
  assert.equal(green.accentHue, null);
  let r = await ana.post('/api/v1/events', { title: 'x', startsAt: '2030-01-01T20:00:00Z', timeZone: 'UTC', accentHue: 200 });
  assert.deepEqual([r.status, r.data.reason], [400, 'accent_needs_grayscale']);
  r = await ana.patch(`/api/v1/events/${green.id}`, { accentHue: 200 });
  assert.deepEqual([r.status, r.data.reason], [400, 'accent_needs_grayscale']);
  // null is fine anywhere (it's white, or nothing).
  assert.equal((await ana.patch(`/api/v1/events/${green.id}`, { accentHue: null })).status, 200);
  for (const bad of [-1, 360, 1.5, '200', true]) {
    r = await ana.patch(`/api/v1/events/${green.id}`, { themeGrayscale: true, accentHue: bad });
    assert.deepEqual([r.status, r.data.reason], [400, 'bad_accent_hue'], String(bad));
  }

  // Grey, white by default; a hue; back to white.
  const grey = await makeEvent(ana, { title: 'Grey', themeGrayscale: true });
  assert.equal(grey.accentHue, null);
  r = await ana.patch(`/api/v1/events/${grey.id}`, { accentHue: 200 });
  assert.equal(r.data.event.accentHue, 200);
  assert.equal((await anon.get(`/api/v1/events/${grey.id}`)).data.event.accentHue, 200, 'signed out too');
  // Made grey and given an accent in one go.
  r = await ana.patch(`/api/v1/events/${green.id}`, { themeGrayscale: true, accentHue: 30 });
  assert.deepEqual([r.status, r.data.event.accentHue], [200, 30]);
  // Leaving grey clears it, in the same write; coming back is white.
  r = await ana.patch(`/api/v1/events/${grey.id}`, { themeGrayscale: false, themeHue: 300 });
  assert.deepEqual([r.data.event.themeGrayscale, r.data.event.accentHue], [false, null]);
  assert.equal(server.db().prepare('SELECT accent_hue FROM events WHERE public_id = ?').get(grey.id).accent_hue, null);
  r = await ana.patch(`/api/v1/events/${grey.id}`, { themeGrayscale: true });
  assert.equal(r.data.event.accentHue, null);
  // Leaving grey while sending a hue is refused, and changes nothing.
  await ana.patch(`/api/v1/events/${grey.id}`, { accentHue: 90 });
  r = await ana.patch(`/api/v1/events/${grey.id}`, { themeGrayscale: false, accentHue: 90 });
  assert.deepEqual([r.status, r.data.reason], [400, 'accent_needs_grayscale']);
  assert.equal((await ana.get(`/api/v1/events/${grey.id}`)).data.event.accentHue, 90);
  // The database won't hold one on a coloured event either.
  assert.throws(() => server.db().prepare('UPDATE events SET accent_hue = 10, theme_grayscale = 0 WHERE public_id = ?').run(grey.id), /CHECK/);

  // The page: grey background, the accent's colours, the bar grey.
  const page = await ana.get(`/e/${grey.id}`, { headers: { Accept: 'text/html' } });
  const style = /<html lang="en" style="([^"]+)">/.exec(page.text)[1].replace(/&#39;/g, "'");
  const v = vars(style);
  const greyBase = vars(UI.themeStyle('grey'))['--theme-base'];
  assert.equal(v['--theme-base'], greyBase);
  assert.deepEqual([v['--accent'], v['--on-accent'], v['--accent-text']], UI.accentColors(90));
  assert.ok(!('--link-weight' in v));
  assert.match(page.text, new RegExp(`<meta name="theme-color" content="${greyBase}">`));
  // White: the accent white, dark on it, links white and bolder.
  await ana.patch(`/api/v1/events/${grey.id}`, { accentHue: null });
  const white = vars(/<html lang="en" style="([^"]+)">/.exec((await anon.get(`/e/${grey.id}`, { headers: { Accept: 'text/html' } })).text)[1]);
  assert.deepEqual([white['--accent'], white['--on-accent'], white['--accent-text']], ['#ffffff', greyBase, '#ffffff']);
  assert.equal(white['--link-weight'], '700');

  // The editor: the Accent slider shown for a grey event, at its hue.
  await ana.patch(`/api/v1/events/${grey.id}`, { accentHue: 90 });
  const ed = (await ana.get(`/e/${grey.id}/edit`, { headers: { Accept: 'text/html' } })).text;
  assert.match(ed, /<div class="field" id="accentField"><label/);
  assert.match(ed, new RegExp(`id="accentHue"[^>]*value="${UI.SLIDER_GREY + 90}"`));
  const edGreen = (await ana.get(`/e/${(await makeEvent(ana, { title: 'G' })).id}/edit`, { headers: { Accept: 'text/html' } })).text;
  assert.match(edGreen, /<div class="field" id="accentField" hidden>/);
});

test('the accent: white or a hue, never grey, and readable on the grey page', () => {
  const greyBase = vars(UI.themeStyle('grey'))['--theme-base'];
  const card = '#' + UI.themeColors('grey').card.map((x) => x.toString(16).padStart(2, '0')).join('');
  // Without an accent, grey is white now.
  assert.deepEqual(UI.accentColors(UI.WHITE), ['#ffffff', greyBase, '#ffffff']);
  assert.equal(vars(UI.themeStyle('grey'))['--accent'], '#ffffff');
  // A coloured event ignores it: its accent follows its own hue.
  assert.equal(UI.themeStyle(300, 10), UI.themeStyle(300));
  assert.equal(UI.accentKeyOf({ themeGrayscale: false, accentHue: 10 }), null);
  assert.equal(UI.accentKeyOf({ themeGrayscale: true, accentHue: null }), UI.WHITE);
  assert.equal(UI.accentKeyOf({ themeGrayscale: true, accentHue: 10 }), 10);
  // The slider: white, then the wheel; there and back.
  assert.equal(UI.accentOfSlider(0), UI.WHITE);
  assert.equal(UI.accentOfSlider(UI.SLIDER_GREY), 0);
  for (const a of [UI.WHITE, 0, 200, 359]) assert.equal(UI.accentOfSlider(UI.accentSliderOf(a)), a);
  assert.match(UI.editorForm({ event: { id: 'AAAAAAAAAAAA', title: 'x', startsAt: '2030-01-01T20:00:00.000Z', timeZone: 'UTC', themeGrayscale: true } }),
    /id="accentHue"[^>]*style="--track:linear-gradient\(to right, #ffffff 0%/);

  // Contrast, every accent on the grey page: dark text on the accent and
  // links on the base and on a card, at least 4.5:1 (the numbers in
  // public/ui.js are the worst of these).
  let worst = { onAccent: Infinity, links: Infinity, linksOnCard: Infinity };
  for (const a of [UI.WHITE, ...Array.from({ length: 360 }, (_, h) => h)]) {
    const [accent, on, link] = UI.accentColors(a);
    worst = {
      onAccent: Math.min(worst.onAccent, contrast(accent, on)),
      links: Math.min(worst.links, contrast(link, greyBase)),
      linksOnCard: Math.min(worst.linksOnCard, contrast(link, card))
    };
    // Never grey: a hue's accent has colour.
    if (a !== UI.WHITE) {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(accent.slice(i, i + 2), 16));
      assert.ok(Math.max(r, g, b) - Math.min(r, g, b) > 20, `${a}: ${accent}`);
    }
  }
  assert.ok(worst.onAccent >= 5.0, JSON.stringify(worst));
  assert.ok(worst.links >= 14.5, JSON.stringify(worst));
  assert.ok(worst.linksOnCard >= 13.2, JSON.stringify(worst));
});
