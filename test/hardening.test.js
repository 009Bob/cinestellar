// Checks for the fixes from the pre-release security review.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../src/server/app.js';
import { ConfigStore } from '../src/server/config.js';
import { PlexClient } from '../src/importer/plex.js';
import { PlexTv } from '../src/importer/plextv.js';
import { normalizeMovie } from '../src/importer/normalize.js';
import { runImport, newProgress } from '../src/importer/importer.js';
import { MemoryStore } from './fixtures/memory-store.js';
import { startMockPlex, GOOD_TOKEN, SERVER_ID } from './fixtures/mock-plex.js';

const LIB = [{ key: '1', title: 'Movies' }];

async function serve(opts = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cinestellar-'));
  const config = new ConfigStore(dir);
  await config.load();
  const { app } = createApp({ store: new MemoryStore(), config, ...opts });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (p, { method = 'GET', body, headers = {} } = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, headers: res.headers, text: await res.text() };
  };
  return { config, call, close: () => new Promise((r) => server.close(r)) };
}

test('the UI cannot be framed or loaded by other sites, and has a strict content policy', async () => {
  const h = await serve();
  try {
    const page = await h.call('/');
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.equal(page.headers.get('cross-origin-resource-policy'), 'same-origin');
    const csp = page.headers.get('content-security-policy');
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.match(csp, /object-src 'none'/);
  } finally { await h.close(); }
});

