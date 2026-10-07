import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cleanImageUrl } from '../src/importer/images.js';
import { normalizeMovie } from '../src/importer/normalize.js';
import { PlexClient } from '../src/importer/plex.js';
import { TmdbClient, TmdbError, pickLogo } from '../src/importer/tmdb.js';
import { runImport, newProgress } from '../src/importer/importer.js';
import { WebImages } from '../src/server/webimage.js';
import { createApp } from '../src/server/app.js';
import { ConfigStore } from '../src/server/config.js';
import { MemoryStore } from './fixtures/memory-store.js';
import { startMockPlex, GOOD_TOKEN, SERVER_ID, MOVIES } from './fixtures/mock-plex.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a20000000049454e44ae426082', 'hex');
const LIB = [{ key: '1', title: 'Movies' }];

test('only pictures from the allowed image hosts are kept, and TMDB ones are resized', () => {
  assert.equal(cleanImageUrl('https://metadata-static.plex.tv/b/people/abc.jpg'), 'https://metadata-static.plex.tv/b/people/abc.jpg');
  assert.equal(cleanImageUrl('http://image.tmdb.org/t/p/original/x1.jpg'), 'https://image.tmdb.org/t/p/w185/x1.jpg');
  assert.equal(cleanImageUrl('https://image.tmdb.org/t/p/original/logo.svg'), 'https://image.tmdb.org/t/p/w185/logo.png');
  for (const bad of [
    'http://192.168.1.1/admin.jpg',
    'https://metadata-static.plex.tv:8443/x.jpg',
    'https://user:pw@metadata-static.plex.tv/x.jpg',
    'https://metadata-static.plex.tv/%41dmin.jpg',
    'https://metadata-static.plex.tv.evil.example/x.jpg',
    'file:///etc/passwd',
    'https://image.tmdb.org/other/x.jpg',
    '/library/metadata/1/thumb/1',
    '',
    null,
  ]) assert.equal(cleanImageUrl(bad), null, String(bad));
});

test('cast and crew photos are imported, LAN addresses are dropped', () => {
  const rec = normalizeMovie(MOVIES[0], { serverId: 'S', libraryKey: '1' });
  const by = Object.fromEntries(rec.actors.map((a) => [a.name, a.thumb]));
  assert.equal(by['Keanu Reeves'], 'https://metadata-static.plex.tv/people/keanu.jpg');
  assert.equal(by['Carrie-Anne Moss'], null);
  const speed = normalizeMovie(MOVIES[3], { serverId: 'S', libraryKey: '1' });
  assert.equal(speed.actors.find((a) => a.name === 'Sandra Bullock').thumb, 'https://image.tmdb.org/t/p/w185/bullock.jpg');
});

test('studio logos only match names that clearly agree', () => {
  const results = [
    { name: 'Warner Bros. Television', logo_path: '/tv.png' },
    { name: 'Warner Bros. Pictures', logo_path: '/wb.png' },
    { name: 'Summit Entertainment', logo_path: null },
  ];
  assert.equal(pickLogo('Warner Bros. Pictures', results), 'https://image.tmdb.org/t/p/w185/wb.png');
  assert.equal(pickLogo('Warner Bros.', results), 'https://image.tmdb.org/t/p/w185/wb.png', 'filler words are ignored');
  assert.equal(pickLogo('Summit Entertainment', results), null, 'no logo, no match');
  assert.equal(pickLogo('Warner', results), null, 'a partial name is not a match');
  assert.equal(pickLogo('Lionsgate', []), null);
});

test('TMDB keys: v4 tokens go in a header, v3 keys in the query; a rejected key is an error', async () => {
  const seen = [];
  const fetchImpl = async (u, init) => {
    seen.push({ url: String(u), auth: init.headers.Authorization });
    if (String(u).includes('bad')) return new Response('{}', { status: 401 });
    return Response.json({ results: [{ name: 'Summit Entertainment', logo_path: '/s.png' }] });
  };
  const v4 = new TmdbClient({ key: 'eyJhbGciOi.token', fetchImpl });
  assert.equal(await v4.studioLogo('Summit Entertainment'), 'https://image.tmdb.org/t/p/w185/s.png');
  assert.equal(seen[0].auth, 'Bearer eyJhbGciOi.token');
  assert.ok(!seen[0].url.includes('api_key'));
  const v3 = new TmdbClient({ key: 'abc123', fetchImpl });
  await v3.studioLogo('Summit');
  assert.ok(seen[1].url.includes('api_key=abc123') && !seen[1].auth);
  await assert.rejects(new TmdbClient({ key: 'bad', fetchImpl }).studioLogo('X'), (e) => e instanceof TmdbError && e.status === 401);
});

