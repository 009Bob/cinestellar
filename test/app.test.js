import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp, hostAllowed } from '../src/server/app.js';
import { ConfigStore } from '../src/server/config.js';
import { PlexClient } from '../src/importer/plex.js';
import { startMockPlex, GOOD_TOKEN, MOVIES } from './fixtures/mock-plex.js';

function fakeStore({ upsertDelayMs = 0, dedicated = true } = {}) {
  const movies = new Map();
  const searches = [];
  return {
    movies,
    searches,
    async isDedicated() { return dedicated; },
    async assertDedicated() {
      if (!dedicated) throw Object.assign(new Error('This Neo4j database already contains data that Cinestellar did not create.'), { status: 409 });
    },
    async retainOnly() {},
    async ping() {},
    async stats() { return { nodes: { Movie: movies.size }, relationships: 0 }; },
    async ensureSchema() {},
    async upsertMovies(batch) {
      if (upsertDelayMs) await new Promise((r) => setTimeout(r, upsertDelayMs));
      for (const m of batch) movies.set(m.id, m);
    },
    async deleteStale() {},
    async cleanOrphans() {},
    async search(q, opts) {
      searches.push({ q, opts });
      return [{ id: `Movie:${q}`, label: 'Movie', name: q, props: {} }];
    },
    async top() { return []; },
    async expand(label, key) {
      if (key === 'explode') throw new Error('secret db detail: password=hunter2');
      return { center: null, nodes: [], edges: [], total: 0, shown: 0 };
    },
    async overview() { return { nodes: [], edges: [] }; },
    async path() { return null; },
    async posterPath(id) { return id === 'has-poster' ? '/library/metadata/1/thumb/1' : null; },
    async imageSource(label, key) {
      if (label === 'Movie') return key === 'has-poster' ? { plex: '/library/metadata/1/thumb/1' } : null;
      if (label === 'Collection') return key === 'Matrix' ? { plex: '/library/collections/77/composite/1' } : null;
      if (label === 'Person') return key === 'plex:keanu' ? { web: 'https://metadata-static.plex.tv/people/keanu.jpg' } : null;
      if (label === 'Studio') return key === 'Sneaky' ? { web: 'http://192.168.1.1/logo.png' } : null;
      return null;
    },
  };
}

