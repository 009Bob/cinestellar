// SPDX-License-Identifier: GPL-3.0-or-later
// Optional extras from The Movie Database (TMDB), used only when a TMDB API key is configured:
// studio logos (Plex has no pictures for studios) and franchises for movies that Plex hasn't put
// in a collection. It sends studio names and TMDB movie ids, nothing else.
import { cleanImageUrl } from './images.js';

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
  });

export class TmdbError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'TmdbError';
    this.status = status;
  }
}

// Words studios often add or drop ("Warner Bros." vs "Warner Bros. Pictures").
const FILLER = /\b(pictures|picture|films|film|studios|studio|entertainment|productions|production|company|corporation|corp|inc|llc|ltd|limited|co)\b/g;
const squash = (s) => s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const exact = (s) => squash(s).replace(/ /g, '');
const loose = (s) => squash(s).replace(FILLER, ' ').replace(/ +/g, '');

/** The best logo among TMDB company results for a studio name, or null if none clearly matches. */
export function pickLogo(name, results) {
  const withLogo = (results ?? []).filter((r) => typeof r?.name === 'string' && typeof r.logo_path === 'string' && r.logo_path);
  const hit =
    withLogo.find((r) => exact(r.name) === exact(name)) ??
    (loose(name) ? withLogo.find((r) => loose(r.name) === loose(name)) : undefined);
  return hit ? cleanImageUrl(`https://image.tmdb.org/t/p/original${hit.logo_path}`) : null;
}

export class TmdbClient {
  /** @param {{key:string, fetchImpl?:typeof fetch, timeoutMs?:number, baseUrl?:string}} o */
  constructor({ key, fetchImpl = fetch, timeoutMs = 10000, baseUrl = 'https://api.themoviedb.org' }) {
    this.key = String(key).trim();
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.baseUrl = baseUrl;
  }

  async #get(path, params, signal) {
    const u = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    // A v4 "API Read Access Token" is a JWT and goes in a header; a v3 "API Key" is a parameter.
    const bearer = this.key.startsWith('eyJ');
    if (!bearer) u.searchParams.set('api_key', this.key);
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await this.fetchImpl(u, {
          headers: { Accept: 'application/json', ...(bearer ? { Authorization: `Bearer ${this.key}` } : {}) },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
          redirect: 'error',
        });
      } catch (err) {
        throw new TmdbError(`Could not reach TMDB: ${err.cause?.code || err.message}`);
      }
      if (res.status === 429 && attempt < 2) {
        res.body?.cancel().catch(() => {});
        const wait = Math.min(10, Number(res.headers.get('retry-after')) || 2);
        try {
          await sleep(wait * 1000, signal);
        } catch {
          throw new TmdbError('Cancelled');
        }
        continue;
      }
      if (res.status === 401) throw new TmdbError('TMDB rejected the API key (401)', 401);
      if (res.status === 404) {
        res.body?.cancel().catch(() => {});
        return null;
      }
      if (!res.ok) throw new TmdbError(`TMDB returned HTTP ${res.status}`, res.status);
      return res.json();
    }
  }

  /** Throws a TmdbError if TMDB does not accept the key. */
  async check() {
    const body = await this.#get('/3/configuration', {}, undefined);
    if (!body) throw new TmdbError('TMDB did not recognise that request; check the key');
  }

  /** Logo URL for a studio name, or null. */
  async studioLogo(name, { signal } = {}) {
    const body = await this.#get('/3/search/company', { query: name }, signal);
    return pickLogo(name, body?.results);
  }

  /**
   * The franchise ("collection" on TMDB) a movie belongs to: { name, poster } or null.
   * @param {string} tmdbId  TMDB movie id, as stored from Plex's tmdb:// guid
   */
  async movieFranchise(tmdbId, { signal } = {}) {
    if (!/^\d{1,10}$/.test(String(tmdbId))) return null;
    const body = await this.#get(`/3/movie/${tmdbId}`, {}, signal);
    const c = body?.belongs_to_collection;
    const name = typeof c?.name === 'string' ? c.name.trim() : '';
    if (!name) return null;
    return {
      name: name.slice(0, 200),
      poster: typeof c.poster_path === 'string' ? cleanImageUrl(`https://image.tmdb.org/t/p/original${c.poster_path}`) : null,
    };
  }
}
