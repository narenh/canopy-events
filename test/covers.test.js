// Cover images: hosts upload JPEG, PNG, WebP or HEIC; it's stored as a
// JPEG with no EXIF, under DATA_DIR/covers; its public URL is random (not
// the event's link), changes with each upload, and stops working when the
// cover is replaced or removed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { startServer, client, makeEvent } = require('./harness');

const image = (format, { width = 800, height = 600, alpha = false } = {}) =>
  sharp({ create: { width, height, channels: alpha ? 4 : 3, background: alpha ? { r: 10, g: 56, b: 0, alpha: 0.5 } : '#0A3800' } })[format]();

test('cover images', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const P = server.people;
  const [ana, ben, fay] = ['ana', 'ben', 'fay'].map((n) => client(server, n));
  const anon = client(server, null);
  const put = (who, id, buffer, opts) => who.upload('PUT', `/api/v1/events/${id}/cover`, buffer, opts);
  const fetchCover = (url) => fetch(url.replace(/^https?:\/\/[^/]+/, server.base));

  await t.test('a host uploads one; anyone with the URL gets a JPEG with no EXIF', async () => {
    const e = await makeEvent(ana);
    assert.equal(e.coverImageUrl, null);
    // A big photo, on its side, with EXIF.
    const photo = await image('jpeg', { width: 3200, height: 1800 }).withMetadata({ orientation: 6 }).toBuffer();
    assert.ok((await sharp(photo).metadata()).exif);
    const r = await put(ana, e.id, photo, { type: 'image/jpeg', filename: 'IMG_0001.jpg' });
    assert.equal(r.status, 200, r.text);
    const url = r.data.event.coverImageUrl;
    assert.match(url, new RegExp(`^${server.base}/covers/[0-9A-Za-z]{12}\\.jpg\\?v=\\d+$`));
    assert.ok(!url.includes(e.id), "the URL isn't the event's link");
    // Signed out, the event (a link preview) has it, and so does the file.
    assert.equal((await anon.get(`/api/v1/events/${e.id}`)).data.event.coverImageUrl, url);
    const img = await fetchCover(url);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/jpeg');
    assert.match(img.headers.get('cache-control'), /^public, max-age=\d+$/);
    const jpeg = Buffer.from(await img.arrayBuffer());
    const meta = await sharp(jpeg).metadata();
    assert.equal(meta.format, 'jpeg');
    assert.equal(meta.exif, undefined, 'no EXIF, so no location');
    // Turned upright (it was 3200 wide on its side) and shrunk to 1600.
    assert.deepEqual([meta.width, meta.height], [900, 1600]);
    // On disk under DATA_DIR/covers, by the event.
    assert.ok(fs.existsSync(path.join(server.dataDir, 'covers', `${e.id}.jpg`)));
  });

  await t.test('PNG (transparency on white), WebP and HEIC all become JPEGs', async () => {
    const e = await makeEvent(ana);
    const heic = fs.readFileSync(path.join(__dirname, 'fixtures', 'cover.heic'));
    for (const [name, buffer] of [
      ['png', await image('png', { alpha: true }).toBuffer()],
      ['webp', await image('webp').toBuffer()],
      ['heic', heic]
    ]) {
      // The type the client claims doesn't matter: the bytes do.
      const r = await put(ana, e.id, buffer, { type: 'application/octet-stream' });
      assert.equal(r.status, 200, `${name}: ${r.text}`);
      const meta = await sharp(Buffer.from(await (await fetchCover(r.data.event.coverImageUrl)).arrayBuffer())).metadata();
      assert.equal(meta.format, 'jpeg', name);
      assert.equal(meta.hasAlpha, false, name);
    }
  });

  await t.test('what an upload has to be', async () => {
    const e = await makeEvent(ana);
    let r = await put(ana, e.id, Buffer.from('GIF89a not really'), { type: 'image/gif' });
    assert.equal(r.status, 400);
    assert.equal(r.data.reason, 'bad_image');
    r = await put(ana, e.id, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), { type: 'image/jpeg' });
    assert.equal(r.data.reason, 'bad_image', 'looks like a JPEG, but is broken');
    r = await put(ana, e.id, await image('png').toBuffer(), { field: 'photo' });
    assert.equal(r.data.reason, 'bad_image', 'the wrong field');
    r = await ana.put(`/api/v1/events/${e.id}/cover`, {});
    assert.equal(r.data.reason, 'bad_image', 'no file at all');
    r = await put(ana, e.id, Buffer.alloc(15 * 1024 * 1024 + 1, 0xff));
    assert.equal(r.status, 413);
    assert.equal(r.data.reason, 'too_large');
  });

  await t.test('hosts only: co-hosts yes, guests and strangers no', async () => {
    const e = await makeEvent(ana);
    const png = await image('png').toBuffer();
    await fay.get('/api/v1/me');
    await ana.post(`/api/v1/events/${e.id}/cohosts`, { personId: P.fay.id });
    assert.equal((await put(fay, e.id, png)).status, 200);
    const r = await put(ben, e.id, png);
    assert.equal(r.status, 403);
    assert.equal(r.data.reason, 'hosts_only');
    assert.equal((await ben.del(`/api/v1/events/${e.id}/cover`)).data.reason, 'hosts_only');
    assert.equal((await put(anon, e.id, png)).status, 401);
  });

  await t.test('a new upload is a new URL; the old one, and a removed one, stop working', async () => {
    const e = await makeEvent(ana);
    const first = (await put(ana, e.id, await image('png').toBuffer())).data.event.coverImageUrl;
    const second = (await put(ana, e.id, await image('webp').toBuffer())).data.event.coverImageUrl;
    assert.notEqual(first, second);
    assert.equal((await fetchCover(first)).status, 404);
    assert.equal((await fetchCover(second)).status, 200);
    const r = await ana.del(`/api/v1/events/${e.id}/cover`);
    assert.equal(r.data.event.coverImageUrl, null);
    assert.equal((await fetchCover(second)).status, 404);
    assert.ok(!fs.existsSync(path.join(server.dataDir, 'covers', `${e.id}.jpg`)));
    // Removing none is fine.
    assert.equal((await ana.del(`/api/v1/events/${e.id}/cover`)).status, 200);
    // Nothing else answers under /covers.
    for (const p of ['/covers/x.jpg', `/covers/${e.id}.jpg`, '/covers/AAAAAAAAAAAA.png']) assert.equal((await fetch(server.base + p)).status, 404, p);
  });

  // Each size the API lists: its URL serves a JPEG of that size, with
  // no EXIF.
  const checkSizes = async (event) => {
    for (const c of event.coverImages) {
      const r = await fetchCover(c.url);
      assert.equal(r.status, 200, c.url);
      assert.equal(r.headers.get('content-type'), 'image/jpeg');
      const meta = await sharp(Buffer.from(await r.arrayBuffer())).metadata();
      assert.deepEqual([meta.format, meta.width, meta.height, meta.exif], ['jpeg', c.width, c.height, undefined], c.url);
    }
  };
  const widths = (event) => event.coverImages.map((c) => c.width);
  const onDisk = (id) => fs.readdirSync(path.join(server.dataDir, 'covers')).filter((f) => f.startsWith(id)).sort();

  await t.test('an upload is stored at 400, 800 and 1200 px wide as well, never wider than the photo', async () => {
    const e = await makeEvent(ana);
    // Big, on its side, with EXIF: the full size is 900x1600 upright.
    const photo = await image('jpeg', { width: 3200, height: 1800 }).withMetadata({ orientation: 6 }).toBuffer();
    let up = (await put(ana, e.id, photo)).data.event;
    assert.deepEqual(up.coverImages.map((c) => [c.width, c.height]), [[400, 711], [800, 1422], [900, 1600]]);
    // The last is the full size, at coverImageUrl; the others are
    // <key>-<width>.jpg, with the same ?v=.
    assert.equal(up.coverImages[2].url, up.coverImageUrl);
    const key = /\/covers\/([0-9A-Za-z]{12})\.jpg\?v=(\d+)$/.exec(up.coverImageUrl);
    assert.deepEqual(up.coverImages.slice(0, 2).map((c) => c.url), [400, 800].map((w) => `${server.base}/covers/${key[1]}-${w}.jpg?v=${key[2]}`));
    await checkSizes(up);
    assert.deepEqual(onDisk(e.id), [`${e.id}-400.jpg`, `${e.id}-800.jpg`, `${e.id}.jpg`]);
    // Landscape and wide: all four.
    up = (await put(ana, e.id, await image('jpeg', { width: 4032, height: 3024 }).toBuffer())).data.event;
    assert.deepEqual(up.coverImages.map((c) => [c.width, c.height]), [[400, 300], [800, 600], [1200, 900], [1600, 1200]]);
    await checkSizes(up);
    // Smaller than some of the widths: only those under it, then itself.
    up = (await put(ana, e.id, await image('png', { width: 600, height: 400 }).toBuffer())).data.event;
    assert.deepEqual(widths(up), [400, 600]);
    await checkSizes(up);
    // The wider copies of the photo before went with it.
    assert.deepEqual(onDisk(e.id), [`${e.id}-400.jpg`, `${e.id}.jpg`]);
    // Smaller than all of them: itself alone.
    up = (await put(ana, e.id, await image('webp', { width: 300, height: 200 }).toBuffer())).data.event;
    assert.deepEqual(up.coverImages, [{ width: 300, height: 200, url: up.coverImageUrl }]);
    assert.deepEqual(onDisk(e.id), [`${e.id}.jpg`]);
    // Exactly a width: itself, once.
    up = (await put(ana, e.id, await image('jpeg', { width: 800, height: 600 }).toBuffer())).data.event;
    assert.deepEqual(widths(up), [400, 800]);
    // Signed out sees the same sizes (link previews, the public page).
    assert.deepEqual((await anon.get(`/api/v1/events/${e.id}`)).data.event.coverImages, up.coverImages);
    // And the lists have them.
    const listed = (await ana.get('/api/v1/me/events/hosting')).data.events.find((x) => x.id === e.id);
    assert.deepEqual(listed.coverImages, up.coverImages);
  });

  await t.test('replacing or removing a cover, or deleting the event, takes every size with it', async () => {
    const e = await makeEvent(ana);
    const first = (await put(ana, e.id, await image('jpeg', { width: 2000, height: 1500 }).toBuffer())).data.event;
    assert.deepEqual(widths(first), [400, 800, 1200, 1600]);
    const second = (await put(ana, e.id, await image('jpeg', { width: 2000, height: 1500 }).toBuffer())).data.event;
    for (const c of first.coverImages) assert.equal((await fetchCover(c.url)).status, 404, `the old ${c.width}`);
    await checkSizes(second);
    const gone = (await ana.del(`/api/v1/events/${e.id}/cover`)).data.event;
    assert.deepEqual(gone.coverImages, []);
    for (const c of second.coverImages) assert.equal((await fetchCover(c.url)).status, 404, `the removed ${c.width}`);
    assert.deepEqual(onDisk(e.id), []);
    // Deleting the event.
    const doomed = await makeEvent(ana);
    await put(ana, doomed.id, await image('jpeg', { width: 2000, height: 1500 }).toBuffer());
    assert.equal(onDisk(doomed.id).length, 4);
    assert.equal((await ana.del(`/api/v1/events/${doomed.id}`)).status, 200);
    assert.deepEqual(onDisk(doomed.id), []);
  });

  await t.test('only a cover\'s own names answer: junk, other widths and other files are 404', async () => {
    const e = await makeEvent(ana);
    const up = (await put(ana, e.id, await image('jpeg', { width: 1000, height: 750 }).toBuffer())).data.event;
    assert.deepEqual(widths(up), [400, 800, 1000]);
    const key = /\/covers\/([0-9A-Za-z]{12})\.jpg/.exec(up.coverImageUrl)[1];
    for (const name of [`${key}-400.jpg`, `${key}-800.jpg`, `${key}.jpg`]) assert.equal((await fetch(`${server.base}/covers/${name}`)).status, 200, name);
    for (const name of [
      `${key}-1200.jpg`, // a width it isn't stored at (wider than the photo)
      `${key}-1000.jpg`, // the full size has one name: <key>.jpg
      `${key}-1600.jpg`, `${key}-401.jpg`, `${key}-0400.jpg`, `${key}-0.jpg`, `${key}--400.jpg`, `${key}-400-800.jpg`,
      `${key}-400.png`, `${key}-400.webp`, `${key}-400.jpg.tmp`, `${key}-400.JPG`, `${key}-4e2.jpg`, `${key}-400 .jpg`,
      `${key}-400.jpg%00.png`, `${key}-9999999.jpg`, `${key.slice(0, 11)}-400.jpg`,
      `${e.id}-400.jpg`, `${e.id}.jpg`, // the event's id is never a cover's name
      '..%2Fevents.db', '..%2F..%2Fpackage.json', `${key}-400.jpg%2F..%2F..%2Fevents.db`, '%2E%2E%2Fevents.db', '.jpg', '-400.jpg'
    ]) {
      assert.equal((await fetch(`${server.base}/covers/${name}`)).status, 404, name);
    }
    // The store refuses a name it wasn't built for, whatever calls it.
    const coverStore = require('../lib/coverStore');
    for (const [id, width] of [['../x', null], ['AAAAAAAAAAAA/..', null], ['AAAAAAAAAAAA', 1.5], ['AAAAAAAAAAAA', '400'], ['AAAAAAAAAAAA', -400], ['AAAAAAAAAAAA', 0]]) {
      assert.throws(() => coverStore.pathFor(id, width), /bad/, `${id} ${width}`);
    }
  });

  await t.test('an upload says the colour that matches the photo, and never changes the event\'s own', async () => {
    const e = await makeEvent(ana, { themeHue: 300 });
    const red = await sharp({ create: { width: 600, height: 400, channels: 3, background: '#d62828' } }).jpeg().toBuffer();
    const up = (await put(ana, e.id, red)).data.event;
    assert.ok(up.coverHue >= 15 && up.coverHue <= 40, `red: ${up.coverHue}`);
    assert.equal(up.coverGrayscale, false);
    assert.equal(up.themeHue, 300, 'the upload leaves the colour alone');
    assert.equal(up.themeGrayscale, false);
    // Signed out sees it too (covers are public).
    assert.equal((await anon.get(`/api/v1/events/${e.id}`)).data.event.coverHue, up.coverHue);
    const grey = await sharp({ create: { width: 600, height: 400, channels: 3, background: '#7a7a7a' } }).png().toBuffer();
    const g = (await put(ana, e.id, grey)).data.event;
    assert.equal(g.coverHue, null);
    assert.equal(g.coverGrayscale, true);
    const gone = (await ana.del(`/api/v1/events/${e.id}/cover`)).data.event;
    assert.equal(gone.coverHue, null);
    assert.equal(gone.coverGrayscale, false);
  });
});

