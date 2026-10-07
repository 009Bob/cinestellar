// SPDX-License-Identifier: GPL-3.0-or-later
// Orchestrates an import: list every chosen library -> fetch full metadata in small batches ->
// write to Neo4j one batch at a time -> prune only after a complete, error-free run.
import { randomUUID } from 'node:crypto';
import { normalizeMovie, DEFAULT_MAX_CAST } from './normalize.js';

const FETCH_CONCURRENCY = 4; // parallel requests to Plex
const WRITE_BATCH = 100; // movies per Neo4j transaction
const MAX_RECORDED_ERRORS = 20;
// Tag lists compared when checking that a combined request returns the same detail as a single one.
const DETAIL_FIELDS = ['Role', 'Director', 'Writer', 'Producer', 'Genre', 'Country', 'Collection', 'Guid'];

export function newProgress() {
  return {
    state: 'idle', // idle | running | done | error | cancelled
    runId: null,
    startedAt: null,
    finishedAt: null,
    library: null,
    librariesDone: 0,
    librariesTotal: 0,
    done: 0,
    total: 0,
    failed: 0,
    errors: [],
    people: { withPlexId: 0, nameOnly: 0 },
    batching: null, // true once combined Plex requests are verified, false if they were turned off
    pictures: { collections: 0, franchises: 0, franchisesChecked: 0, franchisesToCheck: 0, logos: 0, logosChecked: 0, logosToCheck: 0, note: '' },
    message: '',
  };
}

async function mapPool(items, limit, fn, signal) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!signal?.aborted) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

/**
 * @param {object} o
 * @param {import('./plex.js').PlexClient} o.plex
 * @param {object} o.store      graph store (see GraphStore)
 * @param {{key:string,title:string}[]} o.libraries  the complete set of libraries the graph should hold
 * @param {object} o.progress   mutable progress object (see newProgress)
 * @param {AbortSignal} [o.signal]
 * @param {number} [o.maxCast]
 * @param {number} [o.fetchBatch]  ratingKeys per Plex request (1 disables batching)
 * @param {import('./tmdb.js').TmdbClient|null} [o.tmdb]  optional, for studio logos
 */
