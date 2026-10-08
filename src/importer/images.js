// SPDX-License-Identifier: GPL-3.0-or-later
// Pictures that live outside Plex (cast photos, studio logos) are only ever fetched from a short
// list of image hosts. Anything else is dropped at import time and refused again at fetch time,
// so a stored value can never point the server at your LAN or anywhere unexpected.

export const IMAGE_HOSTS = new Set(['metadata-static.plex.tv', 'image.tmdb.org']);

// TMDB serves the same picture at several sizes; w185 is plenty for the graph and the side panel.
const TMDB_SIZE = 'w185';

/**
 * Returns a cleaned https URL for an allowed image host, or null.
 * @param {unknown} raw
 */
export function cleanImageUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  if (!IMAGE_HOSTS.has(host)) return null;
  // Plain path characters only: no encoded bytes, no "..".
  if (!/^\/[A-Za-z0-9_\-./]+$/.test(u.pathname) || u.pathname.includes('..')) return null;
  let path = u.pathname;
  if (host === 'image.tmdb.org') {
    const m = /^\/t\/p\/[a-z0-9]+(\/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|svg|webp))$/i.exec(path);
    if (!m) return null;
    path = `/t/p/${TMDB_SIZE}${m[1].replace(/\.svg$/i, '.png')}`;
  }
  return `https://${host}${path}`;
}
