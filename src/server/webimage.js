// SPDX-License-Identifier: GPL-3.0-or-later
// Fetches cast photos and studio logos from the allowed image hosts, with a small memory cache.
import { cleanImageUrl } from '../importer/images.js';

const MAX_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 3;

export class WebImageError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'WebImageError';
    this.status = status;
  }
}

export class WebImages {
  constructor({ fetchImpl = fetch, timeoutMs = 8000, cacheBytes = 40 * 1024 * 1024 } = {}) {
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.cacheBytes = cacheBytes;
    this.cache = new Map(); // url -> { type, buf }
    this.size = 0;
    this.pausedUntil = 0;
  }

  /** @returns {Promise<{type:string, buf:Buffer}>} */
  async get(rawUrl) {
    let url = cleanImageUrl(rawUrl);
    if (!url) throw new WebImageError('Refusing to fetch an image from an unexpected address', 400);
    const hit = this.cache.get(url);
    if (hit) {
      this.cache.delete(url); // most recently used goes last
      this.cache.set(url, hit);
      return hit;
    }
    if (Date.now() < this.pausedUntil) throw new WebImageError('Image hosts are not answering; paused for a moment', 503);

    const key = url;
    let res;
    for (let hop = 0; ; hop++) {
      try {
        res = await this.fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (err) {
        this.pausedUntil = Date.now() + 30000;
        throw new WebImageError(`Could not fetch image: ${err.cause?.code || err.message}`);
      }
      if (res.status >= 300 && res.status < 400) {
        // Follow a redirect only to another allowed image host.
        let next = null;
        try {
          next = cleanImageUrl(new URL(res.headers.get('location') ?? '', url).href);
        } catch {
          /* malformed Location */
        }
        res.body?.cancel().catch(() => {}); // not awaited: nothing to wait for
        if (!next || hop >= MAX_REDIRECTS) throw new WebImageError('Image host redirected somewhere unexpected');
        url = next;
        continue;
      }
      break;
    }
    if (!res.ok) {
      res.body?.cancel().catch(() => {}); // not awaited: nothing to wait for
      throw new WebImageError(`Image host returned HTTP ${res.status}`, res.status === 404 ? 404 : 502);
    }
    const type = res.headers.get('content-type') ?? '';
    if (!/^image\/(png|jpeg|jpg|webp|gif)$/i.test(type.split(';')[0].trim())) {
      res.body?.cancel().catch(() => {}); // not awaited: nothing to wait for
      throw new WebImageError('Image host did not return an image');
    }
    const declared = Number(res.headers.get('content-length'));
    if (declared > MAX_BYTES) {
      res.body?.cancel().catch(() => {}); // not awaited: nothing to wait for
      throw new WebImageError('Image is too large');
    }
    const chunks = [];
    let total = 0;
    try {
      for await (const chunk of res.body) {
        total += chunk.length;
        if (total > MAX_BYTES) throw new WebImageError('Image is too large');
        chunks.push(chunk);
      }
    } catch (err) {
      if (err instanceof WebImageError) throw err;
      if (err?.name === 'TimeoutError') this.pausedUntil = Date.now() + 30000;
      throw new WebImageError(`Image download failed: ${err?.cause?.code || err?.message || err}`);
    }
    const entry = { type: type.split(';')[0].trim(), buf: Buffer.concat(chunks) };
    const prev = this.cache.get(key);
    if (prev) this.size -= prev.buf.length;
    this.cache.set(key, entry);
    this.size += entry.buf.length;
    while (this.size > this.cacheBytes && this.cache.size > 1) {
      const [oldKey, old] = this.cache.entries().next().value;
      this.cache.delete(oldKey);
      this.size -= old.buf.length;
    }
    return entry;
  }
}