async function harness({ store = fakeStore(), password, mock, allowedHosts, webImages } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cinestellar-'));
  const config = new ConfigStore(dir);
  await config.load();
  const { app } = createApp({ store, config, password, allowedHosts, ...(webImages ? { webImages } : {}) });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (p, { method = 'GET', body, headers = {} } = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  // fetch() will not let us forge a Host header, so this one uses node:http directly.
  const withHost = (host, p = '/api/status') =>
    new Promise((resolve, reject) => {
      const req = http.request(`${base}${p}`, { headers: { Host: host } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.end();
    });
  return {
    call, withHost, store, config, dir, mock,
    close: async () => { server.close(); await mock?.close(); await fs.rm(dir, { recursive: true, force: true }); },
  };
}

test('status is open, reports unconfigured, and never contains a token', async () => {
  const h = await harness();
  try {
    const r = await h.call('/api/status');
    assert.equal(r.status, 200);
    assert.equal(r.json.configured, false);
    assert.equal(r.json.neo4j.ok, true);
    assert.ok(!r.text.includes('plexToken'));
  } finally { await h.close(); }
});

test('connect validates input, maps auth failure, and stores config privately', async () => {
  const mock = await startMockPlex();
  const h = await harness({ mock });
  try {
    assert.equal((await h.call('/api/plex/connect', { method: 'POST', body: { url: 'nope', token: 'x' } })).status, 400);
    assert.equal((await h.call('/api/plex/connect', { method: 'POST', body: {} })).status, 400);
    assert.equal((await h.call('/api/plex/connect', { method: 'POST', body: { url: mock.url, token: 'bad' } })).status, 401);

    const ok = await h.call('/api/plex/connect', { method: 'POST', body: { url: mock.url, token: GOOD_TOKEN } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.server.name, 'Mock Plex');
    assert.equal(ok.json.libraries.length, 2);

    const mode = (await fs.stat(path.join(h.dir, 'config.json'))).mode & 0o777;
    assert.equal(mode, 0o600);
    const status = await h.call('/api/status');
    assert.equal(status.json.configured, true);
    assert.ok(!status.text.includes(GOOD_TOKEN), 'token must never be sent back to the browser');
  } finally { await h.close(); }
});

test('state-changing requests must be JSON (CSRF guard)', async () => {
  const h = await harness();
  try {
    const plain = await h.call('/api/import/cancel', { method: 'POST', headers: { 'Content-Type': 'text/plain' } });
    assert.equal(plain.status, 415);
    const form = await h.call('/api/import/cancel', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.equal(form.status, 415);
    const json = await h.call('/api/import/cancel', { method: 'POST', body: {} });
    assert.equal(json.status, 200);
  } finally { await h.close(); }
});

test('import: requires a connection, rejects non-movie libraries, then runs to completion', async () => {
  const mock = await startMockPlex();
  const h = await harness({ mock });
  try {
    assert.equal((await h.call('/api/import', { method: 'POST', body: { libraries: ['1'] } })).status, 409);
    await h.call('/api/plex/connect', { method: 'POST', body: { url: mock.url, token: GOOD_TOKEN } });

    assert.equal((await h.call('/api/import', { method: 'POST', body: { libraries: [] } })).status, 400);
    assert.equal((await h.call('/api/import', { method: 'POST', body: { libraries: ['2'] } })).status, 400, 'TV library is not importable yet');

    const start = await h.call('/api/import', { method: 'POST', body: { libraries: ['1', '2'] } });
    assert.equal(start.status, 202);
    let p;
    for (let i = 0; i < 100; i++) {
      p = (await h.call('/api/import/progress')).json;
      if (p.state !== 'running') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(p.state, 'done');
    assert.equal(h.store.movies.size, MOVIES.length);
    assert.deepEqual(h.config.data.libraries.map((l) => l.key), ['1'], 'only movie libraries are remembered');
  } finally { await h.close(); }
});

test('import: a second start while one is running is refused', async () => {
  const mock = await startMockPlex();
  const h = await harness({ mock, store: fakeStore({ upsertDelayMs: 300 }) });
  try {
    await h.call('/api/plex/connect', { method: 'POST', body: { url: mock.url, token: GOOD_TOKEN } });
    assert.equal((await h.call('/api/import', { method: 'POST', body: { libraries: ['1'] } })).status, 202);
    assert.equal((await h.call('/api/import', { method: 'POST', body: { libraries: ['1'] } })).status, 409);
    await h.call('/api/import/cancel', { method: 'POST', body: {} });
    for (let i = 0; i < 100 && (await h.call('/api/import/progress')).json.state === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
  } finally { await h.close(); }
});

test('graph routes validate input and hide internal errors', async () => {
  const h = await harness();
  try {
    assert.equal((await h.call('/api/graph/expand?label=Movie&key=')).status, 400);
    assert.equal((await h.call('/api/graph/expand?label=Movie)%20DETACH%20DELETE%20(n&key=x')).status, 400, 'labels are allow-listed');
    assert.equal((await h.call('/api/graph/path?fromLabel=Person&fromKey=a&toLabel=Nope&toKey=b')).status, 400);
    assert.equal((await h.call('/api/graph/path?fromLabel=Person&fromKey=a&toLabel=Person')).status, 400);

    const none = await h.call('/api/graph/path?fromLabel=Person&fromKey=a&toLabel=Person&toKey=b');
    assert.equal(none.json.none, true);

    const boom = await h.call('/api/graph/expand?label=Person&key=explode');
    assert.equal(boom.status, 500);
    assert.ok(!boom.text.includes('hunter2'));
    assert.equal((await h.call('/api/graph/search?q=matrix')).json.results[0].name, 'matrix');
  } finally { await h.close(); }
});

test('poster proxy streams from Plex without exposing the token', async () => {
  const mock = await startMockPlex();
  const h = await harness({ mock });
  try {
    assert.equal((await h.call('/api/poster?id=has-poster')).status, 409, 'needs a Plex connection first');
    await h.call('/api/plex/connect', { method: 'POST', body: { url: mock.url, token: GOOD_TOKEN } });
    const res = await h.call('/api/poster?id=has-poster');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal((await h.call('/api/poster?id=missing')).status, 404);
    assert.equal((await h.call('/api/poster')).status, 400);
  } finally { await h.close(); }
});

test('optional password protects the whole site', async () => {
  const h = await harness({ password: 's3cret' });
  try {
    const denied = await h.call('/api/status');
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get('www-authenticate'), /Basic/);
    const basic = (pw) => ({ Authorization: `Basic ${Buffer.from(`anyone:${pw}`).toString('base64')}` });
    assert.equal((await h.call('/api/status', { headers: basic('wrong') })).status, 401);
    assert.equal((await h.call('/api/status', { headers: basic('s3cret') })).status, 200);
    assert.equal((await h.call('/', { headers: basic('s3cret') })).status, 200);
    assert.equal((await h.call('/')).status, 401);
    // Docker's health check needs no password and learns nothing from the answer.
    const health = await h.call('/healthz');
    assert.equal(health.status, 200);
    assert.equal(health.text, 'ok');
  } finally { await h.close(); }
});

test('static UI and vendored graph library are served', async () => {
  const h = await harness();
  try {
    const page = await h.call('/');
    assert.equal(page.status, 200);
    assert.match(page.text, /Cinestellar/);
    const lib = await h.call('/vendor/force-graph.min.js');
    assert.equal(lib.status, 200);
    assert.equal((await h.call('/app.js')).status, 200);
  } finally { await h.close(); }
});

test('two overlapping import requests start exactly one run', async () => {
  const mock = await startMockPlex();
  const h = await harness({ mock, store: fakeStore({ upsertDelayMs: 100 }) });
  try {
    await h.call('/api/plex/connect', { method: 'POST', body: { url: mock.url, token: GOOD_TOKEN } });
    const statuses = (await Promise.all([1, 2, 3].map(() => h.call('/api/import', { method: 'POST', body: { libraries: ['1'] } })))).map((r) => r.status).sort();
    assert.deepEqual(statuses, [202, 409, 409]);
    await h.call('/api/import/cancel', { method: 'POST', body: {} });
    for (let i = 0; i < 100 && (await h.call('/api/import/progress')).json.state === 'running'; i++) await new Promise((r) => setTimeout(r, 25));
  } finally { await h.close(); }
});

test('concurrent config saves all succeed and leave valid JSON', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cinestellar-cfg-'));
  try {
    const config = new ConfigStore(dir);
    await Promise.all(Array.from({ length: 25 }, (_, i) => config.save({ libraries: [{ key: String(i) }] })));
    const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
    assert.equal(onDisk.libraries[0].key, '24', 'last write wins, in order');
    assert.deepEqual((await fs.readdir(dir)).filter((f) => f.endsWith('.tmp')), []);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('connecting to something that is not Plex is rejected and saves nothing', async () => {
  const mock = await startMockPlex({ rootMode: 'not-plex' });
  const h = await harness({ mock });
  try {
    const r = await h.call('/api/plex/connect', { method: 'POST', body: { url: mock.url, token: GOOD_TOKEN } });
    assert.equal(r.status, 502);
    assert.equal(h.config.configured, false);
  } finally { await h.close(); }
});

test('poster proxy only passes images and survives an upstream that drops mid-body', async () => {
  const html = await startMockPlex({ posterMode: 'html' });
  const h1 = await harness({ mock: html });
  try {
    await h1.call('/api/plex/connect', { method: 'POST', body: { url: html.url, token: GOOD_TOKEN } });
    assert.equal((await h1.call('/api/poster?id=has-poster')).status, 502, 'text/html from upstream must not be served');
  } finally { await h1.close(); }

  const dropping = await startMockPlex({ posterMode: 'drop' });
  const h2 = await harness({ mock: dropping });
  try {
    await h2.call('/api/plex/connect', { method: 'POST', body: { url: dropping.url, token: GOOD_TOKEN } });
    await h2.call('/api/poster?id=has-poster').catch(() => null); // the client sees a broken response
    const alive = await h2.call('/api/status');
    assert.equal(alive.status, 200, 'the server process must still be up');
  } finally { await h2.close(); }
});

test('hostAllowed accepts LAN-only addresses and refuses public hostnames', () => {
  for (const h of ['localhost:8080', '127.0.0.1:8080', '192.168.1.20:8080', '10.0.0.5', '[::1]:8080', 'my-pc:8080', 'plex.local', 'nas.lan:8080', 'box.home.arpa']) {
    assert.ok(hostAllowed(h), h);
  }
  for (const h of ['evil.example.com', 'rebind.attacker.net:8080', '', undefined, 'bad host']) {
    assert.ok(!hostAllowed(h), String(h));
  }
  assert.ok(hostAllowed('graph.mydomain.com', ['graph.mydomain.com']));
  assert.ok(hostAllowed('GRAPH.mydomain.com.:8080', ['graph.mydomain.com']));
});

test('requests addressed to an outside hostname are refused (DNS rebinding)', async () => {
  const h = await harness({ allowedHosts: [' graph.mydomain.com:8080 ', 'https://box.fritz.box/'] });
  try {
    assert.equal(await h.withHost('evil.example.com:8080'), 403);
    assert.equal(await h.withHost('192.168.1.20:8080'), 200);
    assert.equal(await h.withHost('graph.mydomain.com'), 200, 'entries are normalised (port, spaces)');
    assert.equal(await h.withHost('box.fritz.box:8080'), 200, 'entries may be written as URLs');
  } finally { await h.close(); }
});

test('switching to a different Plex server forgets the old library choices', async () => {
  const a = await startMockPlex({ serverId: 'server-a' });
  const b = await startMockPlex({ serverId: 'server-b' });
  const h = await harness({ mock: a });
  try {
    await h.call('/api/plex/connect', { method: 'POST', body: { url: a.url, token: GOOD_TOKEN } });
    await h.config.save({ libraries: [{ key: '1', title: 'Movies' }] });
    await h.call('/api/plex/connect', { method: 'POST', body: { url: a.url, token: GOOD_TOKEN } });
    assert.equal(h.config.data.libraries.length, 1, 'reconnecting to the same server keeps them');
    await h.call('/api/plex/connect', { method: 'POST', body: { url: b.url, token: GOOD_TOKEN } });
    assert.deepEqual(h.config.data.libraries, []);
    assert.equal(h.config.data.serverId, 'server-b');
  } finally { await h.close(); await b.close(); }
});

test('import refuses a database that holds data Cinestellar did not create', async () => {
  const mock = await startMockPlex();
  const h = await harness({ mock, store: fakeStore({ dedicated: false }) });
  try {
    await h.call('/api/plex/connect', { method: 'POST', body: { url: mock.url, token: GOOD_TOKEN } });
    const r = await h.call('/api/import', { method: 'POST', body: { libraries: ['1'] } });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /did not create/);
    assert.equal((await h.call('/api/status')).json.neo4j.dedicated, false);
  } finally { await h.close(); }
});

test('search passes an allow-listed type filter through', async () => {
  const h = await harness();
  try {
    await h.call('/api/graph/search?q=keanu&types=Movie,Person');
    assert.deepEqual(h.store.searches.at(-1).opts.types, ['Movie', 'Person']);
    await h.call('/api/graph/search?q=keanu');
    assert.equal(h.store.searches.at(-1).opts.types, undefined);
  } finally { await h.close(); }
});

test('a Plex server that cannot be reached is reported as such, not as "Internal error"', async () => {
  const h = await harness();
  try {
    const r = await h.call('/api/plex/connect', { method: 'POST', body: { url: 'http://127.0.0.1:1', token: 'x' } });
    assert.equal(r.status, 502);
    assert.match(r.json.error, /Could not reach Plex at http:\/\/127\.0\.0\.1:1/);
  } finally { await h.close(); }
});

test('small posters come from the Plex resizer, falling back to the original', async () => {
  const mock = await startMockPlex();
  const h = await harness({ mock });
  try {
    await h.call('/api/plex/connect', { method: 'POST', body: { url: mock.url, token: GOOD_TOKEN } });
    const small = await h.call('/api/poster?id=has-poster&size=small');
    assert.equal(small.status, 200);
    assert.equal(small.headers.get('content-type'), 'image/jpeg');
    assert.ok(mock.hits.includes('TRANSCODE 120x180 /library/metadata/1/thumb/1'));
  } finally { await h.close(); }

  const noResize = await startMockPlex({ posterMode: 'no-transcode' });
  const h2 = await harness({ mock: noResize });
  try {
    await h2.call('/api/plex/connect', { method: 'POST', body: { url: noResize.url, token: GOOD_TOKEN } });
    const r = await h2.call('/api/poster?id=has-poster&size=small');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/png', 'fell back to the full-size image');
  } finally { await h2.close(); }
});

test('an unreachable Plex makes posters fail fast instead of timing out one by one', async () => {
  const mock = await startMockPlex();
  let made = 0;
  const h = await (async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cinestellar-'));
    const config = new ConfigStore(dir);
    await config.save({ plexUrl: 'http://127.0.0.1:1', plexToken: 'x' });
    const { app } = createApp({
      store: fakeStore(),
      config,
      makePlex: (o) => {
        made++;
        return new PlexClient(o);
      },
    });
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    return { base: `http://127.0.0.1:${server.address().port}`, close: async () => { server.close(); await mock.close(); await fs.rm(dir, { recursive: true, force: true }); } };
  })();
  try {
    const first = await fetch(`${h.base}/api/poster?id=has-poster&size=small`);
    assert.equal(first.status, 502);
    assert.match((await first.json()).error, /Could not reach Plex/);
    const t0 = Date.now();
    const second = await fetch(`${h.base}/api/poster?id=has-poster&size=small`);
    assert.equal(second.status, 503);
    assert.ok(Date.now() - t0 < 500, 'paused posters answer immediately');
    assert.equal(made, 1, 'no new Plex request while paused');
  } finally {
    await h.close();
  }
});