const FRANCHISES = {
  245891: { name: 'John Wick Collection', poster: 'https://image.tmdb.org/t/p/w185/jw.jpg' },
  603: { name: 'The Matrix Collection', poster: null },
};

function fakeTmdb({ fail } = {}) {
  const asked = [];
  const movies = [];
  return {
    asked,
    movies,
    async studioLogo(name) {
      asked.push(name);
      if (fail) throw new TmdbError('TMDB rejected the API key (401)', 401);
      return name === 'Warner Bros.' ? 'https://image.tmdb.org/t/p/w185/wb.png' : null;
    },
    async movieFranchise(tmdbId) {
      movies.push(tmdbId);
      if (fail) throw new TmdbError('TMDB rejected the API key (401)', 401);
      return FRANCHISES[tmdbId] ?? null;
    },
  };
}

test('import adds collection posters and studio logos, and looks each studio up only once', async () => {
  const mock = await startMockPlex();
  try {
    const plex = new PlexClient({ url: mock.url, token: GOOD_TOKEN });
    const store = new MemoryStore();
    const tmdb = fakeTmdb();
    const progress = newProgress();
    await runImport({ plex, store, libraries: LIB, progress, tmdb });
    assert.equal(progress.state, 'done', progress.message);
    assert.equal(progress.message, 'Import complete. 7 people had no Plex ID and were matched by name');
    assert.deepEqual(progress.pictures, {
      collections: 1,
      franchises: 1,
      franchisesChecked: 3,
      franchisesToCheck: 3,
      logos: 1,
      logosChecked: 3,
      logosToCheck: 3,
      note: '',
    });
    assert.deepEqual(await store.imageSource('Collection', 'The Matrix Collection'), { plex: '/library/collections/77/composite/1700000000' });
    assert.deepEqual(await store.imageSource('Studio', 'Warner Bros.'), { web: 'https://image.tmdb.org/t/p/w185/wb.png' });
    assert.equal(await store.imageSource('Studio', 'Summit'), null);
    assert.deepEqual(await store.imageSource('Person', 'plex:keanu'), { web: 'https://metadata-static.plex.tv/people/keanu.jpg' });
    assert.equal(await store.imageSource('Person', 'plex:moss'), null);

    await runImport({ plex, store, libraries: LIB, progress: newProgress(), tmdb });
    assert.equal(tmdb.asked.length, 3, 'studios already looked up are not asked again');
  } finally { await mock.close(); }
});

test('picture problems never fail an import, and a bad TMDB key stops lookups early', async () => {
  const mock = await startMockPlex({ collectionsMode: 'error' });
  try {
    const plex = new PlexClient({ url: mock.url, token: GOOD_TOKEN });
    const store = new MemoryStore();
    const tmdb = fakeTmdb({ fail: true });
    const progress = newProgress();
    await runImport({ plex, store, libraries: LIB, progress, tmdb });
    assert.equal(progress.state, 'done');
    assert.equal(progress.failed, 0);
    assert.match(progress.message, /Collection posters were skipped/);
    assert.match(progress.message, /Studio logos stopped early \(TMDB rejected the API key/);
    assert.match(progress.message, /Franchise lookups stopped early/);
    assert.equal((await store.moviesNeedingFranchise()).length, 3, 'nothing marked as checked');
    assert.ok(tmdb.asked.length <= 3);
    assert.equal((await store.studiosNeedingLogos()).length, 3, 'nothing marked as checked, so the next import retries');
  } finally { await mock.close(); }
});

function fakeWeb(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(String(url));
    assert.equal(init.redirect, 'manual');
    const r = routes[String(url)];
    if (!r) return new Response('nope', { status: 404 });
    return typeof r === 'function' ? r() : r.clone();
  };
  return { calls, webImages: new WebImages({ fetchImpl }) };
}

test('web pictures: allowed hosts only, images only, redirects checked, cached', async () => {
  const keanu = 'https://metadata-static.plex.tv/people/keanu.jpg';
  const { calls, webImages } = fakeWeb({
    [keanu]: new Response(PNG, { headers: { 'Content-Type': 'image/png' } }),
    'https://metadata-static.plex.tv/svg.jpg': new Response('<svg onload="alert(1)"/>', { headers: { 'Content-Type': 'image/svg+xml' } }),
    'https://metadata-static.plex.tv/hop.jpg': new Response(null, { status: 302, headers: { Location: 'http://10.0.0.1/x.jpg' } }),
    'https://metadata-static.plex.tv/ok-hop.jpg': new Response(null, { status: 301, headers: { Location: '/people/keanu.jpg' } }),
  });
  const a = await webImages.get(keanu);
  assert.equal(a.type, 'image/png');
  await webImages.get(keanu);
  assert.equal(calls.filter((c) => c === keanu).length, 1, 'second request is served from the cache');
  await assert.rejects(webImages.get('http://192.168.1.1/logo.png'), (e) => e.status === 400);
  await assert.rejects(webImages.get('https://metadata-static.plex.tv/svg.jpg'), /did not return an image/);
  await assert.rejects(webImages.get('https://metadata-static.plex.tv/hop.jpg'), /redirected somewhere unexpected/);
  assert.equal((await webImages.get('https://metadata-static.plex.tv/ok-hop.jpg')).type, 'image/png');
  await assert.rejects(webImages.get('https://metadata-static.plex.tv/missing.jpg'), (e) => e.status === 404);
});

