// SPDX-License-Identifier: GPL-3.0-or-later
// Turns a Plex movie metadata object into the flat record the graph store writes.
import { cleanImageUrl } from './images.js';

export const DEFAULT_MAX_CAST = 30;

const cleanName = (t) => (typeof t?.tag === 'string' ? t.tag.trim() : '');

/**
 * People are identified by Plex's global person id (`tagKey`, set by the modern Plex Movie agent)
 * so two different actors who share a name stay separate. Items matched by an older agent have no
 * tagKey; those people fall back to being identified by name.
 */
export function personKey(t) {
  const name = cleanName(t);
  if (!name) return null;
  const tagKey = typeof t.tagKey === 'string' ? t.tagKey.trim() : '';
  return tagKey ? `plex:${tagKey}` : `name:${name}`;
}

const names = (list) => {
  const seen = new Set();
  const out = [];
  for (const t of list ?? []) {
    const name = cleanName(t);
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
};

const people = (list) => {
  const seen = new Set();
  const out = [];
  for (const t of list ?? []) {
    const key = personKey(t);
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push({ key, name: cleanName(t), thumb: cleanImageUrl(t.thumb) });
    }
  }
  return out;
};

function parseGuids(guids) {
  const ids = {};
  for (const g of guids ?? []) {
    const m = /^(imdb|tmdb|tvdb):\/\/(.+)$/.exec(g?.id ?? '');
    if (m) ids[`${m[1]}Id`] = m[2];
  }
  return ids;
}

export function normalizeMovie(meta, { serverId, libraryKey, maxCast = DEFAULT_MAX_CAST }) {
  if (!meta?.ratingKey) throw new Error('Plex item is missing ratingKey');

  const actors = [];
  const seenActors = new Set();
  for (const r of meta.Role ?? []) {
    const key = personKey(r);
    if (!key || seenActors.has(key)) continue;
    seenActors.add(key);
    actors.push({ key, name: cleanName(r), role: (r.role ?? '').trim(), order: actors.length, thumb: cleanImageUrl(r.thumb) });
    if (actors.length >= maxCast) break;
  }

  const props = {
    ratingKey: String(meta.ratingKey),
    serverId,
    libraryKey: String(libraryKey),
    title: meta.title ?? '(untitled)',
    year: meta.year ?? null,
    summary: meta.summary ?? '',
    tagline: meta.tagline ?? '',
    contentRating: meta.contentRating ?? '',
    rating: meta.rating ?? null,
    audienceRating: meta.audienceRating ?? null,
    duration: meta.duration ?? null,
    originallyAvailableAt: meta.originallyAvailableAt ?? '',
    addedAt: meta.addedAt ?? null,
    thumb: meta.thumb ?? '',
    ...parseGuids(meta.Guid),
  };

  return {
    id: `${serverId}:${meta.ratingKey}`,
    props,
    genres: names(meta.Genre),
    countries: names(meta.Country),
    collections: names(meta.Collection),
    directors: people(meta.Director),
    writers: people(meta.Writer),
    producers: people(meta.Producer),
    studios: meta.studio ? [String(meta.studio).trim()].filter(Boolean) : [],
    actors,
  };
}