export async function runImport({ plex, store, libraries, progress, signal, maxCast = DEFAULT_MAX_CAST, fetchBatch = 10, tmdb = null }) {
  const runId = randomUUID();
  Object.assign(progress, newProgress(), {
    state: 'running',
    runId,
    startedAt: Date.now(),
    librariesTotal: libraries.length,
    message: 'Connecting to Plex',
  });

  const recordError = (msg, count = 1) => {
    if (signal?.aborted) return; // requests torn down by a cancel are not real failures
    progress.failed += count;
    if (progress.errors.length < MAX_RECORDED_ERRORS) progress.errors.push(msg);
  };

  const peopleSeen = new Set();
  const countPeople = (rec) => {
    for (const p of [...rec.directors, ...rec.writers, ...rec.producers, ...rec.actors]) {
      if (peopleSeen.has(p.key)) continue;
      peopleSeen.add(p.key);
      if (p.key.startsWith('plex:')) progress.people.withPlexId += 1;
      else progress.people.nameOnly += 1;
    }
  };

  // Writes are chained so only one transaction runs at a time and so we can always wait for
  // the last one - including after a cancel, before anyone can start another run.
  let writes = Promise.resolve();
  let batch = [];
  const flush = () => {
    if (batch.length === 0) return;
    const toWrite = batch;
    batch = [];
    writes = writes
      .then(() => store.upsertMovies(toWrite, runId))
      .catch((err) => recordError(`database write failed for ${toWrite.length} title(s): ${err.message}`, toWrite.length));
  };

  try {
    const { serverId } = await plex.identity();
    await store.assertDedicated();
    await store.ensureSchema();

    // 1. List everything first so the progress bar has a fixed total.
    const listed = [];
    for (const lib of libraries) {
      if (signal?.aborted) break;
      progress.message = `Listing "${lib.title}"`;
      const items = await plex.listMovies(lib.key, undefined, { signal });
      listed.push({ lib, items });
      progress.total += items.length;
    }

    // 2. Fetch full metadata and write it.
    //
    // Plex can return several titles in one request. Before trusting that, the first combined
    // response is compared with a normal single-title request; if Plex left anything out,
    // combining is switched off for the rest of the run.
    let batching = fetchBatch > 1;
    let batchCheck = null;
    const verifyBatch = async (found, group) => {
      const sample = group.find((i) => found.has(String(i.ratingKey)));
      if (!sample) return true;
      try {
        const single = await plex.detail(sample.ratingKey, { signal });
        const combined = found.get(String(sample.ratingKey));
        return Boolean(single) && DETAIL_FIELDS.every((f) => (single[f]?.length ?? 0) === (combined[f]?.length ?? 0));
      } catch {
        return false; // could not compare, so take the safe, slower route
      }
    };

    for (const { lib, items } of listed) {
      if (signal?.aborted) break;
      progress.library = lib.title;
      progress.message = `Importing "${lib.title}"`;
      const keep = (meta) => {
        if (signal?.aborted) return;
        const rec = normalizeMovie(meta, { serverId, libraryKey: lib.key, maxCast });
        countPeople(rec);
        batch.push(rec);
        if (batch.length >= WRITE_BATCH) flush();
      };
      const fetchOne = async (item) => {
        try {
          const meta = await plex.detail(item.ratingKey, { signal });
          if (!meta) throw new Error('no metadata returned');
          keep(meta);
        } catch (err) {
          recordError(`${item.title ?? item.ratingKey}: ${err.message}`);
        }
      };

      await mapPool(
        chunk(items, Math.max(1, fetchBatch)),
        FETCH_CONCURRENCY,
        async (group) => {
          let found = new Map();
          if (batching && group.length > 1) {
            try {
              found = await plex.detailMany(group.map((i) => String(i.ratingKey)), { signal });
            } catch {
              found = new Map(); // fall back to one request per item below
            }
            if (found.size > 0) {
              batchCheck ??= verifyBatch(found, group);
              if (await batchCheck) {
                progress.batching = true;
              } else {
                batching = false;
                progress.batching = false;
                found = new Map();
              }
            }
          }
          for (const item of group) {
            if (signal?.aborted) break;
            const meta = found.get(String(item.ratingKey));
            if (meta) {
              try {
                keep(meta);
              } catch (err) {
                recordError(`${item.title ?? item.ratingKey}: ${err.message}`);
              }
            } else {
              await fetchOne(item);
            }
            progress.done += 1;
          }
        },
        signal,
      );
      if (!signal?.aborted) progress.librariesDone += 1;
    }

    if (!signal?.aborted) flush();
    await writes; // never leave a write running behind us, cancelled or not

    if (signal?.aborted) {
      progress.state = 'cancelled';
      progress.message = 'Import cancelled; nothing was removed';
      return progress;
    }

    // 3. Prune only after a complete pass with zero failures, so a bad run never deletes data.
    if (progress.failed === 0) {
      for (const { lib, items } of listed) {
        if (items.length > 0) await store.deleteStale({ serverId, libraryKey: lib.key, runId });
      }
      // The graph mirrors exactly the libraries chosen this time, on this server.
      await store.retainOnly({ serverId, libraryKeys: libraries.map((l) => l.key) });
      await store.cleanOrphans();
    }

    // 4. Pictures. These are decoration: a failure here is reported but never fails the import.
    await importPictures({ plex, store, tmdb, listed, progress, signal });
    if (signal?.aborted) {
      progress.state = 'cancelled';
      progress.message = 'Import cancelled while fetching pictures; the movies themselves were imported';
      return progress;
    }

    progress.state = 'done';
    const parts = [
      progress.failed
        ? `Finished with ${progress.failed} title(s) skipped; nothing was removed from the graph`
        : 'Import complete',
    ];
    if (progress.batching === false) {
      parts.push('Plex left details out of combined requests, so titles were fetched one at a time');
    }
    if (progress.pictures.note) parts.push(progress.pictures.note);
    if (progress.people.nameOnly > 0) {
      parts.push(`${progress.people.nameOnly} people had no Plex ID and were matched by name`);
    }
    progress.message = parts.join('. ');
  } catch (err) {
    await writes.catch(() => {});
    progress.state = 'error';
    progress.message = err.message;
  } finally {
    progress.finishedAt = Date.now();
  }
  return progress;
}

