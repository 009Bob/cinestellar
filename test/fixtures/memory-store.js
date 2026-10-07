// In-memory stand-in for GraphStore with the same surface. Used to exercise the web UI and
// server without a database. It mirrors the Cypher semantics closely but is NOT a substitute
// for scripts/smoke.js, which runs the real queries against Neo4j.
import { assertLabel, LABELS, normalizeFilters } from '../../src/server/graph.js';

function passes(p, f) {
  if (f.yearFrom != null && !(p.year >= f.yearFrom)) return false;
  if (f.yearTo != null && !(p.year <= f.yearTo)) return false;
  if (f.minRating != null && !((p.audienceRating ?? p.rating ?? 0) >= f.minRating)) return false;
  if (f.contentRatings.length && !f.contentRatings.includes(p.contentRating)) return false;
  if (f.genres.length && !(p.genres ?? []).some((g) => f.genres.includes(g))) return false;
  return true;
}

export class MemoryStore {
  constructor() {
    this.nodes = new Map(); // id -> { label, props }
    this.edges = []; // { type, from, to, props }
  }

  async ping() {}
  async close() {}
  async ensureSchema() {}
  async isDedicated() { return true; }
  async assertDedicated() {}

  #tag(label, name) {
    const id = `${label}:${name}`;
    if (!this.nodes.has(id)) this.nodes.set(id, { label, props: { name } });
    return id;
  }

  #person(p) {
    const id = `Person:${p.key}`;
    const thumb = p.thumb ?? this.nodes.get(id)?.props.thumb ?? null;
    this.nodes.set(id, { label: 'Person', props: { key: p.key, name: p.name, thumb } });
    return id;
  }

  #pub(id) {
    const n = this.nodes.get(id);
    const { runId, serverId, libraryKey, thumb, ...rest } = n.props;
    return {
      id,
      label: n.label,
      name: n.label === 'Movie' ? n.props.title : n.props.name,
      props:
        n.label === 'Movie'
          ? { ...rest, hasPoster: Boolean(thumb), hasImage: Boolean(thumb) }
          : {
              hasImage: Boolean(
                n.label === 'Studio' ? n.props.logo : n.label === 'Collection' ? thumb || n.props.tmdbPoster : n.label === 'Person' ? thumb : null,
              ),
            },
    };
  }

  #dropMovie(id) {
    this.nodes.delete(id);
    this.edges = this.edges.filter((e) => e.from !== id && e.to !== id);
  }

  async upsertMovies(movies, runId) {
    for (const m of movies) {
      const id = `Movie:${m.id}`;
      this.edges = this.edges.filter((e) => e.from !== id && e.to !== id);
      this.nodes.set(id, { label: 'Movie', props: { ...m.props, id: m.id, runId, genres: m.genres } });
      const link = (type, from, to, props = {}) => this.edges.push({ type, from, to, props });
      m.genres.forEach((g) => link('IN_GENRE', id, this.#tag('Genre', g)));
      m.countries.forEach((c) => link('PRODUCED_IN', id, this.#tag('Country', c)));
      m.collections.forEach((c) => link('PART_OF', id, this.#tag('Collection', c)));
      const prevFranchise = this.franchises?.get(id);
      if (m.collections.length === 0 && prevFranchise) link('PART_OF', id, this.#tag('Collection', prevFranchise));
      m.studios.forEach((s) => link('MADE_BY', id, this.#tag('Studio', s)));
      m.directors.forEach((p) => link('DIRECTED', this.#person(p), id));
      m.writers.forEach((p) => link('WROTE', this.#person(p), id));
      (m.producers ?? []).forEach((p) => link('PRODUCED', this.#person(p), id));
      m.actors.forEach((a) => link('ACTED_IN', this.#person(a), id, { role: a.role, order: a.order }));
    }
  }

  async deleteStale({ serverId, libraryKey, runId }) {
    for (const [id, n] of [...this.nodes]) {
      const p = n.props;
      if (n.label === 'Movie' && p.serverId === serverId && p.libraryKey === libraryKey && p.runId !== runId) this.#dropMovie(id);
    }
  }

  async retainOnly({ serverId, libraryKeys }) {
    for (const [id, n] of [...this.nodes]) {
      const p = n.props;
      if (n.label === 'Movie' && !(p.serverId === serverId && libraryKeys.includes(p.libraryKey))) this.#dropMovie(id);
    }
  }

  async cleanOrphans() {
    const used = new Set(this.edges.flatMap((e) => [e.from, e.to]));
    for (const [id, n] of [...this.nodes]) if (n.label !== 'Movie' && !used.has(id)) this.nodes.delete(id);
  }

  async stats() {
    const nodes = {};
    for (const n of this.nodes.values()) nodes[n.label] = (nodes[n.label] ?? 0) + 1;
    return { nodes, relationships: this.edges.length };
  }

  async search(q, { limit = 20, types = LABELS } = {}) {
    const t = String(q ?? '').trim().toLowerCase();
    if (t.length < 2) return [];
    types.forEach(assertLabel);
    return [...this.nodes.keys()]
      .map((id) => this.#pub(id))
      .filter((n) => types.includes(n.label) && n.name.toLowerCase().includes(t))
      .sort((a, b) => Number(!a.name.toLowerCase().startsWith(t)) - Number(!b.name.toLowerCase().startsWith(t)) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
      .slice(0, limit)
      .map((n) => {
        if (n.label !== 'Person') return n;
        const films = this.edges
          .filter((e) => e.from === n.id && this.nodes.get(e.to)?.label === 'Movie')
          .map((e) => this.nodes.get(e.to).props)
          .sort((a, b) => (b.audienceRating ?? 0) - (a.audienceRating ?? 0) || a.title.localeCompare(b.title));
        return films.length ? { ...n, hint: films[0].title } : n;
      });
  }

  #neighbours(id, role = null) {
    const out = new Set();
    for (const e of this.edges) {
      if (role && e.type !== role) continue;
      if (e.from === id) out.add(e.to);
      else if (e.to === id) out.add(e.from);
    }
    return out;
  }

  /** Movie ids connected to every pick and passing the filters. */
  #pickedMovies(picks, filters) {
    const ids = picks.map((p) => `${p.label}:${p.key}`);
    if (!ids.every((id) => this.nodes.has(id))) return null;
    const sets = ids.map((id, i) => this.#neighbours(id, picks[i].role ?? null));
    return [...sets[0]].filter(
      (m) => this.nodes.get(m)?.label === 'Movie' && sets.every((s) => s.has(m)) && passes(this.nodes.get(m).props, filters),
    );
  }

  async top(label, limit = 25, { picks = [], filters = normalizeFilters(), role = null } = {}) {
    assertLabel(label);
    const allowed = picks.length ? new Set(this.#pickedMovies(picks, filters) ?? []) : null;
    const pickIds = new Set(picks.filter((p) => !p.role || !role || p.role === role).map((p) => `${p.label}:${p.key}`));
    const counts = new Map();
    for (const e of this.edges) {
      if (role && e.type !== role) continue;
      for (const [a, b] of [[e.from, e.to], [e.to, e.from]]) {
        const bn = this.nodes.get(b);
        if (this.nodes.get(a)?.label !== label || bn?.label !== 'Movie' || pickIds.has(a)) continue;
        if (allowed ? !allowed.has(b) : !passes(bn.props, filters)) continue;
        if (!counts.has(a)) counts.set(a, new Set());
        counts.get(a).add(b);
      }
    }
    return [...counts]
      .map(([id, s]) => ({ id, label, name: this.nodes.get(id).props.name, count: s.size, props: this.#pub(id).props }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, limit);
  }

  async timeline(picks = [], limit = 400, filters = normalizeFilters()) {
    const ids = picks.length
      ? this.#pickedMovies(picks, filters) ?? []
      : [...this.nodes].filter(([, n]) => n.label === 'Movie' && passes(n.props, filters)).map(([id]) => id);
    const dated = ids.filter((id) => this.nodes.get(id).props.year != null);
    const counts = new Map();
    for (const id of dated) {
      const d = Math.floor(this.nodes.get(id).props.year / 10) * 10;
      counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    const rating = (id) => this.nodes.get(id).props.audienceRating ?? this.nodes.get(id).props.rating ?? 0;
    const movies = dated
      .sort((a, b) => rating(b) - rating(a) || this.nodes.get(a).props.title.localeCompare(this.nodes.get(b).props.title))
      .slice(0, limit)
      .map((id) => this.#pub(id));
    const decades = [...counts].sort((a, b) => a[0] - b[0]).map(([decade, count]) => ({ decade, count }));
    return { movies, decades, total: dated.length };
  }

  async intersect(picks, limit = 150, filters = normalizeFilters()) {
    const movies = this.#pickedMovies(picks, filters);
    if (movies == null) return { picks: [], nodes: [], edges: [], total: 0, shown: 0 };
    const rating = (id) => this.nodes.get(id).props.audienceRating ?? this.nodes.get(id).props.rating ?? 0;
    const shown = movies.sort((a, b) => rating(b) - rating(a) || this.nodes.get(a).props.title.localeCompare(this.nodes.get(b).props.title)).slice(0, limit);
    const pickIds = picks.map((p) => `${p.label}:${p.key}`);
    const keep = new Set(shown);
    const edges = this.edges
      .filter((e) => (keep.has(e.from) && pickIds.includes(e.to)) || (keep.has(e.to) && pickIds.includes(e.from)))
      .map((e) => ({ source: e.from, target: e.to, type: e.type, ...(e.props.role ? { role: e.props.role } : {}), ...(e.props.order != null ? { order: e.props.order } : {}) }));
    return {
      picks: pickIds.map((id) => this.#pub(id)),
      nodes: [...pickIds, ...shown].map((id) => this.#pub(id)),
      edges,
      total: movies.length,
      shown: shown.length,
    };
  }

  async expand(label, key, limit = 60, filters = normalizeFilters()) {
    assertLabel(label);
    const id = `${label}:${key}`;
    if (!this.nodes.has(id)) return { center: null, nodes: [], edges: [], total: 0, shown: 0 };
    const ok = (e) => {
      const o = this.nodes.get(e.from === id ? e.to : e.from);
      return o.label !== 'Movie' || passes(o.props, filters);
    };
    const rels = this.edges.filter((e) => (e.from === id || e.to === id) && ok(e));
    const other = (e) => this.nodes.get(e.from === id ? e.to : e.from).props;
    const sorted =
      label === 'Movie'
        ? [...rels].sort((a, b) => (a.props.order == null ? -1 : a.props.order) - (b.props.order == null ? -1 : b.props.order))
        : [...rels].sort((a, b) => (other(b).audienceRating ?? 0) - (other(a).audienceRating ?? 0));
    const shown = sorted.slice(0, limit);
    const ids = new Set([id, ...shown.flatMap((e) => [e.from, e.to])]);
    return {
      center: this.#pub(id),
      nodes: [...ids].map((i) => this.#pub(i)),
      edges: shown.map((e) => ({ source: e.from, target: e.to, type: e.type, ...(e.props.role ? { role: e.props.role } : {}), ...(e.props.order != null ? { order: e.props.order } : {}) })),
      total: rels.length,
      shown: shown.length,
    };
  }

  async similar(movieId, limit = 12, filters = normalizeFilters()) {
    const id = `Movie:${movieId}`;
    if (!this.nodes.has(id)) return [];
    const mine = this.edges.filter((e) => e.from === id || e.to === id);
    // Strongest link per (other movie, shared thing), like the Cypher's max(...) per pair.
    const best = new Map(); // `${o}|${x}` -> { o, x, xl, w }
    for (const r1 of mine) {
      const x = r1.from === id ? r1.to : r1.from;
      const xl = this.nodes.get(x).label;
      if (xl === 'Country') continue;
      for (const r2 of this.edges) {
        if (r2 === r1 || (r2.from !== x && r2.to !== x)) continue;
        const o = r2.from === x ? r2.to : r2.from;
        if (o === id || this.nodes.get(o).label !== 'Movie' || !passes(this.nodes.get(o).props, filters)) continue;
        let w = 0;
        if (xl === 'Collection') w = 6;
        else if (xl === 'Person' && r1.type === 'DIRECTED' && r2.type === 'DIRECTED') w = 5;
        else if (xl === 'Person' && r1.type === 'WROTE' && r2.type === 'WROTE') w = 3;
        else if (xl === 'Person' && r1.type === 'PRODUCED' && r2.type === 'PRODUCED') w = 1.5;
        else if (xl === 'Person' && r1.type === 'ACTED_IN' && r2.type === 'ACTED_IN') w = r1.props.order < 5 && r2.props.order < 5 ? 3 : 1.5;
        else if (xl === 'Person' || xl === 'Studio' || xl === 'Genre') w = 1;
        const k = `${o}|${x}`;
        if (!best.has(k) || best.get(k).w < w) best.set(k, { o, x, xl, w });
      }
    }
    const scores = new Map();
    for (const { o, x, xl, w } of [...best.values()].sort((a, b) => b.w - a.w)) {
      const s = scores.get(o) ?? { score: 0, shared: new Set(), sharedGenres: new Set() };
      s.score += w;
      const name = this.nodes.get(x).props.name;
      if (xl === 'Genre') s.sharedGenres.add(name);
      else if (xl !== 'Studio') s.shared.add(name);
      scores.set(o, s);
    }
    return [...scores]
      .map(([o, s]) => ({ ...this.#pub(o), score: s.score, shared: [...s.shared].slice(0, 6), sharedGenres: [...s.sharedGenres] }))
      .sort((a, b) => b.score - a.score || (b.props.audienceRating ?? 0) - (a.props.audienceRating ?? 0) || a.name.localeCompare(b.name))
      .slice(0, limit);
  }

  async facets() {
    const movies = [...this.nodes.values()].filter((n) => n.label === 'Movie').map((n) => n.props);
    const years = movies.map((m) => m.year).filter((y) => y != null);
    const genres = await this.top('Genre', 1000);
    return {
      minYear: years.length ? Math.min(...years) : null,
      maxYear: years.length ? Math.max(...years) : null,
      contentRatings: [...new Set(movies.map((m) => m.contentRating).filter(Boolean))].sort(),
      genres: genres.map((g) => ({ name: g.name, count: g.count })),
      needsReimport: movies.some((m) => m.genres == null),
    };
  }

  async overview(maxGenres = 30, filters = normalizeFilters()) {
    const genres = await this.top('Genre', maxGenres, { filters });
    const names = new Set(genres.map((g) => g.id));
    const byMovie = new Map();
    for (const e of this.edges) {
      if (e.type === 'IN_GENRE' && names.has(e.to) && passes(this.nodes.get(e.from).props, filters)) byMovie.set(e.from, [...(byMovie.get(e.from) ?? []), e.to]);
    }
    const w = new Map();
    for (const gs of byMovie.values()) for (const a of gs) for (const b of gs) if (a < b) w.set(`${a}|${b}`, (w.get(`${a}|${b}`) ?? 0) + 1);
    return {
      nodes: genres.map((g) => ({ id: g.id, label: 'Genre', name: g.name, count: g.count, props: {} })),
      edges: [...w].map(([k, weight]) => {
        const [source, target] = k.split('|');
        return { source, target, type: 'SHARES_MOVIES', weight };
      }),
    };
  }

  async path(from, to) {
    for (const end of [from, to]) {
      if (end.label !== 'Movie' && end.label !== 'Person') throw Object.assign(new Error('Connections are between people and movies'), { status: 400 });
    }
    const a = `${from.label}:${from.key}`;
    const b = `${to.label}:${to.key}`;
    if (a === b || !this.nodes.has(a) || !this.nodes.has(b)) return null;
    const rels = this.edges.filter((e) => ['ACTED_IN', 'DIRECTED', 'WROTE', 'PRODUCED'].includes(e.type));
    const prev = new Map([[a, null]]);
    for (const q = [a]; q.length; ) {
      const cur = q.shift();
      if (cur === b) break;
      for (const e of rels) {
        const nxt = e.from === cur ? e.to : e.to === cur ? e.from : null;
        if (nxt && !prev.has(nxt)) {
          prev.set(nxt, { cur, e });
          q.push(nxt);
        }
      }
    }
    if (!prev.has(b)) return null;
    const ids = [];
    const edges = [];
    for (let at = b; at; ) {
      ids.unshift(at);
      const step = prev.get(at);
      if (step) edges.unshift({ source: step.e.from, target: step.e.to, type: step.e.type, ...(step.e.props.role ? { role: step.e.props.role } : {}) });
      at = step?.cur ?? null;
    }
    return { nodes: ids.map((i) => this.#pub(i)), edges };
  }

  async posterPath(movieId) {
    return (await this.imageSource('Movie', movieId))?.plex ?? null;
  }

  async imageSource(label, key) {
    assertLabel(label);
    const p = this.nodes.get(`${label}:${key}`)?.props;
    if (!p) return null;
    if (label === 'Collection') return p.thumb ? { plex: p.thumb } : p.tmdbPoster ? { web: p.tmdbPoster } : null;
    const v = { Movie: p.thumb, Person: p.thumb, Studio: p.logo }[label];
    if (!v) return null;
    return label === 'Movie' ? { plex: v } : { web: v };
  }

  async setCollectionPosters(list) {
    let n = 0;
    for (const c of list) {
      const node = this.nodes.get(`Collection:${c.name}`);
      if (node) {
        node.props.thumb = c.thumb;
        n += 1;
      }
    }
    return n;
  }

  async moviesNeedingFranchise() {
    this.franchiseChecked ??= new Set();
    return [...this.nodes]
      .filter(([id, n]) => n.label === 'Movie' && n.props.tmdbId && !this.franchiseChecked.has(id) &&
        !this.edges.some((e) => e.type === 'PART_OF' && e.from === id))
      .map(([, n]) => ({ id: n.props.id, tmdbId: String(n.props.tmdbId) }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async setFranchises(list) {
    this.franchises ??= new Map();
    this.franchiseChecked ??= new Set();
    for (const f of list) {
      const id = `Movie:${f.id}`;
      if (!this.nodes.has(id)) continue;
      this.franchiseChecked.add(id);
      if (!f.name) {
        this.franchises.delete(id);
        continue;
      }
      this.franchises.set(id, f.name);
      if (this.edges.some((e) => e.type === 'PART_OF' && e.from === id)) continue;
      const c = this.#tag('Collection', f.name);
      this.nodes.get(c).props.tmdbPoster ??= f.poster ?? undefined;
      this.edges.push({ type: 'PART_OF', from: id, to: c, props: {} });
    }
  }

  async studiosNeedingLogos() {
    return [...this.nodes.values()]
      .filter((n) => n.label === 'Studio' && n.props.logoChecked == null)
      .map((n) => n.props.name)
      .sort();
  }

  async setStudioLogos(list) {
    for (const l of list) {
      const node = this.nodes.get(`Studio:${l.name}`);
      if (node) Object.assign(node.props, { logo: l.logo ?? undefined, logoChecked: Date.now() });
    }
  }
}