// The hue that matches a photo (lib/coverImage.js hueOf, which is
// public/ui.js hueFromPixels on a 64×64 copy), on made-up photos.
test('the colour that matches a photo', async (t) => {
  const { hueOf } = require('../lib/coverImage');
  // A photo of bands of colour, top to bottom: [[css colour, share], ...].
  const bands = async (list, { width = 300, height = 300 } = {}) => {
    let y = 0;
    const parts = list.map(([colour, share]) => {
      const h = Math.round(height * share);
      const part = `<rect x="0" y="${y}" width="${width}" height="${h}" fill="${colour}"/>`;
      y += h;
      return part;
    }).join('');
    return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts}</svg>`)).jpeg().toBuffer();
  };
  const near = (hue, target, within = 15) => Math.min(Math.abs(hue - target), 360 - Math.abs(hue - target)) <= within;

  await t.test('mostly red is about red', async () => {
    const { hue, grayscale } = await hueOf(await bands([['#c81e1e', 0.85], ['#f2f2f2', 0.15]]));
    assert.equal(grayscale, false);
    assert.ok(near(hue, 27), `red: ${hue}`);
  });

  await t.test('a blue sky over a green field: whichever there is more of', async () => {
    const sky = (await hueOf(await bands([['#3b82f6', 0.65], ['#2e9e44', 0.35]]))).hue;
    assert.ok(near(sky, 260), `mostly sky: ${sky}`);
    const field = (await hueOf(await bands([['#3b82f6', 0.3], ['#2e9e44', 0.7]]))).hue;
    assert.ok(near(field, 146), `mostly field: ${field}`);
  });

  await t.test('a grey photo has no hue, even with a speck of colour', async () => {
    assert.deepEqual(await hueOf(await bands([['#111', 0.3], ['#777', 0.4], ['#eee', 0.3]])), { hue: null, grayscale: true });
    assert.deepEqual(await hueOf(await bands([['#808080', 0.98], ['#ff0000', 0.02]])), { hue: null, grayscale: true });
  });

  await t.test('very dark and very light colour doesn\'t count; a hue wraps round 0', async () => {
    // Nearly black blue and a pastel that's nearly white, with a little
    // magenta-red, which is the only colour that counts.
    const { hue } = await hueOf(await bands([['#05060f', 0.45], ['#fdfbff', 0.45], ['#d6246a', 0.1]]));
    assert.ok(near(hue, 0, 25), `wraps: ${hue}`);
  });
});