const LOGO_CONCURRENCY = 3;
const LOGO_WRITE_BATCH = 25;

async function importPictures({ plex, store, tmdb, listed, progress, signal }) {
  const pics = progress.pictures;
  const notes = [];

  // Collection posters come from Plex itself.
  progress.message = 'Fetching collection posters';
  try {
    const posters = new Map();
    for (const { lib } of listed) {
      if (signal?.aborted) return;
      for (const c of await plex.collections(lib.key, { signal })) {
        if (c.thumb && !posters.has(c.title)) posters.set(c.title, c.thumb);
      }
    }
    pics.collections = await store.setCollectionPosters([...posters].map(([name, thumb]) => ({ name, thumb })));
  } catch (err) {
    if (signal?.aborted) return;
    notes.push(`Collection posters were skipped (${err.message})`);
  }

  // Franchises and studio logos come from TMDB, only when a key is configured. Each movie and
  // studio is looked up once (movies without a franchise are asked again after a few months).
  if (tmdb) {
    // A bad key or an outage affects every lookup, so the first error stops the rest.
    const lookups = async ({ items, ask, save, label, onHit }) => {
      let pending = [];
      let stop = null;
      let done = 0;
      const flush = async () => {
        const list = pending;
        pending = [];
        await save(list);
      };
      await mapPool(
        items,
        LOGO_CONCURRENCY,
        async (item) => {
          if (stop) return;
          progress.message = `${label} (${done + 1} of ${items.length})`;
          let result;
          try {
            result = await ask(item);
          } catch (err) {
            if (!signal?.aborted) stop = err;
            return;
          }
          done += 1;
          pending.push(result);
          onHit(result);
          if (pending.length >= LOGO_WRITE_BATCH) await flush();
        },
        signal,
      );
      await flush();
      return { done, stop };
    };

    try {
      const movies = await store.moviesNeedingFranchise();
      pics.franchisesToCheck = movies.length;
      const { done, stop } = await lookups({
        items: movies,
        label: 'Looking up franchises on TMDB',
        ask: async (m) => ({ id: m.id, ...((await tmdb.movieFranchise(m.tmdbId, { signal })) ?? { name: null, poster: null }) }),
        save: (list) => store.setFranchises(list),
        onHit: (r) => {
          if (r.name) pics.franchises += 1;
        },
      });
      pics.franchisesChecked = done;
      if (stop) notes.push(`Franchise lookups stopped early (${stop.message}); the rest will be tried on the next import`);
    } catch (err) {
      if (signal?.aborted) return;
      notes.push(`Franchise lookups were skipped (${err.message})`);
    }
    if (signal?.aborted) return;

    try {
      const names = await store.studiosNeedingLogos();
      pics.logosToCheck = names.length;
      const { done, stop } = await lookups({
        items: names,
        label: 'Finding studio logos',
        ask: async (name) => ({ name, logo: await tmdb.studioLogo(name, { signal }) }),
        save: (list) => store.setStudioLogos(list),
        onHit: (r) => {
          if (r.logo) pics.logos += 1;
        },
      });
      pics.logosChecked = done;
      if (stop) notes.push(`Studio logos stopped early (${stop.message}); the rest will be tried on the next import`);
    } catch (err) {
      if (signal?.aborted) return;
      notes.push(`Studio logos were skipped (${err.message})`);
    }
  }
  pics.note = notes.join('. ');
}
