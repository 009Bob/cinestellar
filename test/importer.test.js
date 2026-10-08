import test from 'node:test';
import assert from 'node:assert/strict';
import { PlexClient, PlexError, normalizeBaseUrl } from '../src/importer/plex.js';
import { normalizeMovie, personKey } from '../src/importer/normalize.js';
import { runImport, newProgress } from '../src/importer/importer.js';
import { startMockPlex, GOOD_TOKEN, SERVER_ID, MOVIES } from './fixtures/mock-plex.js';

const LIB = [{ key: '1', title: 'Movies' }];

function recordingStore({ dedicated = true, upsertDelayMs = 0, onUpsert } = {}) {
  const calls = { upsert: [], stale: [], retain: [], orphans: 0, schema: 0, inFlight: 0, maxInFlight: 0 };
  return {
    calls,
    async assertDedicated() {
      if (!dedicated) throw Object.assign(new Error('foreign data in this database'), { status: 409 });
    },
    async ensureSchema() { calls.schema++; },
    async setCollectionPosters() { return 0; },
    async studiosNeedingLogos() { return []; },
    async setStudioLogos() {},
    async upsertMovies(movies, runId) {
      calls.inFlight++;
      calls.maxInFlight = Math.max(calls.maxInFlight, calls.inFlight);
      try {
        onUpsert?.(movies);
        if (upsertDelayMs) await new Promise((r) => setTimeout(r, upsertDelayMs));
        calls.upsert.push({ movies, runId });
      } finally {
        calls.inFlight--;
      }
    },
    async deleteStale(args) { calls.stale.push(args); },
    async retainOnly(args) { calls.retain.push(args); },
    async cleanOrphans() { calls.orphans++; },
  };
}

async function withPlex(opts, fn) {
  const mock = await startMockPlex(opts);
  try {
    return await fn(new PlexClient({ url: mock.url, token: GOOD_TOKEN }), mock);
  } finally {
    await mock.close();
  }
}

const written = (store) => store.calls.upsert.flatMap((c) => c.movies);

// ---- normalising -------------------------------------------------------------

test('normalizeBaseUrl rejects junk and non-http schemes', () => {
  assert.equal(normalizeBaseUrl(' http://10.0.0.5:32400/ '), 'http://10.0.0.5:32400');
  assert.throws(() => normalizeBaseUrl('not a url'), PlexError);
  assert.throws(() => normalizeBaseUrl('file:///etc/passwd'), PlexError);
  assert.throws(() => normalizeBaseUrl('ftp://host'), PlexError);
});

test('people are keyed by Plex person id, falling back to name', () => {
  assert.equal(personKey({ tag: 'Keanu Reeves', tagKey: 'abc' }), 'plex:abc');
  assert.equal(personKey({ tag: ' Lana Wachowski ' }), 'name:Lana Wachowski');
  assert.equal(personKey({ tag: '' }), null);

  const matrix = normalizeMovie(MOVIES[0], { serverId: 'S', libraryKey: '1' });
  assert.deepEqual(matrix.actors[0], {
    key: 'plex:keanu',
    name: 'Keanu Reeves',
    role: 'Neo',
    order: 0,
    thumb: 'https://metadata-static.plex.tv/people/keanu.jpg',
  });
  assert.deepEqual(matrix.directors.map((d) => d.key), ['name:Lana Wachowski', 'name:Lilly Wachowski']);

  const lake = normalizeMovie(MOVIES[4], { serverId: 'S', libraryKey: '1' });
  const gravity = normalizeMovie(MOVIES[5], { serverId: 'S', libraryKey: '1' });
  const cw = (rec) => rec.actors.find((a) => a.name === 'Chris Wood').key;
  assert.notEqual(cw(lake), cw(gravity), 'two people who share a name must not merge');
});

test('normalizeMovie flattens tags, dedupes, parses guids and caps the cast', () => {
  const rec = normalizeMovie(MOVIES[0], { serverId: 'S', libraryKey: '1' });
  assert.equal(rec.id, 'S:1');
  assert.deepEqual(rec.genres, ['Action', 'Sci-Fi']);
  assert.deepEqual(rec.studios, ['Warner Bros.']);
  assert.equal(rec.props.imdbId, 'tt0133093');
  assert.equal(rec.props.tmdbId, '603');

  const dupes = normalizeMovie(
    { ratingKey: 9, title: 'X', Genre: [{ tag: ' A ' }, { tag: 'A' }, { tag: '' }, {}], Role: [{ tag: 'P' }, { tag: 'P' }] },
    { serverId: 'S', libraryKey: 1 },
  );
  assert.deepEqual(dupes.genres, ['A']);
  assert.equal(dupes.actors.length, 1);

  const big = { ratingKey: 1, Role: Array.from({ length: 80 }, (_, i) => ({ tag: `Actor ${i}` })) };
  assert.equal(normalizeMovie(big, { serverId: 'S', libraryKey: 1 }).actors.length, 30);
  assert.equal(normalizeMovie(big, { serverId: 'S', libraryKey: 1, maxCast: 50 }).actors.length, 50);
  assert.throws(() => normalizeMovie({}, { serverId: 'S', libraryKey: 1 }));
});

