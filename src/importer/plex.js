// SPDX-License-Identifier: GPL-3.0-or-later
// Minimal Plex Media Server API client (JSON). Read-only; the token never leaves the server process.

import { VERSION } from '../version.js';

const CLIENT_HEADERS = {
  Accept: 'application/json',
  'X-Plex-Product': 'Cinestellar',
  'X-Plex-Client-Identifier': 'cinestellar',
  'X-Plex-Version': VERSION,
};

export class PlexError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'PlexError';
    this.status = status;
  }
}

export function normalizeBaseUrl(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    throw new PlexError('Plex URL is not a valid URL (example: http://192.168.1.10:32400)');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new PlexError('Plex URL must start with http:// or https://');
  }
  return u.origin;
}

// Only the image paths Plex stores for library items and collections, e.g.
// /library/metadata/123/thumb/1699999999 or /library/collections/45/composite/1699999999.
// A strict pattern (no %, no dots) means a stored value can never steer us to another endpoint.
const LIBRARY_IMAGE =
  /^\/library\/(?:metadata\/\d+\/(?:thumb|art|poster|banner|composite)|collections\/\d+\/(?:thumb|art|composite))(\/\d+)?$/;

/** The path part of a Plex image reference if it is one we would fetch, else null. */
export function cleanLibraryPath(raw) {
  if (typeof raw !== 'string') return null;
  const p = raw.split('?')[0];
  return LIBRARY_IMAGE.test(p) ? p : null;
}

function checkLibraryPath(path) {
  const p = String(path);
  if (!LIBRARY_IMAGE.test(p)) throw new PlexError('Refusing to fetch an unexpected image path', 400);
  return p;
}

export class PlexClient {
  constructor({ url, token, timeoutMs = 30000, fetchImpl = fetch }) {
    this.baseUrl = normalizeBaseUrl(url);
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async request(path, params = {}, { raw = false, signal, anonymous = false } = {}) {
    const u = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
    let res;
    try {
      res = await this.fetchImpl(u, {
        headers: anonymous ? CLIENT_HEADERS : { ...CLIENT_HEADERS, 'X-Plex-Token': this.token },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
        redirect: 'error', // never follow a redirect to somewhere else with our token attached
      });
    } catch (err) {
      throw new PlexError(`Could not reach Plex at ${this.baseUrl}: ${err.cause?.code || err.message}`);
    }
    if (res.status === 401) throw new PlexError('Plex rejected the token (401 Unauthorized)', 401);
    if (!res.ok) throw new PlexError(`Plex returned HTTP ${res.status} for ${u.pathname}`, res.status);
    return raw ? res : res.json();
  }

  async identity() {
    const body = await this.request('/');
    const c = body.MediaContainer ?? {};
    if (!c.machineIdentifier) throw new PlexError(`${this.baseUrl} does not look like a Plex Media Server`);
    return {
      serverId: c.machineIdentifier,
      name: c.friendlyName,
      version: c.version,
    };
  }

  /** The server's id without sending the token (Plex answers /identity to anyone). */
  async publicIdentity() {
    const body = await this.request('/identity', {}, { anonymous: true });
    const id = body?.MediaContainer?.machineIdentifier;
    if (!id) throw new PlexError(`${this.baseUrl} does not look like a Plex Media Server`);
    return id;
  }

  async libraries() {
    const body = await this.request('/library/sections');
    return (body.MediaContainer?.Directory ?? []).map((d) => ({
      key: String(d.key),
      title: d.title,
      type: d.type,
    }));
  }

  /**
   * Basic movie list for a library. Throws if Plex reports more items than we received, so a
   * truncated listing can never be mistaken for "the user deleted everything else".
   */
  async listMovies(libraryKey, pageSize = 200, { signal } = {}) {
    const items = [];
    let total = null;
    for (let start = 0; ; start += pageSize) {
      const body = await this.request(`/library/sections/${encodeURIComponent(libraryKey)}/all`, {
        type: 1,
        'X-Plex-Container-Start': start,
        'X-Plex-Container-Size': pageSize,
      }, { signal });
      const c = body.MediaContainer ?? {};
      const page = c.Metadata ?? [];
      if (Number.isFinite(c.totalSize)) total = c.totalSize;
      items.push(...page);
      if (page.length === 0 || (total != null && items.length >= total)) break;
      if (total == null && page.length < pageSize) break;
    }
    if (total == null) {
      throw new PlexError('Plex did not report the library size, so the listing cannot be trusted');
    }
    if (items.length < total) {
      throw new PlexError(`Plex listed ${items.length} of ${total} titles; try again`);
    }
    return items;
  }

  /** Full metadata for one item (cast, crew, genres, guids). */
  async detail(ratingKey, { signal } = {}) {
    const body = await this.request(`/library/metadata/${encodeURIComponent(ratingKey)}`, { includeGuids: 1 }, { signal });
    return body.MediaContainer?.Metadata?.[0] ?? null;
  }

  /**
   * Full metadata for several items in one request (Plex accepts comma-separated ratingKeys).
   * Returns a Map ratingKey -> metadata; callers fall back to detail() for anything missing.
   */
  async detailMany(ratingKeys, { signal } = {}) {
    const path = `/library/metadata/${ratingKeys.map((k) => encodeURIComponent(k)).join(',')}`;
    const body = await this.request(path, { includeGuids: 1 }, { signal });
    const out = new Map();
    for (const m of body.MediaContainer?.Metadata ?? []) {
      if (m?.ratingKey != null) out.set(String(m.ratingKey), m);
    }
    return out;
  }

  /** Collections in a library with their poster paths: [{ title, thumb|null }]. */
  async collections(libraryKey, { signal } = {}) {
    const body = await this.request(`/library/sections/${encodeURIComponent(libraryKey)}/collections`, {}, { signal });
    return (body.MediaContainer?.Metadata ?? [])
      .filter((c) => typeof c?.title === 'string' && c.title.trim())
      .map((c) => ({ title: c.title.trim(), thumb: cleanLibraryPath(c.thumb) }));
  }

  /** Streams an image path (e.g. /library/metadata/123/thumb/456) back as a fetch Response. */
  async image(path) {
    return this.request(checkLibraryPath(path), {}, { raw: true });
  }

  /** A small version of a library image, resized by Plex's own photo transcoder. */
  async thumbnail(path, width, height) {
    return this.request(
      '/photo/:/transcode',
      { width, height, minSize: 1, upscale: 1, url: checkLibraryPath(path) },
      { raw: true },
    );
  }
}