async function app({ store, webImages }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cinestellar-'));
  const config = new ConfigStore(dir);
  await config.load();
  const { app: a } = createApp({ store, config, webImages });
  const server = await new Promise((r) => { const s = a.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    get: (p) => fetch(base + p),
    post: (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    close: () => new Promise((r) => server.close(r)),
  };
}

test('/api/image serves posters, collection art, photos and logos by node, never by address', async () => {
  const mock = await startMockPlex();
  const store = new MemoryStore();
  const plex = new PlexClient({ url: mock.url, token: GOOD_TOKEN });
  await runImport({ plex, store, libraries: LIB, progress: newProgress(), tmdb: fakeTmdb() });
  const { webImages } = fakeWeb({
    'https://metadata-static.plex.tv/people/keanu.jpg': new Response(PNG, { headers: { 'Content-Type': 'image/png' } }),
    'https://image.tmdb.org/t/p/w185/wb.png': new Response(PNG, { headers: { 'Content-Type': 'image/png' } }),
  });
  const h = await app({ store, webImages });
  try {
    await h.post('/api/plex/connect', { url: mock.url, token: GOOD_TOKEN });
    const q = (label, key, extra = '') => `/api/image?label=${label}&key=${encodeURIComponent(key)}${extra}`;
    const person = await h.get(q('Person', 'plex:keanu'));
    assert.equal(person.status, 200);
    assert.equal(person.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await h.get(q('Studio', 'Warner Bros.'))).status, 200);
    assert.equal((await h.get(q('Movie', `${SERVER_ID}:1`, '&size=small'))).status, 200);
    const col = await h.get(q('Collection', 'The Matrix Collection', '&size=small'));
    assert.equal(col.status, 200);
    assert.ok(mock.hits.some((x) => x.includes('/library/collections/77/composite/1700000000')));
    assert.equal((await h.get(q('Person', 'plex:moss'))).status, 404, 'no photo stored');
    assert.equal((await h.get(q('Genre', 'Action'))).status, 404, 'genres have no pictures');
    assert.equal((await h.get(q('Nope', 'x'))).status, 400);
    assert.equal((await h.get('/api/image?label=Person')).status, 400);
    const text = await (await h.get(q('Person', 'plex:keanu'))).arrayBuffer();
    assert.ok(!Buffer.from(text).toString('latin1').includes(GOOD_TOKEN));
  } finally {
    await h.close();
    await mock.close();
  }
});

test('web pictures: broken redirects and failed downloads are clean errors, never crashes', async () => {
  const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2, 3])); c.error(new Error('socket hang up')); } });
  const { webImages } = fakeWeb({
    'https://metadata-static.plex.tv/bad-hop.jpg': new Response(null, { status: 302, headers: { Location: 'http://[::1' } }),
    'https://metadata-static.plex.tv/drop.jpg': () => new Response(body, { headers: { 'Content-Type': 'image/jpeg' } }),
  });
  await assert.rejects(webImages.get('https://metadata-static.plex.tv/bad-hop.jpg'), (e) => e.name === 'WebImageError');
  await assert.rejects(webImages.get('https://metadata-static.plex.tv/drop.jpg'), (e) => e.name === 'WebImageError' && /download failed/.test(e.message));
});

test('a TMDB rate-limit wait stops as soon as the import is cancelled', async () => {
  const ac = new AbortController();
  const fetchImpl = async () => new Response('{}', { status: 429, headers: { 'Retry-After': '10' } });
  const t0 = Date.now();
  setTimeout(() => ac.abort(), 50);
  await assert.rejects(new TmdbClient({ key: 'k', fetchImpl }).studioLogo('X', { signal: ac.signal }), TmdbError);
  assert.ok(Date.now() - t0 < 2000);
});

