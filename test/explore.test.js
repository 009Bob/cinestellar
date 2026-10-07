// Exploration features (filters, "more like this", facets) against the in-memory store, plus
// the HTTP layer that feeds them. The real Cypher is covered by scripts/smoke.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from './fixtures/memory-store.js';
import { normalizeFilters, normalizePicks } from '../src/server/graph.js';
import { createApp } from '../src/server/app.js';
import { ConfigStore } from '../src/server/config.js';
import { PlexClient } from '../src/importer/plex.js';
import { runImport, newProgress } from '../src/importer/importer.js';
import { startMockPlex, GOOD_TOKEN, SERVER_ID } from './fixtures/mock-plex.js';

async function loadedStore() {
  const mock = await startMockPlex();
  const store = new MemoryStore();
  await runImport({ plex: new PlexClient({ url: mock.url, token: GOOD_TOKEN }), store, libraries: [{ key: '1', title: 'Movies' }], progress: newProgress() });
  await mock.close();
  return store;
}

const movie = (n) => `${SERVER_ID}:${n}`;

test('normalizeFilters reads query-string values and ignores junk', () => {
  const f = normalizeFilters({ yearFrom: '1990', yearTo: '', minRating: 'abc', genres: 'Action, Sci-Fi,', contentRatings: ['R'] });
  assert.deepEqual(f, { yearFrom: 1990, yearTo: null, minRating: null, genres: ['Action', 'Sci-Fi'], contentRatings: ['R'], active: true });
  assert.equal(normalizeFilters({}).active, false);
  assert.equal(normalizeFilters({ genres: Array.from({ length: 80 }, (_, i) => `g${i}`) }).genres.length, 50);
});

test('more like this ranks shared collection and director above shared genre', async () => {
  const store = await loadedStore();
  const sim = await store.similar(movie('1')); // The Matrix
  assert.equal(sim[0].name, 'The Matrix Reloaded');
  assert.ok(sim[0].shared.includes('The Matrix Collection'));
  assert.ok(sim[0].shared.includes('Lana Wachowski'));
  const wick = sim.find((s) => s.name === 'John Wick');
  assert.ok(wick, 'shares Keanu and Action');
  assert.ok(sim[0].score > wick.score);
  // Each shared person counts once, by their strongest link: collection 6 + two directors 5+5 +
  // three top-billed actors 3x3 + one producer 1.5 + two genres + one studio.
  assert.equal(sim[0].score, 29.5);
  assert.equal(sim[0].shared[0], 'The Matrix Collection', 'reasons are listed strongest first');
  assert.ok(!sim.some((s) => s.name === 'The Matrix'), 'never suggests itself');
});

test('filters narrow both expansion and suggestions, but never hide people or genres', async () => {
  const store = await loadedStore();
  const keanu = await store.expand('Person', 'plex:keanu', 60, normalizeFilters({ yearFrom: 2000 }));
  assert.deepEqual(keanu.nodes.filter((n) => n.label === 'Movie').map((n) => n.name).sort(), ['John Wick', 'The Lake House', 'The Matrix Reloaded']);
  assert.equal(keanu.total, 3);

  const matrix = await store.expand('Movie', movie('1'), 60, normalizeFilters({ yearFrom: 2050 }));
  assert.equal(matrix.total, 13, "a movie's own cast, crew and genres are not filtered");

  const romance = await store.similar(movie('4'), 12, normalizeFilters({ genres: 'Romance' }));
  assert.deepEqual(romance.map((s) => s.name), ['The Lake House']);
  const rated = await store.similar(movie('1'), 12, normalizeFilters({ minRating: 7.5 }));
  assert.ok(rated.every((s) => (s.props.audienceRating ?? 0) >= 7.5));
});

test('the genre map respects filters', async () => {
  const store = await loadedStore();
  const o = await store.overview(30, normalizeFilters({ yearTo: 1999 }));
  assert.deepEqual(o.nodes.map((n) => [n.name, n.count]), [['Action', 2], ['Sci-Fi', 1], ['Thriller', 1]]);
});

