// The line between the web pages and the API. The pages are a client of
// /api/v1 like the apps are: they fetch it over loopback as the visitor
// (routes/pages.js), so a page can never show more than the API gives
// that person. This keeps them that way. Starting from every web entry
// point, it follows every local require() and fails if the pages reach
// anything but their own files and a few small, pure helpers: never the
// store, the database, the rules, the serializers or another route. If
// the two ever move into separate repos, this is the line they split
// along, and nothing has to be untangled.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Where the web side starts: the page routes, their renderer, and the
// scripts the browser runs (also run by the server to draw pages).
const ENTRY_POINTS = ['routes/pages.js', 'lib/render.js', 'public/ui.js', 'public/copy.js', 'public/events.js'];

// What the web side may reach. Everything else under lib/ and routes/ is
// the API's own. To add one here it must be small and pure: no store, no
// database, no request handling, nothing that knows more than a page may.
const ALLOWED = new Set([
  ...ENTRY_POINTS,
  'lib/people.js', // isVerified: reads a person the account service gave us
  'lib/domain.js', // publicBase: this site's own address
  'lib/ids.js' // EVENT_ID_RE: what an event id looks like
]);

function localRequires(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const found = [];
  for (const m of src.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
    let target = path.resolve(path.dirname(path.join(ROOT, file)), m[1]);
    if (!target.endsWith('.js')) target = fs.existsSync(target + '.js') ? target + '.js' : path.join(target, 'index.js');
    found.push(path.relative(ROOT, target).split(path.sep).join('/'));
  }
  return found;
}

test('the web pages reach the API only over HTTP, never its insides', () => {
  const reached = new Map(); // module -> the file that required it
  const queue = ENTRY_POINTS.map((f) => [f, null]);
  while (queue.length) {
    const [file, from] = queue.shift();
    if (reached.has(file)) continue;
    reached.set(file, from);
    for (const next of localRequires(file)) queue.push([next, file]);
  }
  const outside = [...reached].filter(([file]) => !ALLOWED.has(file));
  assert.deepEqual(
    outside.map(([file, from]) => `${from} requires ${file}`),
    [],
    'web code reached API internals; fetch /api/v1 instead, or move a small pure helper into ALLOWED with a reason'
  );
});

test('the boundary check sees through requires (it would catch a violation)', () => {
  // routes/events.js is the API's own: the check must find what it uses.
  const used = localRequires('routes/events.js');
  assert.ok(used.some((f) => f.startsWith('lib/store/') || f === 'lib/api.js'), 'found the API modules routes/events.js uses');
});
