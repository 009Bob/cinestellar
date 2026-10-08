// SPDX-License-Identifier: GPL-3.0-or-later
// End-to-end check of every Cypher query against a REAL Neo4j, using a fake Plex server.
//
// Run it against the throwaway test database (works even after you've imported your library):
//   docker compose --profile test up -d neo4j-test
//   docker compose run --rm -e NEO4J_URI=bolt://neo4j-test:7687 app node scripts/smoke.js
//   docker compose --profile test rm -sf neo4j-test
//
// Safety: refuses to run if the database already contains anything, and afterwards deletes only
// the nodes it created (marked pg = true).
import assert from 'node:assert/strict';
import neo4j from 'neo4j-driver';
import { GraphStore, normalizeFilters } from '../src/server/graph.js';
import { PlexClient } from '../src/importer/plex.js';
import { normalizeMovie } from '../src/importer/normalize.js';
import { runImport, newProgress } from '../src/importer/importer.js';
import { startMockPlex, GOOD_TOKEN, MOVIES, SERVER_ID } from '../test/fixtures/mock-plex.js';

const uri = process.env.NEO4J_URI ?? 'bolt://localhost:7687';
const user = process.env.NEO4J_USER ?? 'neo4j';
const password = process.env.NEO4J_PASSWORD;
const database = process.env.NEO4J_DATABASE || undefined;
if (!password) {
  console.error('Set NEO4J_PASSWORD (and NEO4J_URI if not bolt://localhost:7687).');
  process.exit(2);
}

const store = new GraphStore({ uri, user, password, database });
const raw = neo4j.driver(uri, neo4j.auth.basic(user, password));
const q = (cypher, params = {}) => raw.executeQuery(cypher, params, { database });
const mock = await startMockPlex();
const plex = new PlexClient({ url: mock.url, token: GOOD_TOKEN });
const LIB = [{ key: '1', title: 'Movies' }];
let failed = false;

const step = async (name, fn) => {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed = true;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
};