test('facets describe the library for the filter controls', async () => {
  const store = await loadedStore();
  const f = await store.facets();
  assert.equal(f.minYear, 1994);
  assert.equal(f.maxYear, 2014);
  assert.deepEqual(f.contentRatings, ['R']);
  assert.equal(f.genres[0].name, 'Action');
  assert.equal(f.needsReimport, false);
});

test('similar, facets and filtered expand are served over HTTP', async () => {
  const store = await loadedStore();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-explore-'));
  const config = new ConfigStore(dir);
  const { app } = createApp({ store, config });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => { const r = await fetch(base + p); return { status: r.status, json: await r.json() }; };
  try {
    const sim = await get(`/api/graph/similar?id=${encodeURIComponent(movie('1'))}&limit=2`);
    assert.equal(sim.status, 200);
    assert.equal(sim.json.results.length, 2);
    assert.equal((await get('/api/graph/similar')).status, 400);

    const exp = await get('/api/graph/expand?label=Person&key=plex%3Akeanu&yearTo=1999');
    assert.deepEqual(exp.json.nodes.filter((n) => n.label === 'Movie').map((n) => n.name).sort(), ['Speed', 'The Matrix']);

    const facets = await get('/api/graph/facets');
    assert.equal(facets.json.maxYear, 2014);
  } finally {
    server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('combining picks keeps only movies that match all of them', async () => {
  const store = await loadedStore();
  const keanuWarner = await store.intersect([{ label: 'Person', key: 'plex:keanu' }, { label: 'Studio', key: 'Warner Bros.' }]);
  assert.deepEqual(keanuWarner.nodes.filter((n) => n.label === 'Movie').map((n) => n.name), ['The Matrix', 'The Matrix Reloaded']);
  assert.equal(keanuWarner.total, 2);
  assert.deepEqual(keanuWarner.picks.map((p) => p.name), ['Keanu Reeves', 'Warner Bros.']);
  assert.ok(keanuWarner.edges.every((e) => [e.source, e.target].some((x) => x.startsWith('Person:') || x.startsWith('Studio:'))));

  const keanuBullock = await store.intersect([{ label: 'Person', key: 'plex:keanu' }, { label: 'Person', key: 'plex:bullock' }]);
  assert.deepEqual(keanuBullock.nodes.filter((n) => n.label === 'Movie').map((n) => n.name).sort(), ['Speed', 'The Lake House']);

  const filtered = await store.intersect([{ label: 'Person', key: 'plex:keanu' }], 150, normalizeFilters({ yearFrom: 2000 }));
  assert.equal(filtered.total, 3);
  const none = await store.intersect([{ label: 'Person', key: 'plex:keanu' }, { label: 'Person', key: 'name:George Clooney' }]);
  assert.equal(none.total, 0);
  assert.equal(none.picks.length, 2, 'the picks still come back so the page can show them');
  const missing = await store.intersect([{ label: 'Person', key: 'name:Nobody' }]);
  assert.equal(missing.total, 0);
});

test('browse lists narrow to the current picks and filters', async () => {
  const store = await loadedStore();
  const studios = await store.top('Studio', 25, { picks: [{ label: 'Person', key: 'plex:keanu' }] });
  assert.deepEqual(studios.map((s) => [s.name, s.count]), [['Warner Bros.', 2], ['20th Century Fox', 1], ['Summit', 1]]);
  const people = await store.top('Person', 25, { picks: [{ label: 'Person', key: 'plex:keanu' }] });
  assert.ok(!people.some((p) => p.name === 'Keanu Reeves'), 'the pick itself is not offered again');
  assert.equal(people.find((p) => p.name === 'Sandra Bullock').count, 2);
  assert.equal(people[0].name, 'Carrie-Anne Moss', 'ties broken alphabetically');
  const genres90s = await store.top('Genre', 25, { filters: normalizeFilters({ yearTo: 1999 }) });
  assert.deepEqual(genres90s.map((g) => [g.name, g.count]), [['Action', 2], ['Sci-Fi', 1], ['Thriller', 1]]);
});

test('picks are validated at the HTTP layer', async () => {
  const store = await loadedStore();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-picks-'));
  const { app } = createApp({ store, config: new ConfigStore(dir) });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => { const r = await fetch(base + p); return { status: r.status, json: await r.json() }; };
  const picks = (list) => encodeURIComponent(JSON.stringify(list));
  try {
    const ok = await get(`/api/graph/intersect?picks=${picks([{ label: 'Person', key: 'plex:keanu' }, { label: 'Studio', key: 'Warner Bros.' }])}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.json.total, 2);
    assert.equal((await get('/api/graph/intersect')).status, 400);
    assert.equal((await get(`/api/graph/intersect?picks=${picks([{ label: 'Movie', key: 'x' }])}`)).status, 400, 'movies are results, not picks');
    assert.equal((await get(`/api/graph/intersect?picks=${picks([{ label: 'Person) DETACH DELETE (n', key: 'x' }])}`)).status, 400);
    assert.equal((await get('/api/graph/intersect?picks=not-json')).status, 400);
    assert.equal((await get(`/api/graph/intersect?picks=${picks(Array.from({ length: 7 }, () => ({ label: 'Genre', key: 'Action' })))}`)).status, 400);
    const top = await get(`/api/graph/top?label=Studio&picks=${picks([{ label: 'Person', key: 'plex:keanu' }])}`);
    assert.equal(top.json.items[0].name, 'Warner Bros.');
  } finally {
    server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('picks and Browse can be limited to a role (cast, director, screenplay, producer)', async () => {
  const store = await loadedStore();
  const silver = await store.intersect([{ label: 'Person', key: 'plex:silver', role: 'PRODUCED' }]);
  assert.deepEqual(silver.nodes.filter((n) => n.label === 'Movie').map((n) => n.name), ['The Matrix', 'The Matrix Reloaded']);
  const lanaActed = await store.intersect([{ label: 'Person', key: 'name:Lana Wachowski', role: 'ACTED_IN' }]);
  assert.equal(lanaActed.total, 0, 'directed, but never acted');
  const lanaDirected = await store.intersect([{ label: 'Person', key: 'name:Lana Wachowski', role: 'DIRECTED' }]);
  assert.equal(lanaDirected.total, 2);
  const producers = await store.top('Person', 25, { role: 'PRODUCED' });
  assert.deepEqual(producers.map((p) => [p.name, p.count]), [['Joel Silver', 2]]);
  const directors = await store.top('Person', 25, { role: 'DIRECTED' });
  assert.ok(!directors.some((p) => p.name === 'Keanu Reeves'));
  const castWithLana = await store.top('Person', 25, { role: 'ACTED_IN', picks: [{ label: 'Person', key: 'name:Lana Wachowski', role: 'DIRECTED' }] });
  assert.deepEqual(castWithLana.map((p) => p.name), ['Carrie-Anne Moss', 'Keanu Reeves', 'Laurence Fishburne']);
});

test('roles are validated', () => {
  assert.throws(() => normalizePicks([{ label: 'Person', key: 'x', role: 'HACKED' }]), /Unknown role/);
  assert.throws(() => normalizePicks([{ label: 'Genre', key: 'Action', role: 'DIRECTED' }]), /Only people/);
  assert.deepEqual(normalizePicks([{ label: 'Person', key: 'x', role: 'WROTE' }]), [{ label: 'Person', key: 'x', role: 'WROTE' }]);
});

test('timeline: movies by year with decade counts, for picks or the whole library', async () => {
  const store = await loadedStore();
  const all = await store.timeline();
  assert.deepEqual(all.decades, [{ decade: 1990, count: 2 }, { decade: 2000, count: 2 }, { decade: 2010, count: 2 }]);
  assert.equal(all.total, 6);
  assert.equal(all.movies[0].name, 'The Matrix', 'best rated first');
  const keanu = await store.timeline([{ label: 'Person', key: 'plex:keanu', role: 'ACTED_IN' }]);
  assert.equal(keanu.total, 5);
  assert.deepEqual(keanu.decades.map((d) => d.count), [2, 2, 1]);
  const recent = await store.timeline([], 400, normalizeFilters({ yearFrom: 2010 }));
  assert.deepEqual(recent.movies.map((m) => m.name), ['John Wick', 'Gravity']);
  assert.equal((await store.timeline([], 2)).movies.length, 2);
});