test('franchises: TMDB fills in where Plex has no collection, and Plex wins when it has one', async () => {
  const mock = await startMockPlex();
  try {
    const plex = new PlexClient({ url: mock.url, token: GOOD_TOKEN });
    const store = new MemoryStore();
    const tmdb = fakeTmdb();
    await runImport({ plex, store, libraries: LIB, progress: newProgress(), tmdb });
    assert.deepEqual(tmdb.movies.sort(), ['1637', '245891', '49047'], 'movies already in a Plex collection, or without a TMDB id, are not looked up');
    const wick = await store.expand('Collection', 'John Wick Collection');
    assert.deepEqual(wick.nodes.filter((n) => n.label === 'Movie').map((n) => n.name), ['John Wick']);
    assert.deepEqual(await store.imageSource('Collection', 'John Wick Collection'), { web: 'https://image.tmdb.org/t/p/w185/jw.jpg' });
    assert.equal((await store.search('wick', { types: ['Collection'] }))[0].props.hasImage, true);

    // The next import keeps the franchise without asking TMDB again.
    tmdb.movies.length = 0;
    await runImport({ plex, store, libraries: LIB, progress: newProgress(), tmdb });
    assert.deepEqual(tmdb.movies, []);
    assert.equal((await store.expand('Collection', 'John Wick Collection')).nodes.length, 2);

    // Once Plex puts the movie in a collection, that one is used instead.
    const edited = structuredClone(MOVIES[2]);
    edited.Collection = [{ tag: 'Wick Saga' }];
    await store.upsertMovies([normalizeMovie(edited, { serverId: SERVER_ID, libraryKey: '1' })], 'manual');
    await store.cleanOrphans();
    const parts = (await store.expand('Movie', `${SERVER_ID}:3`)).nodes.filter((n) => n.label === 'Collection').map((n) => n.name);
    assert.deepEqual(parts, ['Wick Saga']);
  } finally { await mock.close(); }
});

test('TMDB franchise lookup: unknown movie ids are "no franchise", bad ids are never sent', async () => {
  const seen = [];
  const fetchImpl = async (u) => {
    seen.push(String(u));
    if (String(u).includes('/3/movie/1637')) return new Response('{}', { status: 404 });
    return Response.json({ belongs_to_collection: { name: ' Speed Collection ', poster_path: '/sp.jpg' } });
  };
  const t = new TmdbClient({ key: 'k', fetchImpl });
  assert.equal(await t.movieFranchise('1637'), null);
  assert.deepEqual(await t.movieFranchise('2'), { name: 'Speed Collection', poster: 'https://image.tmdb.org/t/p/w185/sp.jpg' });
  assert.equal(await t.movieFranchise('../search/company'), null);
  assert.equal(seen.length, 2);
});

test('TMDB key from the site: checked with TMDB, saved server-side, never echoed, wins over .env', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cinestellar-'));
  const config = new ConfigStore(dir);
  await config.load();
  const made = [];
  const makeTmdb = (key) => {
    made.push(key);
    return { async check() { if (key !== 'good-key' && key !== 'env-key') throw new TmdbError('TMDB rejected the API key (401)', 401); } };
  };
  const store = { async ping() {}, async stats() { return {}; }, async isDedicated() { return true; } };
  const { app: a } = createApp({ store, config, makeTmdb, tmdbEnvKey: 'env-key' });
  const server = await new Promise((r) => { const s = a.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (body) => {
    const res = await fetch(`${base}/api/settings/tmdb`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, text: await res.text() };
  };
  const status = async () => (await (await fetch(`${base}/api/status`)).json()).tmdb;
  try {
    assert.deepEqual(await status(), { on: true, source: 'env' });
    assert.equal((await post({ key: 'wrong-key' })).status, 400);
    assert.equal(config.data.tmdbKey ?? '', '', 'a rejected key is not saved');
    assert.equal((await post({ key: 'has spaces & stuff' })).status, 400);
    assert.equal((await post({ key: 42 })).status, 400);
    const ok = await post({ key: '  good-key ' });
    assert.equal(ok.status, 200);
    assert.ok(!ok.text.includes('good-key'));
    assert.equal(config.data.tmdbKey, 'good-key');
    assert.deepEqual(await status(), { on: true, source: 'site' });
    const raw = await (await fetch(`${base}/api/status`)).text();
    assert.ok(!raw.includes('good-key') && !raw.includes('env-key'));
    // Removing it falls back to the key from .env.
    assert.equal((await post({ key: '' })).status, 200);
    assert.deepEqual(await status(), { on: true, source: 'env' });
    // Plain-text POSTs are refused (CSRF guard).
    const csrf = await fetch(`${base}/api/settings/tmdb`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"key":"x"}' });
    assert.equal(csrf.status, 415);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
