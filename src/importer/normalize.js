// SPDX-License-Identifier: GPL-3.0-or-later
// Turns a Plex movie metadata object into the flat record the graph store writes.
import { cleanImageUrl } from './images.js';

export const DEFAULT_MAX_CAST = 30;

// Plex data is trusted to be well-formed, but one odd item (a map where a string should be, a
// 10,000-character name) must not fail the whole batch it is written with.
const MAX_NAME = 200;
const MAX_TEXT = 5000;
const str = (v, max = MAX_TEXT) => (typeof v === 'string' ? v.trim().slice(0, max) : typeof v === 'number' ? String(v) : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(+v) ? +v : null);
const int = (v) => {
  const n = num(v);
  return n == null ? null : Math.trunc(n);
};
const cleanName = (t) => str(t?.tag, MAX_NAME);
const list = (v) => (Array.isArray(v) ? v : []);

/**
 * People are identified by Plex's global person id (`tagKey`, set by the modern Plex Movie agent)
 * so two different actors who share a name stay separate. Items matched by an older agent have no
 * tagKey; those people fall back to being identified by name.
 */
export function personKey(t) {
  const name = cleanName(t);
  if (!name) return null;
  const tagKey = str(t.tagKey, 64);
  return tagKey ? `plex:${tagKey}` : `name:${name}`;
}

const names = (tags) => {
  const seen = new Set();
  const out = [];
  for (const t of list(tags)) {
    const name = cleanName(t);
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
};

const people = (tags) => {
  const seen = new Set();
  const out = [];
  for (const t of list(tags)) {
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
  for (const g of list(guids)) {
    const m = /^(imdb|tmdb|tvdb):\/\/([A-Za-z0-9._-]{1,40})$/.exec(typeof g?.id === 'string' ? g.id : '');
    if (m) ids[`${m[1]}Id`] = m[2];
  }
  return ids;
}

export function normalizeMovie(meta, { serverId, libraryKey, maxCast = DEFAULT_MAX_CAST }) {
  if (!meta?.ratingKey) throw new Error('Plex item is missing ratingKey');

  const actors = [];
  const seenActors = new Set();
  for (const r of list(meta.Role)) {
    const key = personKey(r);
    if (!key || seenActors.has(key)) continue;
    seenActors.add(key);
    actors.push({ key, name: cleanName(r), role: str(r.role, MAX_NAME), order: actors.length, thumb: cleanImageUrl(r.thumb) });
    if (actors.length >= maxCast) break;
  }

  const props = {
    ratingKey: String(meta.ratingKey),
    serverId,
    libraryKey: String(libraryKey),
    title: str(meta.title, 500) || '(untitled)',
    year: int(meta.year),
    summary: str(meta.summary),
    tagline: str(meta.tagline, 500),
    contentRating: str(meta.contentRating, 40),
    rating: num(meta.rating),
    audienceRating: num(meta.audienceRating),
    duration: int(meta.duration),
    originallyAvailableAt: str(meta.originallyAvailableAt, 40),
    addedAt: int(meta.addedAt),
    thumb: str(meta.thumb, 300),
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
    studios: str(meta.studio, MAX_NAME) ? [str(meta.studio, MAX_NAME)] : [],
    actors,
  };
}