// ---- Plex client --------------------------------------------------------------------

test('PlexClient talks to Plex, pages, batches, and maps errors', () =>
  withPlex({}, async (plex, mock) => {
    assert.deepEqual(await plex.identity(), { serverId: SERVER_ID, name: 'Mock Plex', version: '1.0' });
    assert.deepEqual((await plex.libraries()).map((l) => l.type), ['movie', 'show']);
    assert.equal((await plex.listMovies('1', 4)).length, MOVIES.length); // forces pagination
    assert.equal((await plex.detail('3')).title, 'John Wick');
    const many = await plex.detailMany(['1', '3', '6']);
    assert.deepEqual([...many.keys()].sort(), ['1', '3', '6']);
    assert.ok(mock.hits.includes('BATCH'));

    const bad = new PlexClient({ url: mock.url, token: 'nope' });
    await assert.rejects(bad.identity(), (e) => e.status === 401);
  }));

test('PlexClient reports an unreachable server clearly', async () => {
  const plex = new PlexClient({ url: 'http://127.0.0.1:1', token: 'x', timeoutMs: 2000 });
  await assert.rejects(plex.identity(), /Could not reach Plex/);
});

test('PlexClient refuses redirects, non-Plex servers, and path tricks', async () => {
  const redirecting = await startMockPlex({ rootMode: 'redirect' });
  const notPlex = await startMockPlex({ rootMode: 'not-plex' });
  const ok = await startMockPlex();
  try {
    await assert.rejects(new PlexClient({ url: redirecting.url, token: GOOD_TOKEN }).identity(), /Could not reach Plex/);
    await assert.rejects(new PlexClient({ url: notPlex.url, token: GOOD_TOKEN }).identity(), /does not look like a Plex/);
    const plex = new PlexClient({ url: ok.url, token: GOOD_TOKEN });
    await assert.rejects(plex.image('/library/../photo/:/transcode?url=x'), /unexpected image path/);
    await assert.rejects(plex.image('/library/%2e%2e/photo/:/transcode'), /unexpected image path/);
    await assert.rejects(plex.thumbnail('/library/metadata/1/thumb/1?x=/../', 10, 10), /unexpected image path/);
  } finally {
    await Promise.all([redirecting.close(), notPlex.close(), ok.close()]);
  }
});

// ---- import runs ---------------------------------------------------------------------

test('a clean import writes every title, then prunes and keeps only the chosen libraries', () =>
  withPlex({}, async (plex, mock) => {
    const store = recordingStore();
    const progress = newProgress();
    await runImport({ plex, store, libraries: LIB, progress });

    assert.equal(progress.state, 'done', progress.message);
    assert.equal(progress.done, MOVIES.length);
    assert.equal(progress.failed, 0);
    assert.equal(written(store).length, MOVIES.length);
    assert.ok(mock.hits.includes('BATCH'), 'metadata is fetched in batches');
    assert.deepEqual(store.calls.stale, [{ serverId: SERVER_ID, libraryKey: '1', runId: progress.runId }]);
    assert.deepEqual(store.calls.retain, [{ serverId: SERVER_ID, libraryKeys: ['1'] }]);
    assert.equal(store.calls.orphans, 1);
    assert.equal(store.calls.maxInFlight, 1, 'database writes never overlap');
    assert.equal(progress.people.withPlexId, 7); // keanu, moss, fishburne, bullock, 2x Chris Wood, Joel Silver
    assert.equal(progress.people.nameOnly, 7);
    assert.match(progress.message, /7 people had no Plex ID/);
  }));

test('progress total is known before any title is written', () =>
  withPlex({}, async (plex) => {
    const progress = newProgress();
    const totals = [];
    const store = recordingStore({ onUpsert: () => totals.push(progress.total) });
    await runImport({ plex, store, libraries: [...LIB, { key: '2', title: 'Empty' }], progress });
    assert.ok(totals.length > 0 && totals.every((t) => t === MOVIES.length));
  }));

test('batch requests that fail or come back short fall back to single requests', async () => {
  for (const batchMode of ['error', 'partial']) {
    await withPlex({ batchMode }, async (plex) => {
      const store = recordingStore();
      const progress = newProgress();
      await runImport({ plex, store, libraries: LIB, progress });
      assert.equal(progress.state, 'done', `${batchMode}: ${progress.message}`);
      assert.equal(written(store).length, MOVIES.length, batchMode);
    });
  }
});

test('if combined requests leave detail out, the importer notices and fetches one at a time', () =>
  withPlex({ batchMode: 'thin' }, async (plex) => {
    const store = recordingStore();
    const progress = newProgress();
    await runImport({ plex, store, libraries: LIB, progress });
    assert.equal(progress.state, 'done', progress.message);
    assert.equal(progress.batching, false);
    assert.match(progress.message, /one at a time/);
    const matrix = written(store).find((m) => m.props.title === 'The Matrix');
    assert.equal(matrix.actors.length, 3, 'the full cast was still imported');
  }));

