// A stand-in for TMDB: the API calls lib/backgrounds.js makes (a v4 list,
// paginated, and each title's images) and the image CDN (/t/p/<size>/<file>),
// whose JPEGs are made here, one flat colour per file, so no image is in
// the repo. In the test's own process, so a test can take it down, change
// the list, and see every request it got.
//
// The server is pointed at it with TMDB_API_BASE=<base> and
// TMDB_IMAGE_BASE=<base>/t/p.

const express = require('express');
const sharp = require('sharp');

const TOKEN = 'tmdb_test-read-access-token_5f3a9c1e7b2d';
const LIST_ID = '8100';

// A valid TMDB-looking file path from a word.
const file = (word) => `/${word.padEnd(27, 'x').slice(0, 27)}.jpg`;

// Each size's width; the height keeps 16:9.
const SIZE_WIDTHS = { w300: 300, w780: 780, w1280: 1280, original: 2000 };

function makeData() {
  const backdrop = (word, colour, { lang = null, votes = 5, width = 3840 } = {}) => ({ word, colour, file_path: file(word), iso_639_1: lang, vote_average: votes, width, height: Math.round(width * 9 / 16) });
  return {
    lists: {
      [LIST_ID]: [
        { media_type: 'movie', id: 603, title: 'The Matrix', release_date: '1999-03-31' },
        { media_type: 'tv', id: 1396, name: 'Breaking Bad', first_air_date: '2008-01-20' },
        // Its images can't be had: left out.
        { media_type: 'movie', id: 999, title: 'Broken', release_date: '2001-01-01' },
        // Not a film or a show: ignored.
        { media_type: 'person', id: 6384, name: 'Keanu Reeves' },
        { media_type: 'movie', id: 155, title: 'The Dark Knight', release_date: '2008-07-16' }
      ]
    },
    images: {
      'movie:603': [
        backdrop('matrixGreenText', '#1f9d3a', { lang: 'en', votes: 9.9 }),
        backdrop('matrixGreenA', '#1f9d3a', { votes: 5.6 }),
        backdrop('matrixGreenB', '#2bb04a', { votes: 5.6, width: 1920 }),
        backdrop('matrixGreenC', '#2bb04a', { votes: 5.2 }),
        backdrop('matrixGreenD', '#2bb04a', { votes: 7.1 }),
        backdrop('matrixGreenE', '#2bb04a', { votes: 5.6, width: 1280 })
      ],
      // Only backdrops with words on them: those, then.
      'tv:1396': [
        backdrop('breakingBadEn', '#e0b020', { lang: 'en', votes: 6 }),
        backdrop('breakingBadDe', '#e0b020', { lang: 'de', votes: 4 })
      ],
      'movie:155': [backdrop('darkKnightGrey', '#6f6f6f', { votes: 6 })]
    },
    // Files the manifest names (the CDN has them; the API isn't asked).
    extra: {
      [file('redSunset')]: '#d62828',
      [file('redSunsetTwo')]: '#c81e1e',
      [file('blueSea')]: '#2a6fdb'
    }
  };
}

async function startFakeTmdb() {
  const data = makeData();
  const state = {
    data,
    // Everything answers 503 (an outage), or only the API, or only the CDN.
    down: false,
    apiDown: false,
    cdnDown: false,
    // Every request: { path, size (CDN), authorization (API) }.
    requests: [],
    // Items per list page.
    pageSize: 2
  };
  const colourOf = (filePath) => {
    for (const list of Object.values(data.images)) {
      const b = list.find((x) => x.file_path === filePath);
      if (b) return b.colour;
    }
    return data.extra[filePath] || null;
  };
  const jpegs = new Map();

  const app = express();
  app.use((req, res, next) => {
    state.requests.push({ path: req.path, authorization: req.get('authorization') || null });
    next();
  });
  app.use('/4', (req, res, next) => (state.down || state.apiDown ? res.status(503).json({ status_message: 'down' }) : next()));
  app.use('/3', (req, res, next) => (state.down || state.apiDown ? res.status(503).json({ status_message: 'down' }) : next()));
  app.use('/t', (req, res, next) => (state.down || state.cdnDown ? res.status(503).end() : next()));
  const authorized = (req, res, next) => {
    if (req.get('authorization') !== `Bearer ${TOKEN}`) return res.status(401).json({ status_code: 7, status_message: 'Invalid API key' });
    next();
  };

  app.get('/4/list/:id', authorized, (req, res) => {
    const items = data.lists[req.params.id];
    if (!items) return res.status(404).json({ status_code: 34 });
    const page = Math.max(1, Number(req.query.page) || 1);
    const pages = Math.max(1, Math.ceil(items.length / state.pageSize));
    res.json({ id: Number(req.params.id), page, total_pages: pages, total_results: items.length, results: items.slice((page - 1) * state.pageSize, page * state.pageSize) });
  });

  app.get('/3/:type/:id/images', authorized, (req, res) => {
    const key = `${req.params.type}:${req.params.id}`;
    if (key === 'movie:999') return res.status(500).json({ status_code: 11 });
    let list = data.images[key];
    if (!list) return res.status(404).json({ status_code: 34 });
    // include_image_language=null: only the ones with no language.
    if (req.query.include_image_language === 'null') list = list.filter((b) => b.iso_639_1 === null);
    res.json({ id: Number(req.params.id), backdrops: list.map(({ word, colour, ...b }) => ({ aspect_ratio: 1.778, ...b })), logos: [], posters: [] });
  });

  app.get('/t/p/:size/:file', async (req, res) => {
    const width = SIZE_WIDTHS[req.params.size];
    const filePath = `/${req.params.file}`;
    const colour = colourOf(filePath);
    if (!width || !colour) return res.status(404).end();
    const key = `${req.params.size}${filePath}`;
    if (!jpegs.has(key)) {
      jpegs.set(key, await sharp({ create: { width, height: Math.round(width * 9 / 16), channels: 3, background: colour } }).jpeg().toBuffer());
    }
    res.set('Content-Type', 'image/jpeg');
    res.set('Access-Control-Allow-Origin', '*');
    res.send(jpegs.get(key));
  });

  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return Object.assign(state, {
    base,
    imageBase: `${base}/t/p`,
    // The server's settings to use this fake (and the list).
    env(extra = {}) {
      return { TMDB_TOKEN: TOKEN, TMDB_LIST_ID: LIST_ID, TMDB_API_BASE: base, TMDB_IMAGE_BASE: `${base}/t/p`, ...extra };
    },
    apiRequests() { return state.requests.filter((r) => r.path.startsWith('/3/') || r.path.startsWith('/4/')); },
    cdnRequests() { return state.requests.filter((r) => r.path.startsWith('/t/')); },
    close() { return new Promise((resolve) => server.close(resolve)); }
  });
}

module.exports = { startFakeTmdb, TOKEN, LIST_ID, file };