try {
  // Neo4j can take a minute to start the first time; wait up to ~2 minutes.
  for (let attempt = 1; ; attempt++) {
    try {
      await store.ping();
      break;
    } catch (err) {
      if (err.code === 'Neo.ClientError.Security.Unauthorized') {
        console.error('Neo4j rejected the password. See "Changing the Neo4j password" in the README.');
        process.exit(2);
      }
      if (attempt >= 40) {
        console.error(`Cannot connect to Neo4j at ${uri}: ${err.message}`);
        process.exit(2);
      }
      if (attempt === 1) console.log('Waiting for Neo4j to start…');
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  const existing = await q('MATCH (n) RETURN count(n) AS c');
  const count = neo4j.integer.toNumber(existing.records[0].get('c'));
  if (count > 0) {
    console.error(`Refusing to run: this database already has ${count} node(s). Point NEO4J_URI at the empty test database (see the top of this file).`);
    process.exit(2);
  }

  // Simulate an install upgraded from v0.1, which had a unique constraint on Person.name. With two
  // different "Chris Wood"s in the mock library, the import only succeeds if it is dropped.
  await q('CREATE CONSTRAINT person_name IF NOT EXISTS FOR (n:Person) REQUIRE n.name IS UNIQUE');

  console.log('Importing the mock library…');
  const progress = newProgress();
  // A stand-in for TMDB so studio logos are exercised without a real key.
  const tmdbAsked = [];
  const tmdbMovies = [];
  const tmdb = {
    async studioLogo(name) {
      tmdbAsked.push(name);
      return name === 'Warner Bros.' ? 'https://image.tmdb.org/t/p/w185/wb.png' : null;
    },
    async movieFranchise(tmdbId) {
      tmdbMovies.push(tmdbId);
      return tmdbId === '245891' ? { name: 'John Wick Collection', poster: 'https://image.tmdb.org/t/p/w185/jw.jpg' } : null;
    },
  };
  await runImport({ plex, store, libraries: LIB, progress, tmdb });
  assert.equal(progress.state, 'done', progress.message);

  await step('schema: constraints and text indexes exist', async () => {
    const idx = await q('SHOW INDEXES YIELD name RETURN collect(name) AS names');
    const names = idx.records[0].get('names');
    for (const n of ['movie_id', 'person_key', 'genre_name', 'movie_search', 'person_search']) {
      assert.ok(names.includes(n), `missing ${n} in ${names.join(', ')}`);
    }
  });

  await step('the old v0.1 person_name constraint was removed', async () => {
    const c = await q("SHOW CONSTRAINTS YIELD name WHERE name = 'person_name' RETURN count(*) AS n");
    assert.equal(neo4j.integer.toNumber(c.records[0].get('n')), 0);
  });

  await step('stats count movies and people (same-name people kept apart)', async () => {
    const s = await store.stats();
    assert.equal(s.nodes.Movie, MOVIES.length);
    assert.equal(s.nodes.Person, 14, JSON.stringify(s.nodes));
    assert.equal(s.relationships, 56); // 55 from Plex + John Wick's franchise from TMDB
  });

  await step('whole numbers are stored as Neo4j integers (year)', async () => {
    const r = await q("MATCH (m:Movie {title:'The Matrix'}) RETURN m.year AS y");
    assert.ok(neo4j.isInt(r.records[0].get('y')), 'year was stored as a float');
  });

  await step('database is recognised as dedicated', async () => {
    assert.equal(await store.isDedicated(), true);
  });

  await step('search: case-insensitive, prefix first, type filter', async () => {
    const hits = await store.search('matrix');
    assert.deepEqual(hits.map((h) => h.name).sort(), ['The Matrix', 'The Matrix Collection', 'The Matrix Reloaded']);
    assert.equal((await store.search('KEANU'))[0].name, 'Keanu Reeves');
    const onlyPeople = await store.search('chris', { types: ['Person'] });
    assert.equal(onlyPeople.length, 2, 'two different Chris Woods');
    assert.deepEqual(onlyPeople.map((n) => n.hint).sort(), ['Gravity', 'The Lake House'], 'each shows their own film');
    assert.ok(onlyPeople.every((n) => n.label === 'Person'));
    assert.deepEqual(await store.search('m'), [], 'one letter returns nothing');
  });

  await step('expand a person returns their films with roles', async () => {
    const r = await store.expand('Person', 'plex:keanu');
    assert.equal(r.center.name, 'Keanu Reeves');
    assert.equal(r.total, 5);
    assert.ok(r.edges.some((e) => e.type === 'ACTED_IN' && e.role === 'Neo'));
    assert.ok(r.edges.every((e) => e.source && e.target));
    const two = await store.expand('Person', 'plex:keanu', 2);
    assert.equal(two.shown, 2);
    assert.equal(two.total, 5);
  });

  await step('expand a movie: every relationship type, cast in billing order', async () => {
    const r = await store.expand('Movie', `${SERVER_ID}:1`);
    const types = new Set(r.edges.map((e) => e.type));
    for (const t of ['ACTED_IN', 'DIRECTED', 'WROTE', 'PRODUCED', 'IN_GENRE', 'PRODUCED_IN', 'PART_OF', 'MADE_BY']) assert.ok(types.has(t), `missing ${t}`);
    const cast = r.edges.filter((e) => e.type === 'ACTED_IN').map((e) => e.order);
    assert.deepEqual(cast, [0, 1, 2]);
    assert.equal(r.center.props.hasPoster, true);
    for (const k of ['thumb', 'runId', 'pg', 'search', 'serverId']) assert.ok(!(k in r.center.props), `leaks ${k}`);
  });

  await step('expand of an unknown node is empty, not an error', async () => {
    const r = await store.expand('Person', 'name:Nobody Atall');
    assert.equal(r.center, null);
    assert.equal(r.total, 0);
  });

  await step('top lists people by film count', async () => {
    const top = await store.top('Person', 3);
    assert.deepEqual(top[0], { id: 'Person:plex:keanu', label: 'Person', name: 'Keanu Reeves', count: 5, props: { hasImage: true } });
  });

  await step('overview links genres that share movies', async () => {
    const o = await store.overview();
    assert.ok(o.nodes.some((n) => n.name === 'Action' && n.count === 4));
    const e = o.edges.find((x) => x.source === 'Genre:Action' && x.target === 'Genre:Thriller');
    assert.ok(e && e.weight === 2, JSON.stringify(o.edges));
  });

  await step('path finds the shortest cast chain; genres are not valid endpoints', async () => {
    const p = await store.path({ label: 'Person', key: 'plex:fishburne' }, { label: 'Person', key: 'plex:bullock' });
    assert.ok(p, 'no path');
    assert.equal(p.nodes.length, 5); // Fishburne - Matrix - Keanu - Speed/Lake House - Bullock
    assert.equal(p.edges.length, 4);
    assert.equal(await store.path({ label: 'Person', key: 'plex:bullock' }, { label: 'Person', key: 'plex:bullock' }), null);
    await assert.rejects(store.path({ label: 'Genre', key: 'Action' }, { label: 'Person', key: 'plex:bullock' }), /people and movies/);
  });

  await step('movies carry their genre list (used by the graph filters)', async () => {
    const r = await store.expand('Movie', `${SERVER_ID}:1`);
    assert.deepEqual(r.center.props.genres, ['Action', 'Sci-Fi']);
  });

  await step('facets describe the library', async () => {
    const f = await store.facets();
    assert.equal(f.minYear, 1994);
    assert.equal(f.maxYear, 2014);
    assert.deepEqual(f.contentRatings, ['R']);
    assert.deepEqual(f.genres[0], { name: 'Action', count: 4 });
    assert.equal(f.needsReimport, false);
  });

  await step('filters narrow an expansion but never hide people or genres', async () => {
    const keanu = await store.expand('Person', 'plex:keanu', 60, normalizeFilters({ yearFrom: 2000 }));
    assert.deepEqual(keanu.nodes.filter((n) => n.label === 'Movie').map((n) => n.name).sort(), ['John Wick', 'The Lake House', 'The Matrix Reloaded']);
    assert.equal(keanu.total, 3);
    const action = await store.expand('Genre', 'Action', 60, normalizeFilters({ genres: 'Thriller', contentRatings: 'R' }));
    assert.deepEqual(action.nodes.filter((n) => n.label === 'Movie').map((n) => n.name), [], 'John Wick and Speed have no content rating in the mock');
    const matrix = await store.expand('Movie', `${SERVER_ID}:1`, 60, normalizeFilters({ yearFrom: 2050, minRating: 9.9 }));
    assert.equal(matrix.total, 13);
  });

  await step('more like this: ranked, explained, filtered, never itself', async () => {
    const sim = await store.similar(`${SERVER_ID}:1`);
    assert.equal(sim[0].name, 'The Matrix Reloaded');
    assert.ok(sim[0].shared.includes('The Matrix Collection') && sim[0].shared.includes('Lana Wachowski'));
    assert.ok(sim.some((s) => s.name === 'John Wick'));
    assert.ok(!sim.some((s) => s.name === 'The Matrix'));
    assert.ok(sim[0].score > sim.find((s) => s.name === 'John Wick').score);
    assert.equal(sim[0].score, 29.5, 'collection 6 + directors 5+5 + top cast 3x3 + producer 1.5 + genres 2 + studio 1');
    assert.equal(sim[0].shared[0], 'The Matrix Collection', 'reasons strongest first');
    const romance = await store.similar(`${SERVER_ID}:4`, 12, normalizeFilters({ genres: 'Romance' }));
    assert.deepEqual(romance.map((s) => s.name), ['The Lake House']);
  });

  await step('combined picks: only movies matching every pick', async () => {
    const kw = await store.intersect([{ label: 'Person', key: 'plex:keanu' }, { label: 'Studio', key: 'Warner Bros.' }]);
    assert.deepEqual(kw.nodes.filter((n) => n.label === 'Movie').map((n) => n.name), ['The Matrix', 'The Matrix Reloaded']);
    assert.equal(kw.total, 2);
    assert.deepEqual(kw.picks.map((p) => p.name), ['Keanu Reeves', 'Warner Bros.']);
    assert.ok(kw.edges.length >= 4 && kw.edges.every((e) => e.source && e.target));
    const kb = await store.intersect([{ label: 'Person', key: 'plex:keanu' }, { label: 'Person', key: 'plex:bullock' }]);
    assert.deepEqual(kb.nodes.filter((n) => n.label === 'Movie').map((n) => n.name).sort(), ['Speed', 'The Lake House']);
    const filtered = await store.intersect([{ label: 'Person', key: 'plex:keanu' }], 150, normalizeFilters({ yearFrom: 2000 }));
    assert.equal(filtered.total, 3);
    const none = await store.intersect([{ label: 'Person', key: 'plex:keanu' }, { label: 'Person', key: 'name:George Clooney' }]);
    assert.equal(none.total, 0);
    assert.equal(none.picks.length, 2);
  });

  await step('browse lists narrow to the current picks and filters', async () => {
    const studios = await store.top('Studio', 25, { picks: [{ label: 'Person', key: 'plex:keanu' }] });
    assert.deepEqual(studios.map((x) => [x.name, x.count]), [['Warner Bros.', 2], ['20th Century Fox', 1], ['Summit', 1]]);
    const people = await store.top('Person', 25, { picks: [{ label: 'Person', key: 'plex:keanu' }] });
    assert.ok(!people.some((x) => x.name === 'Keanu Reeves'));
    const genres90s = await store.top('Genre', 25, { filters: normalizeFilters({ yearTo: 1999 }) });
    assert.deepEqual(genres90s.map((g) => [g.name, g.count]), [['Action', 2], ['Sci-Fi', 1], ['Thriller', 1]]);
  });

  await step('picks and Browse limited to a role', async () => {
    const silver = await store.intersect([{ label: 'Person', key: 'plex:silver', role: 'PRODUCED' }]);
    assert.deepEqual(silver.nodes.filter((n) => n.label === 'Movie').map((n) => n.name), ['The Matrix', 'The Matrix Reloaded']);
    const lanaActed = await store.intersect([{ label: 'Person', key: 'name:Lana Wachowski', role: 'ACTED_IN' }]);
    assert.equal(lanaActed.total, 0);
    const producers = await store.top('Person', 25, { role: 'PRODUCED' });
    assert.deepEqual(producers.map((p) => [p.name, p.count]), [['Joel Silver', 2]]);
    const cast = await store.top('Person', 25, { role: 'ACTED_IN', picks: [{ label: 'Person', key: 'name:Lana Wachowski', role: 'DIRECTED' }] });
    assert.deepEqual(cast.map((p) => p.name), ['Carrie-Anne Moss', 'Keanu Reeves', 'Laurence Fishburne']);
  });

  await step('timeline: decade counts and best-rated movies, whole library or picks', async () => {
    const all = await store.timeline();
    assert.deepEqual(all.decades, [{ decade: 1990, count: 2 }, { decade: 2000, count: 2 }, { decade: 2010, count: 2 }]);
    assert.equal(all.total, 6);
    assert.equal(all.movies[0].name, 'The Matrix');
    const keanu = await store.timeline([{ label: 'Person', key: 'plex:keanu', role: 'ACTED_IN' }]);
    assert.deepEqual(keanu.decades.map((d) => d.count), [2, 2, 1]);
    const recent = await store.timeline([], 400, normalizeFilters({ yearFrom: 2010 }));
    assert.deepEqual(recent.movies.map((m) => m.name), ['John Wick', 'Gravity']);
  });

  await step('the genre map respects filters', async () => {
    const o = await store.overview(30, normalizeFilters({ yearTo: 1999 }));
    assert.deepEqual(o.nodes.map((n) => [n.name, n.count]), [['Action', 2], ['Sci-Fi', 1], ['Thriller', 1]]);
    const e = o.edges.find((x) => x.source === 'Genre:Action' && x.target === 'Genre:Sci-Fi');
    assert.equal(e?.weight, 1);
  });

  await step('pictures: cast photos, collection posters and studio logos are stored and looked up', async () => {
    assert.deepEqual(await store.imageSource('Person', 'plex:keanu'), { web: 'https://metadata-static.plex.tv/people/keanu.jpg' });
    assert.deepEqual(await store.imageSource('Person', 'plex:bullock'), { web: 'https://image.tmdb.org/t/p/w185/bullock.jpg' });
    assert.equal(await store.imageSource('Person', 'plex:moss'), null, 'a LAN address must never be stored');
    assert.deepEqual(await store.imageSource('Collection', 'The Matrix Collection'), { plex: '/library/collections/77/composite/1700000000' });
    assert.deepEqual(await store.imageSource('Studio', 'Warner Bros.'), { web: 'https://image.tmdb.org/t/p/w185/wb.png' });
    assert.equal(await store.imageSource('Studio', 'Summit'), null);
    assert.equal(await store.imageSource('Genre', 'Action'), null);
    assert.ok((await store.imageSource('Movie', `${SERVER_ID}:1`))?.plex);
    assert.equal(await store.posterPath(`${SERVER_ID}:1`), '/library/metadata/1/thumb/1');
    assert.deepEqual(await store.studiosNeedingLogos(), [], 'every studio was looked up');
    assert.deepEqual([...tmdbAsked].sort(), ['20th Century Fox', 'Summit', 'Warner Bros.']);
    const people = await store.top('Person', 10);
    assert.equal(people.find((x) => x.name === 'Keanu Reeves')?.props.hasImage, true);
    assert.equal(people.find((x) => x.name === 'Carrie-Anne Moss')?.props.hasImage, false);
    const studios = await store.top('Studio', 10);
    assert.equal(studios.find((x) => x.name === 'Warner Bros.')?.props.hasImage, true);
    assert.equal((await store.top('Genre', 3))[0].props.hasImage, false);
    const found = await store.search('keanu');
    assert.equal(found[0].props.hasImage, true);
    for (const n of found) assert.ok(!('thumb' in n.props), 'picture locations stay on the server');
  });

  await step('re-import is idempotent', async () => {
    const before = await store.stats();
    const p = newProgress();
    await runImport({ plex, store, libraries: LIB, progress: p });
    assert.equal(p.state, 'done', p.message);
    assert.deepEqual(await store.stats(), before);
  });

  await step('franchises from TMDB: only for movies Plex has no collection for, kept across imports', async () => {
    assert.deepEqual([...tmdbMovies].sort(), ['1637', '245891', '49047']);
    const rows = await q(`MATCH (:Movie {id: '${SERVER_ID}:3'})-[:PART_OF]->(c) RETURN collect(c.name) AS c`);
    assert.deepEqual(rows.records[0].get('c'), ['John Wick Collection'], 'still there after the re-import above');
    assert.deepEqual(await store.imageSource('Collection', 'John Wick Collection'), { web: 'https://image.tmdb.org/t/p/w185/jw.jpg' });
    assert.deepEqual(await store.imageSource('Collection', 'The Matrix Collection'), { plex: '/library/collections/77/composite/1700000000' });
    assert.deepEqual(await store.moviesNeedingFranchise(), [], 'every movie was looked up once');
    const cols = await store.top('Collection', 10);
    assert.equal(cols.find((c) => c.name === 'John Wick Collection')?.props.hasImage, true);
    const center = (await store.expand('Movie', `${SERVER_ID}:3`)).center;
    assert.ok(!('franchiseChecked' in center.props));

    // When Plex puts the movie in a collection, that one replaces the TMDB franchise.
    const edited = structuredClone(MOVIES[2]);
    edited.Collection = [{ tag: 'Wick Saga' }];
    await store.upsertMovies([normalizeMovie(edited, { serverId: SERVER_ID, libraryKey: '1' })], 'manual-run');
    const after = await q(`MATCH (:Movie {id: '${SERVER_ID}:3'})-[:PART_OF]->(c) RETURN collect(c.name) AS c`);
    assert.deepEqual(after.records[0].get('c'), ['Wick Saga']);
    await store.upsertMovies([normalizeMovie(MOVIES[2], { serverId: SERVER_ID, libraryKey: '1' })], 'manual-run');
    const back = await q(`MATCH (:Movie {id: '${SERVER_ID}:3'})-[:PART_OF]->(c) RETURN collect(c.name) AS c`);
    assert.deepEqual(back.records[0].get('c'), ['John Wick Collection'], 'and comes back if Plex drops it again');
  });

  await step('a tag removed in Plex disappears on re-import', async () => {
    const edited = structuredClone(MOVIES[2]); // John Wick
    edited.Genre = [{ tag: 'Action' }]; // drop Thriller
    await store.upsertMovies([normalizeMovie(edited, { serverId: SERVER_ID, libraryKey: '1' })], 'manual-run');
    const rows = await q(`MATCH (:Movie {id: '${SERVER_ID}:3'})-[:IN_GENRE]->(g) RETURN collect(g.name) AS g`);
    assert.deepEqual(rows.records[0].get('g'), ['Action']);
  });

  await step('refuses to import once foreign data is present', async () => {
    await q('CREATE (:SomethingElse {note: "not ours"})');
    try {
      assert.equal(await store.isDedicated(), false);
      const p = newProgress();
      await runImport({ plex, store, libraries: LIB, progress: p });
      assert.equal(p.state, 'error');
      assert.match(p.message, /did not create/);
    } finally {
      await q('MATCH (n:SomethingElse) DELETE n');
    }
    // Look-alikes count as foreign too: our label without pg = true, or pg = true on a label we never use.
    for (const create of ['CREATE (:Movie {id: "theirs", pg: false})', 'CREATE (:Movie {id: "theirs2", pg: "PG"})', 'CREATE (:Rating {pg: true})']) {
      await q(create);
      try {
        assert.equal(await store.isDedicated(), false, create);
      } finally {
        await q('MATCH (n) WHERE n.id IN ["theirs", "theirs2"] OR n:Rating DETACH DELETE n');
      }
    }
    assert.equal(await store.isDedicated(), true);
  });

  await step('unticking a library removes its movies; orphans are cleaned', async () => {
    await store.retainOnly({ serverId: SERVER_ID, libraryKeys: ['some-other-library'] });
    await store.cleanOrphans();
    const s = await store.stats();
    assert.equal(s.nodes.Movie ?? 0, 0);
    assert.equal(s.nodes.Person ?? 0, 0);
    assert.equal(s.nodes.Genre ?? 0, 0);
  });
} finally {
  await q('MATCH (n) WHERE n.pg = true DETACH DELETE n').catch(() => {});
  await raw.close();
  await store.close();
  await mock.close();
}

console.log(failed ? '\nSMOKE TEST FAILED' : '\nAll queries behaved as expected. The database has been left empty.');
process.exit(failed ? 1 : 0);
