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
});