test('other websites cannot use the API, not even with simple GETs', async () => {
  const h = await serve();
  try {
    for (const site of ['cross-site', 'same-site']) {
      assert.equal((await h.call('/api/status', { headers: { 'Sec-Fetch-Site': site } })).status, 403, site);
      assert.equal((await h.call('/api/image?label=Movie&key=x', { headers: { 'Sec-Fetch-Site': site } })).status, 403, site);
    }
    assert.equal((await h.call('/api/status', { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
    assert.equal((await h.call('/api/status', { headers: { 'Sec-Fetch-Site': 'none' } })).status, 200, 'typed into the address bar');
    assert.equal((await h.call('/api/status')).status, 200, 'non-browser clients send no such header');
    assert.equal((await h.call('/', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 200, 'the page itself may be linked to');
  } finally { await h.close(); }
});

test('repeated wrong passwords are slowed down', async () => {
  const h = await serve({ password: 's3cret' });
  const basic = (pw) => ({ Authorization: `Basic ${Buffer.from(`x:${pw}`).toString('base64')}` });
  try {
    for (let i = 0; i < 10; i++) assert.equal((await h.call('/api/status', { headers: basic('nope') })).status, 401);
    assert.equal((await h.call('/api/status', { headers: basic('nope') })).status, 429);
    assert.equal((await h.call('/api/status', { headers: basic('s3cret') })).status, 429, 'locked for a minute, even with the right one');
    assert.equal((await h.call('/healthz')).status, 200);
  } finally { await h.close(); }
});

test('pointing the app at something that is not Plex does not echo what answered', async () => {
  const other = http.createServer((req, res) => res.end('<!DOCTYPE html><title>Router admin</title>secret-ish'));
  await new Promise((r) => other.listen(0, '127.0.0.1', r));
  const h = await serve();
  try {
    const r = await h.call('/api/plex/connect', { method: 'POST', body: { url: `http://127.0.0.1:${other.address().port}`, token: 't' } });
    assert.equal(r.status, 502);
    assert.match(r.text, /does not look like a Plex Media Server/);
    assert.ok(!r.text.includes('DOCTYPE') && !r.text.includes('secret'));
  } finally {
    await h.close();
    await new Promise((r) => other.close(r));
  }
});

test('odd Plex metadata is coerced instead of failing the batch', () => {
  const rec = normalizeMovie(
    {
      ratingKey: '9',
      title: { not: 'a string' },
      summary: ['nope'],
      year: '1999',
      audienceRating: 'abc',
      studio: 'x'.repeat(1000),
      Genre: { tag: 'not a list' },
      Guid: [{ id: 'tmdb://603' }, { id: 'imdb://tt1 OR 1=1' }, { id: `tmdb://${'9'.repeat(100)}` }],
      Role: [{ tag: 'A'.repeat(1000), tagKey: 'k'.repeat(500), role: 'r'.repeat(1000) }],
    },
    { serverId: 'S', libraryKey: '1' },
  );
  assert.equal(rec.props.title, '(untitled)');
  assert.equal(rec.props.summary, '');
  assert.equal(rec.props.year, 1999);
  assert.equal(rec.props.audienceRating, null);
  assert.equal(rec.props.tmdbId, '603');
  assert.equal(rec.props.imdbId, undefined);
  assert.deepEqual(rec.genres, []);
  assert.equal(rec.studios[0].length, 200);
  assert.ok(rec.actors[0].name.length <= 200 && rec.actors[0].role.length <= 200);
  assert.ok(rec.actors[0].key.length <= 300, 'person keys stay short enough to open and pick');
});

test('a failing save stops TMDB lookups before the import reports done', async () => {
  const mock = await startMockPlex({ extraMovies: 40 });
  try {
    const store = new MemoryStore();
    let saves = 0;
    const real = store.setFranchises.bind(store);
    store.setFranchises = async (list) => {
      saves += 1;
      if (saves === 1) throw new Error('database hiccup');
      return real(list);
    };
    let calls = 0;
    const tmdb = {
      async movieFranchise() { calls += 1; await new Promise((r) => setTimeout(r, 2)); return null; },
      async studioLogo() { return null; },
    };
    // Give every movie a TMDB id so there are plenty of lookups.
    const realUpsert = store.upsertMovies.bind(store);
    store.upsertMovies = (movies, runId) => realUpsert(movies.map((m, i) => ({ ...m, props: { ...m.props, tmdbId: String(1000 + i) } })), runId);
    const progress = newProgress();
    await runImport({ plex: new PlexClient({ url: mock.url, token: GOOD_TOKEN }), store, libraries: LIB, progress, tmdb });
    assert.equal(progress.state, 'done');
    assert.match(progress.message, /Franchise lookups stopped early \(database hiccup\)/);
    const after = calls;
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(calls, after, 'no lookups keep running in the background');
  } finally { await mock.close(); }
});

test('cancelling while Plex is still listing a library counts as cancelled, not an error', async () => {
  const mock = await startMockPlex({ listDelayMs: 300 });
  try {
    const ac = new AbortController();
    const progress = newProgress();
    const run = runImport({ plex: new PlexClient({ url: mock.url, token: GOOD_TOKEN }), store: new MemoryStore(), libraries: LIB, progress, signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    await run;
    assert.equal(progress.state, 'cancelled');
  } finally { await mock.close(); }
});

test('Sign in with Plex: a server is chosen by its place in the list, and ownership must match later', async () => {
  const mock = await startMockPlex();
  const port = Number(new URL(mock.url).port);
  const resources = [
    // A shared server claiming the same id as yours, listed first.
    { name: 'Impostor', provides: 'server', owned: false, sourceTitle: 'x', clientIdentifier: SERVER_ID, accessToken: 'other', connections: [] },
    { name: 'Mine', provides: 'server', owned: true, clientIdentifier: SERVER_ID, accessToken: GOOD_TOKEN, connections: [{ address: '127.0.0.1', port, local: true }] },
  ];
  const fetchImpl = async (u, init) => {
    const url = new URL(u);
    if (init.method === 'POST') return Response.json({ id: 1, code: 'c', expiresIn: 900 });
    if (url.pathname === '/api/v2/pins/1') return Response.json({ authToken: 'ACCOUNT' });
    if (url.pathname === '/api/v2/resources') return Response.json(resources);
    return new Response('{}', { status: 404 });
  };
  const h = await serve({ makePlexTv: (clientId) => new PlexTv({ clientId, fetchImpl }) });
  try {
    const start = JSON.parse((await h.call('/api/plex/signin', { method: 'POST', body: {} })).text);
    const done = JSON.parse((await h.call(`/api/plex/signin/${start.id}`)).text);
    const mine = done.servers.find((s) => s.name === 'Mine');
    assert.equal(mine.choice, 1);
    const wrong = await h.call(`/api/plex/signin/${start.id}/choose`, { method: 'POST', body: { choice: 1, serverId: 'someone-else' } });
    assert.equal(wrong.status, 400, 'choice and id must agree');
    const r = await h.call(`/api/plex/signin/${start.id}/choose`, { method: 'POST', body: { choice: mine.choice, serverId: mine.serverId } });
    assert.equal(r.status, 200, r.text);
    assert.equal(h.config.data.plexToken, GOOD_TOKEN);
    assert.equal(h.config.data.plexOwned, true);

    // The server "moves": re-finding it must not switch to the impostor listed first.
    await h.config.save({ plexUrl: 'http://127.0.0.1:1' });
    const libs = await h.call('/api/plex/libraries');
    assert.equal(libs.status, 200, libs.text);
    assert.equal(h.config.data.plexToken, GOOD_TOKEN);
    assert.equal(h.config.data.plexUrl, mock.url);
  } finally {
    await h.close();
    await mock.close();
  }
});
