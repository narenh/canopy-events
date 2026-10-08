// The harness itself (harness.js): what made full runs fail now and then.
//
// Each test file runs the fake account service in its own process, and its
// server in a child, many files at once. A server that's busy or starved of
// CPU across its keep-alive deadline (Node's default is 5 s) while a
// request waits unread on an idle connection closes the connection under
// the request: ECONNRESET for the client, a 503 accounts_unreachable from
// the server under test, and one failed test, often a whole file's setup.
// So the test servers keep idle connections for longer than any file.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const { startServer, client } = require('./harness');
const { KEEP_ALIVE_MS } = require('./fakeAccount');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const keepAliveOf = (res) => res.headers.get('keep-alive');

test('the test servers keep idle connections for the whole file; production keeps Node\'s 5 s', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const seconds = `timeout=${KEEP_ALIVE_MS / 1000}`;
  assert.equal(keepAliveOf(await fetch(`${server.base}/healthz`)), seconds, 'the server under test');
  assert.equal(keepAliveOf(await fetch(`${server.fake.base}/api/people?ids=`, { headers: { Authorization: `Bearer ${server.fake.key}` } })), seconds, 'the fake account service');

  // Without the setting, as in production: Node's default.
  const plain = await startServer({ KEEP_ALIVE_TIMEOUT_MS: '' });
  t.after(() => plain.stop());
  assert.equal(keepAliveOf(await fetch(`${plain.base}/healthz`)), 'timeout=5');
});

test('the fake account service, busy past 5 s, still answers a request waiting on an idle connection', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  // Ben asks from another process, started now and waiting for "go", so his
  // request goes out the moment it's told, while this one (the fake's) is
  // busy.
  const ben = server.people.ben;
  const asking = spawn(process.execPath, ['-e', `
    process.stdin.once('data', () => {
      process.stdin.destroy();
      fetch(${JSON.stringify(`${server.base}/api/v1/me`)}, { headers: { Authorization: 'Bearer ${ben.token}' } })
        .then((r) => console.log(r.status), (e) => console.log('failed', e.cause && e.cause.code));
    });
    console.log('ready');`], { stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => asking.kill());
  let answer = '';
  await new Promise((resolve) => asking.stdout.once('data', resolve));
  asking.stdout.on('data', (c) => { answer += c; });
  // Ana's request leaves the server a keep-alive connection to the fake.
  assert.equal((await client(server, 'ana').get('/api/v1/me')).status, 200);
  await sleep(1000);
  // Ben's request reaches the server, and the server's goes to the fake on
  // that connection, idle a second, while this process is busy until it's
  // been idle 5.5 s. Busy in a setImmediate, so the loop's next turn starts
  // with its timers (the keep-alive deadline, long past) before it reads
  // the request: as it can after any stretch of work, or of being starved
  // of CPU.
  asking.stdin.write('go\n');
  const until = Date.now() + 4500;
  await new Promise((resolve) => setImmediate(() => { while (Date.now() < until) { /* busy */ } resolve(); }));
  await new Promise((resolve) => asking.on('exit', resolve));
  assert.equal(answer.trim(), '200', `Ben's /me: ${answer.trim()}\n${server.output()}`);
});

test('a server that fails to start says why, and leaves nothing open behind it', async () => {
  const listening = () => process.getActiveResourcesInfo().filter((r) => r === 'TCPServerWrap').length;
  const before = listening();
  // No account service URL: the server stops at once (server.js).
  await assert.rejects(startServer({ CANOPY_ACCOUNT_URL: '' }), /server exited 1:[\s\S]*CANOPY_ACCOUNT_URL and CANOPY_ACCOUNT_KEY are both required/);
  // The fake account service is closed again: left listening, it would
  // keep this file's process alive after its tests, and hang the run.
  assert.equal(listening(), before);
});