test('combined requests are used once verified', () =>
  withPlex({}, async (plex) => {
    const progress = newProgress();
    await runImport({ plex, store: recordingStore(), libraries: LIB, progress });
    assert.equal(progress.batching, true);
  }));

test('cancel interrupts slow Plex requests instead of waiting them out', () =>
  withPlex({ detailDelayMs: 5000 }, async (plex) => {
    const store = recordingStore();
    const progress = newProgress();
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 200);
    const t0 = Date.now();
    await runImport({ plex, store, libraries: LIB, progress, signal: ctl.signal });
    assert.equal(progress.state, 'cancelled');
    assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
    assert.equal(progress.failed, 0, 'aborted requests are not counted as failures');
  }));

test('one failing title is skipped, the rest are imported, and NOTHING is pruned', () =>
  withPlex({ failDetailFor: ['3'] }, async (plex) => {
    const store = recordingStore();
    const progress = newProgress();
    await runImport({ plex, store, libraries: LIB, progress });
    assert.equal(progress.state, 'done');
    assert.equal(progress.failed, 1);
    assert.match(progress.errors[0], /John Wick/);
    assert.equal(written(store).length, MOVIES.length - 1);
    assert.equal(store.calls.stale.length, 0);
    assert.equal(store.calls.retain.length, 0);
    assert.equal(store.calls.orphans, 0);
    assert.match(progress.message, /nothing was removed/);
  }));

test('a failed database write is counted per title and blocks pruning', () =>
  withPlex({}, async (plex) => {
    const store = recordingStore();
    store.upsertMovies = async () => { throw new Error('neo4j exploded'); };
    const progress = newProgress();
    await runImport({ plex, store, libraries: LIB, progress });
    assert.equal(progress.failed, MOVIES.length);
    assert.match(progress.errors[0], /database write failed for 6 title/);
    assert.equal(store.calls.retain.length, 0);
  }));

test('a listing Plex does not size is never trusted', () =>
  withPlex({ omitTotalSize: true }, async (plex) => {
    const store = recordingStore();
    const progress = newProgress();
    await runImport({ plex, store, libraries: LIB, progress });
    assert.equal(progress.state, 'error');
    assert.match(progress.message, /cannot be trusted/);
    assert.equal(store.calls.upsert.length + store.calls.stale.length + store.calls.retain.length, 0);
  }));

test('an empty library is kept as-is rather than wiped', () =>
  withPlex({}, async (plex) => {
    const store = recordingStore();
    const progress = newProgress();
    await runImport({ plex, store, libraries: [{ key: '2', title: 'Pretend empty' }], progress });
    assert.equal(progress.state, 'done');
    assert.equal(store.calls.stale.length, 0, 'zero titles listed must not delete that library');
    assert.deepEqual(store.calls.retain[0].libraryKeys, ['2'], 'its movies stay because it is still chosen');
  }));

test('refuses to import into a database that holds someone else\'s data', () =>
  withPlex({}, async (plex) => {
    const store = recordingStore({ dedicated: false });
    const progress = newProgress();
    await runImport({ plex, store, libraries: LIB, progress });
    assert.equal(progress.state, 'error');
    assert.match(progress.message, /foreign data/);
    assert.equal(store.calls.upsert.length + store.calls.schema, 0);
  }));

test('auth failure ends in an error state', async () => {
  const mock = await startMockPlex();
  try {
    const progress = newProgress();
    const plex = new PlexClient({ url: mock.url, token: 'wrong' });
    await runImport({ plex, store: recordingStore(), libraries: LIB, progress });
    assert.equal(progress.state, 'error');
    assert.match(progress.message, /401/);
  } finally {
    await mock.close();
  }
});

test('cancelling mid-run waits for the in-flight write and removes nothing', () =>
  withPlex({ extraMovies: 250 }, async (plex) => {
    const ctl = new AbortController();
    const store = recordingStore({ upsertDelayMs: 200, onUpsert: () => ctl.abort() });
    const progress = newProgress();
    await runImport({ plex, store, libraries: LIB, progress, signal: ctl.signal });
    assert.equal(progress.state, 'cancelled');
    assert.equal(store.calls.inFlight, 0, 'no write may still be running when the import reports back');
    assert.equal(store.calls.upsert.length, 1, 'the write that was running finished');
    assert.equal(store.calls.stale.length + store.calls.retain.length + store.calls.orphans, 0);
  }));

test('cancelling before anything is listed leaves everything alone', () =>
  withPlex({}, async (plex) => {
    const store = recordingStore();
    const progress = newProgress();
    const ctl = new AbortController();
    ctl.abort();
    await runImport({ plex, store, libraries: LIB, progress, signal: ctl.signal });
    assert.equal(progress.state, 'cancelled');
    assert.equal(store.calls.upsert.length + store.calls.stale.length + store.calls.retain.length, 0);
  }));
