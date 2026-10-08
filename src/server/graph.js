// SPDX-License-Identifier: GPL-3.0-or-later
// Neo4j access layer. All user-supplied values go through query parameters; the only
// interpolated pieces are node labels and property names, and those come from fixed allow-lists.
//
// Cinestellar expects a Neo4j of its own (the docker-compose bundle runs a Community-edition
// instance in its own container and volume). Every node it creates carries `pg = true`, it
// refuses to import into a database holding anything else, and cleanups only touch its nodes.
import neo4j from 'neo4j-driver';

export const LABELS = ['Movie', 'Person', 'Genre', 'Country', 'Collection', 'Studio'];
const KEY_PROP = { Movie: 'id', Person: 'key', Genre: 'name', Country: 'name', Collection: 'name', Studio: 'name' };
const PATH_RELS = 'ACTED_IN|DIRECTED|WROTE|PRODUCED';
/** The ways a person can be linked to a movie; a pick or a Browse tab can be limited to one. */
export const ROLES = ['ACTED_IN', 'DIRECTED', 'WROTE', 'PRODUCED'];

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });
const conflict = (message) => Object.assign(new Error(message), { status: 409 });

export function assertLabel(label) {
  if (!LABELS.includes(label)) throw badRequest(`Unknown node type "${label}"`);
  return label;
}

// Movies TMDB had no franchise for are asked again after this long (franchises get added).
const FRANCHISE_RECHECK_MS = 90 * 24 * 3600 * 1000;

const clamp = (n, lo, hi, dflt) => {
  const v = Number.isFinite(+n) ? Math.trunc(+n) : dflt;
  return Math.min(hi, Math.max(lo, v));
};

/** JS numbers are sent as floats by the driver; store whole numbers as Neo4j integers. */
function toBolt(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? neo4j.int(value) : value;
  if (Array.isArray(value)) return value.map(toBolt);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toBolt(v)]));
  }
  return value;
}

/**
 * Movie filters, from query-string values. Empty / missing values mean "no limit".
 * @returns {{yearFrom:number|null, yearTo:number|null, minRating:number|null, genres:string[], contentRatings:string[], active:boolean}}
 */
export function normalizeFilters(f = {}) {
  const num = (v) => (v === '' || v == null || !Number.isFinite(+v) ? null : +v);
  const list = (v) =>
    (Array.isArray(v) ? v : typeof v === 'string' && v ? v.split(',') : [])
      .map((x) => String(x).trim())
      .filter(Boolean)
      .slice(0, 50);
  const out = {
    yearFrom: num(f.yearFrom),
    yearTo: num(f.yearTo),
    minRating: num(f.minRating),
    genres: list(f.genres),
    contentRatings: list(f.contentRatings),
  };
  out.active = out.yearFrom != null || out.yearTo != null || out.minRating != null || out.genres.length > 0 || out.contentRatings.length > 0;
  return out;
}

/** Cypher predicate for a movie variable `v` against the filter parameters. */
const movieFilter = (v) => `(
  ($yearFrom IS NULL OR ${v}.year >= $yearFrom) AND
  ($yearTo IS NULL OR ${v}.year <= $yearTo) AND
  ($minRating IS NULL OR coalesce(${v}.audienceRating, ${v}.rating, 0) >= $minRating) AND
  (size($contentRatings) = 0 OR ${v}.contentRating IN $contentRatings) AND
  (size($genres) = 0 OR EXISTS { MATCH (${v})-[:IN_GENRE]->(fg:Genre) WHERE fg.name IN $genres })
)`;

const filterParams = ({ yearFrom, yearTo, minRating, genres, contentRatings }) => ({ yearFrom, yearTo, minRating, genres, contentRatings });

/** Things you can combine ("movies with X and Y"): everything except movies themselves. */
export const PICK_LABELS = LABELS.filter((l) => l !== 'Movie');
export const MAX_PICKS = 6;

/**
 * Validates a list of picks ({label, key}) from the browser.
 * @returns {{label:string, key:string}[]}
 */
export function normalizePicks(raw) {
  let list = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw);
    } catch {
      throw badRequest('picks must be a JSON list');
    }
  }
  if (list == null) return [];
  if (!Array.isArray(list)) throw badRequest('picks must be a list');
  if (list.length > MAX_PICKS) throw badRequest(`At most ${MAX_PICKS} picks can be combined`);
  return list.map((p) => {
    if (!p || !PICK_LABELS.includes(p.label)) throw badRequest('Each pick needs a person, genre, country, collection or studio');
    if (typeof p.key !== 'string' || !p.key || p.key.length > 300) throw badRequest('Each pick needs a key');
    const role = normalizeRole(p.role);
    if (role && p.label !== 'Person') throw badRequest('Only people have roles');
    return { label: p.label, key: p.key, ...(role ? { role } : {}) };
  });
}

export function normalizeRole(role) {
  if (role == null || role === '') return null;
  if (!ROLES.includes(role)) throw badRequest(`Unknown role "${role}"`);
  return role;
}

/**
 * Cypher pieces for "movies connected to every pick". The picks are bound as a0, a1, …;
 * `movies` leaves rows of (m, a0, a1, …) with each matching movie once.
 */
function picksQuery(picks) {
  const params = {};
  const vars = picks.map((_, i) => `a${i}`);
  const nodes = picks.map((p, i) => {
    params[`k${i}`] = p.key;
    return `(a${i}:${p.label} {${KEY_PROP[p.label]}: $k${i}})`;
  });
  // A pick with a role only matches through that relationship ("directed by", not just "in").
  const link = (i) => (picks[i].role ? `<-[:${picks[i].role}]-` : '--');
  const others = vars.slice(1).map((v, j) => `(m)${link(j + 1)}(${v})`);
  const movies = `MATCH ${nodes.join(', ')}
       MATCH (a0)${picks[0].role ? `-[:${picks[0].role}]->` : '--'}(m:Movie)
       WHERE ${[...others, movieFilter('m')].join(' AND ')}
       WITH DISTINCT m, ${vars.join(', ')}`;
  return { params, vars, movies, matchPicks: `MATCH ${nodes.join(', ')}` };
}

export const nodeId = (label, props) => `${label}:${props[KEY_PROP[label]]}`;

function toNode(n) {
  const label = n.labels.find((l) => LABELS.includes(l));
  if (!label) throw new Error(`Unexpected node with labels ${n.labels.join(',')}`);
  const props = { ...n.properties };
  return {
    id: nodeId(label, props),
    label,
    name: label === 'Movie' ? props.title : props.name,
    props: label === 'Movie' ? publicMovieProps(props) : { hasImage: Boolean(imageOf(label, props)) },
    _eid: n.elementId,
  };
}

// Where each kind of node keeps its picture: a Plex path (Movie.thumb, Collection.thumb) or a
// web URL on an allowed image host (Person.thumb, Studio.logo, and Collection.tmdbPoster for
// franchises that only TMDB knows about).
const IMAGE_PROP = { Movie: 'thumb', Collection: 'thumb', Person: 'thumb', Studio: 'logo' };
const IMAGE_EXPR = {
  Movie: 'n.thumb',
  Collection: 'coalesce(n.thumb, n.tmdbPoster)',
  Person: 'n.thumb',
  Studio: 'n.logo',
};

function imageOf(label, props) {
  if (label === 'Movie' && props.thumb) return { plex: props.thumb };
  if (label === 'Collection') return props.thumb ? { plex: props.thumb } : props.tmdbPoster ? { web: props.tmdbPoster } : null;
  if ((label === 'Person' && props.thumb) || (label === 'Studio' && props.logo)) return { web: props[IMAGE_PROP[label]] };
  return null;
}

// Never send internal bookkeeping, server ids or Plex paths to the browser.
function publicMovieProps({ runId, serverId, libraryKey, thumb, pg, search, franchiseChecked, ...rest }) {
  return { ...rest, hasPoster: Boolean(thumb), hasImage: Boolean(thumb) };
}

const stripInternal = ({ _eid, ...n }) => n;

function toEdge(rel, byEid) {
  const e = {
    source: byEid.get(rel.startNodeElementId),
    target: byEid.get(rel.endNodeElementId),
    type: rel.type,
  };
  if (rel.properties.role) e.role = rel.properties.role;
  if (typeof rel.properties.order === 'number') e.order = rel.properties.order;
  return e;
}

export class GraphStore {
  /** @param {{uri:string,user:string,password:string,database?:string}} o */
  constructor({ uri, user, password, database }) {
    this.database = database || undefined; // undefined = the server's default database
    this.driver = neo4j.driver(uri, neo4j.auth.basic(user, password), {
      disableLosslessIntegers: true,
    });
  }

  async close() {
    await this.driver.close();
  }

  async ping() {
    await this.driver.verifyConnectivity({ database: this.database });
  }

  #session(mode) {
    return this.driver.session({ database: this.database, defaultAccessMode: mode });
  }

  async #read(fn) {
    const session = this.#session(neo4j.session.READ);
    try {
      return await session.executeRead(fn);
    } finally {
      await session.close();
    }
  }

  async #write(fn) {
    const session = this.#session(neo4j.session.WRITE);
    try {
      return await session.executeWrite(fn);
    } finally {
      await session.close();
    }
  }

  // ---- safety ------------------------------------------------------------

  /** True when the database holds nothing that Cinestellar did not create. */
  async isDedicated() {
    return this.#read(async (tx) => {
      // Ours means exactly `pg = true` on one of our labels. Anything else (no pg, pg = false,
      // pg = 'PG' from someone's movie dataset, or a label we never create) is someone else's.
      const res = await tx.run(
        `MATCH (n)
         WHERE coalesce(n.pg = true, false) = false OR NOT any(l IN labels(n) WHERE l IN $labels)
         RETURN 1 AS hit LIMIT 1`,
        { labels: LABELS },
      );
      return res.records.length === 0;
    });
  }

  async assertDedicated() {
    if (!(await this.isDedicated())) {
      throw conflict(
        'This Neo4j database already contains data that Cinestellar did not create. Cinestellar needs a ' +
          'database of its own: use the Neo4j bundled in docker-compose.yml (Community edition, no license needed).',
      );
    }
  }

  // ---- writing -----------------------------------------------------------

  async ensureSchema() {
    const session = this.#session(neo4j.session.WRITE);
    try {
      // v0.1 keyed people by name; that constraint would block two people who share a name.
      // Old name-keyed Person nodes lose their relationships on re-import and are then removed
      // as orphans.
      await session.run('DROP CONSTRAINT person_name IF EXISTS');
      for (const label of LABELS) {
        const prop = KEY_PROP[label];
        const lower = label.toLowerCase();
        await session.run(`CREATE CONSTRAINT ${lower}_${prop} IF NOT EXISTS FOR (n:${label}) REQUIRE n.${prop} IS UNIQUE`);
        // Text indexes make the case-insensitive `search CONTAINS` lookups fast on big libraries.
        await session.run(`CREATE TEXT INDEX ${lower}_search IF NOT EXISTS FOR (n:${label}) ON (n.search)`);
      }
    } finally {
      await session.close();
    }
  }

  async upsertMovies(movies, runId) {
    if (movies.length === 0) return;
    const ids = movies.map((m) => m.id);
    await this.#write(async (tx) => {
      // Drop old relationships first so tags removed in Plex disappear from the graph.
      await tx.run('UNWIND $ids AS id MATCH (m:Movie {id: id})-[r]-() WHERE m.pg = true DELETE r', { ids });
      await tx.run(
        `UNWIND $movies AS m
         MERGE (mv:Movie {id: m.id})
         SET mv += m.props, mv.runId = $runId, mv.pg = true, mv.search = toLower(m.props.title), mv.genres = m.genres
         FOREACH (n IN m.genres      | MERGE (x:Genre      {name: n}) SET x.pg = true, x.search = toLower(n) MERGE (mv)-[:IN_GENRE]->(x))
         FOREACH (n IN m.countries   | MERGE (x:Country    {name: n}) SET x.pg = true, x.search = toLower(n) MERGE (mv)-[:PRODUCED_IN]->(x))
         FOREACH (n IN m.collections | MERGE (x:Collection {name: n}) SET x.pg = true, x.search = toLower(n) MERGE (mv)-[:PART_OF]->(x))
         FOREACH (n IN m.studios     | MERGE (x:Studio     {name: n}) SET x.pg = true, x.search = toLower(n) MERGE (mv)-[:MADE_BY]->(x))
         FOREACH (p IN m.directors   | MERGE (x:Person {key: p.key}) SET x.pg = true, x.name = p.name, x.search = toLower(p.name), x.thumb = coalesce(p.thumb, x.thumb)
                                       MERGE (x)-[:DIRECTED]->(mv))
         FOREACH (p IN m.writers     | MERGE (x:Person {key: p.key}) SET x.pg = true, x.name = p.name, x.search = toLower(p.name), x.thumb = coalesce(p.thumb, x.thumb)
                                       MERGE (x)-[:WROTE]->(mv))
         FOREACH (p IN coalesce(m.producers, []) | MERGE (x:Person {key: p.key}) SET x.pg = true, x.name = p.name, x.search = toLower(p.name), x.thumb = coalesce(p.thumb, x.thumb)
                                       MERGE (x)-[:PRODUCED]->(mv))
         FOREACH (a IN m.actors      | MERGE (x:Person {key: a.key}) SET x.pg = true, x.name = a.name, x.search = toLower(a.name), x.thumb = coalesce(a.thumb, x.thumb)
                                       MERGE (x)-[r:ACTED_IN]->(mv)
                                       SET r.role = a.role, r.order = a.order)
         // A franchise found on TMDB earlier stands in while Plex has no collection for the movie.
         FOREACH (n IN CASE WHEN size(m.collections) = 0 AND mv.franchise IS NOT NULL THEN [mv.franchise] ELSE [] END |
                                       MERGE (x:Collection {name: n}) SET x.pg = true, x.search = toLower(n) MERGE (mv)-[:PART_OF]->(x))`,
        { movies: toBolt(movies), runId },
      );
    });
  }

  async deleteStale({ serverId, libraryKey, runId }) {
    await this.#write((tx) =>
      tx.run(
        'MATCH (m:Movie {serverId: $serverId, libraryKey: $libraryKey}) WHERE m.pg = true AND m.runId <> $runId DETACH DELETE m',
        { serverId, libraryKey, runId },
      ),
    );
  }

  /** Removes movies from libraries that are no longer chosen, or from a previously connected server. */
  async retainOnly({ serverId, libraryKeys }) {
    await this.#write((tx) =>
      tx.run(
        `MATCH (m:Movie) WHERE m.pg = true AND NOT (m.serverId = $serverId AND m.libraryKey IN $libraryKeys)
         DETACH DELETE m`,
        { serverId, libraryKeys },
      ),
    );
  }

  async cleanOrphans() {
    await this.#write((tx) =>
      tx.run(
        'MATCH (n) WHERE n.pg = true AND (n:Person OR n:Genre OR n:Country OR n:Collection OR n:Studio) AND NOT (n)--() DELETE n',
      ),
    );
  }

  // ---- reading -----------------------------------------------------------

  async stats() {
    return this.#read(async (tx) => {
      const nodes = await tx.run('MATCH (n) RETURN labels(n)[0] AS label, count(n) AS count');
      const rels = await tx.run('MATCH ()-[r]->() RETURN count(r) AS count');
      return {
        nodes: Object.fromEntries(nodes.records.map((r) => [r.get('label'), r.get('count')])),
        relationships: rels.records[0]?.get('count') ?? 0,
      };
    });
  }

  /**
   * Case-insensitive substring search, prefix matches first.
   * @param {string} q
   * @param {{limit?:number, types?:string[]}} [opts]  types limits the node labels searched
   */
  async search(q, { limit = 20, types = LABELS } = {}) {
    const text = String(q ?? '').trim().toLowerCase();
    if (text.length < 2) return [];
    const labels = [...new Set(types)].map(assertLabel);
    if (labels.length === 0) return [];
    // One indexed branch per label; each branch keeps its own best `limit`, so the merged top
    // `limit` is exact.
    const branch = (label) =>
      `MATCH (n:${label}) WHERE n.search CONTAINS $q
       WITH n ORDER BY CASE WHEN n.search STARTS WITH $q THEN 0 ELSE 1 END, n.search LIMIT $limit
       RETURN n`;
    return this.#read(async (tx) => {
      const res = await tx.run(
        `CALL { ${labels.map(branch).join(' UNION ')} }
         WITH n ORDER BY CASE WHEN n.search STARTS WITH $q THEN 0 ELSE 1 END, n.search
         LIMIT $limit
         RETURN n`,
        { q: text, limit: neo4j.int(clamp(limit, 1, 50, 20)) },
      );
      const nodes = res.records.map((r) => stripInternal(toNode(r.get('n'))));
      // Two people can share a name, so show each person's best-known title next to them.
      const keys = nodes.filter((n) => n.label === 'Person').map((n) => n.id.slice('Person:'.length));
      if (keys.length) {
        const known = await tx.run(
          `UNWIND $keys AS k
           MATCH (p:Person {key: k})-->(m:Movie)
           WITH k, m ORDER BY coalesce(m.audienceRating, m.rating, 0) DESC, m.title
           RETURN k, collect(m.title)[0] AS knownFor`,
          { keys },
        );
        const byKey = new Map(known.records.map((r) => [r.get('k'), r.get('knownFor')]));
        for (const n of nodes) {
          if (n.label === 'Person' && byKey.has(n.id.slice('Person:'.length))) n.hint = byKey.get(n.id.slice('Person:'.length));
        }
      }
      return nodes;
    });
  }

  /**
   * The biggest people / genres / studios … by number of movies. With picks, only movies that
   * match every pick are counted (and the picks themselves are left out), so the list shows
   * what you can narrow down to next. Filters always apply.
   */
  async top(label, limit = 25, { picks = [], filters = normalizeFilters(), role = null } = {}) {
    assertLabel(label);
    if (label === 'Movie') throw badRequest('Use search for movies');
    role = normalizeRole(role);
    if (role && label !== 'Person') throw badRequest('Only people have roles');
    const key = KEY_PROP[label];
    const rel = role ? `-[:${role}]-` : '--';
    const lim = neo4j.int(clamp(limit, 1, 100, 25));
    const fp = filterParams(filters);
    const img = IMAGE_EXPR[label] ? `${IMAGE_EXPR[label]} IS NOT NULL` : 'false';
    return this.#read(async (tx) => {
      let res;
      if (picks.length === 0) {
        res = await tx.run(
          `MATCH (n:${label})${rel}(m:Movie)
           WHERE ${movieFilter('m')}
           WITH n, count(DISTINCT m) AS c
           ORDER BY c DESC, n.name
           LIMIT $limit
           RETURN n.${key} AS key, n.name AS name, c, ${img} AS img`,
          { limit: lim, ...fp },
        );
      } else {
        const q = picksQuery(picks);
        // Leave out what's already picked in this same sense (a picked director can still be
        // offered as cast, since "directed by X and starring X" is a real question).
        const same = q.vars.filter((_, i) => !picks[i].role || picks[i].role === role || !role);
        res = await tx.run(
          `${q.movies}
           MATCH (m)${rel}(n:${label})
           WHERE NOT n IN [${same.join(', ')}]
           WITH n, count(DISTINCT m) AS c
           ORDER BY c DESC, n.name
           LIMIT $limit
           RETURN n.${key} AS key, n.name AS name, c, ${img} AS img`,
          { limit: lim, ...fp, ...q.params },
        );
      }
      return res.records.map((r) => ({
        id: `${label}:${r.get('key')}`,
        label,
        name: r.get('name'),
        count: r.get('c'),
        props: { hasImage: r.get('img') },
      }));
    });
  }

  /**
   * Movies connected to every pick (e.g. Keanu Reeves AND Silver Pictures), best rated first,
   * with the links from each movie to each pick. `total` counts all matches; `shown` how many
   * came back.
   */
  async intersect(picks, limit = 150, filters = normalizeFilters()) {
    if (picks.length === 0) throw badRequest('Pick at least one thing');
    const q = picksQuery(picks);
    const lim = neo4j.int(clamp(limit, 1, 300, 150));
    const fp = filterParams(filters);
    return this.#read(async (tx) => {
      const found = await tx.run(`${q.matchPicks} RETURN ${q.vars.join(', ')}`, q.params);
      if (found.records.length === 0) return { picks: [], nodes: [], edges: [], total: 0, shown: 0 };
      const pickNodes = q.vars.map((v) => toNode(found.records[0].get(v)));
      const total = await tx.run(`${q.movies} RETURN count(m) AS total`, { ...q.params, ...fp });
      const res = await tx.run(
        `${q.movies}
         ORDER BY coalesce(m.audienceRating, m.rating, 0) DESC, m.title
         LIMIT $limit
         MATCH (m)-[r]-(x) WHERE x IN [${q.vars.join(', ')}]
         RETURN m, r, x`,
        { ...q.params, ...fp, limit: lim },
      );
      const nodes = new Map(pickNodes.map((n) => [n.id, n]));
      const byEid = new Map(pickNodes.map((n) => [n._eid, n.id]));
      const movies = new Set();
      const edges = [];
      for (const rec of res.records) {
        const m = toNode(rec.get('m'));
        nodes.set(m.id, m);
        byEid.set(m._eid, m.id);
        movies.add(m.id);
        edges.push(toEdge(rec.get('r'), byEid));
      }
      // Best rated first, in JS: Neo4j doesn't promise to keep the ORDER BY through the last MATCH.
      const score = (n) => n.props?.audienceRating ?? n.props?.rating ?? 0;
      const movieNodes = [...nodes.values()]
        .filter((n) => movies.has(n.id))
        .sort((a, b) => score(b) - score(a) || String(a.name).localeCompare(String(b.name)));
      return {
        picks: pickNodes.map(stripInternal),
        nodes: [...pickNodes, ...movieNodes].map(stripInternal),
        edges,
        total: total.records[0]?.get('total') ?? 0,
        shown: movies.size,
      };
    });
  }

  /**
   * Movies for the timeline: the best rated `limit` (of the picks' results, or the whole
   * library), plus how many movies each decade has in total. Undated movies are left out.
   */
  async timeline(picks = [], limit = 400, filters = normalizeFilters()) {
    const lim = neo4j.int(clamp(limit, 1, 1000, 400));
    const fp = filterParams(filters);
    let base;
    let params = { ...fp };
    if (picks.length) {
      const q = picksQuery(picks);
      base = `${q.movies}
       WHERE m.year IS NOT NULL`;
      params = { ...params, ...q.params };
    } else {
      base = `MATCH (m:Movie)
       WHERE m.year IS NOT NULL AND ${movieFilter('m')}`;
    }
    return this.#read(async (tx) => {
      const decades = await tx.run(
        `${base}
         WITH (toInteger(m.year) / 10) * 10 AS decade, count(*) AS c
         RETURN decade, c ORDER BY decade`,
        params,
      );
      const res = await tx.run(
        `${base}
         WITH m ORDER BY coalesce(m.audienceRating, m.rating, 0) DESC, m.title LIMIT $limit
         RETURN m`,
        { ...params, limit: lim },
      );
      const counts = decades.records.map((r) => ({ decade: r.get('decade'), count: r.get('c') }));
      return {
        movies: res.records.map((r) => stripInternal(toNode(r.get('m')))),
        decades: counts,
        total: counts.reduce((sum, d) => sum + d.count, 0),
      };
    });
  }

  /**
   * Neighbours of one node, capped. `total` is the real relationship count (after filters).
   * Filters only ever hide movies; people, genres and the like are always shown.
   */
  async expand(label, key, limit = 60, filters = normalizeFilters()) {
    assertLabel(label);
    const keyProp = KEY_PROP[label];
    const lim = clamp(limit, 1, 300, 60);
    const fp = filterParams(filters);
    // A movie lists its cast in billing order; everything else lists its best-rated films first.
    const order =
      label === 'Movie'
        ? 'ORDER BY CASE WHEN r.order IS NULL THEN 0 ELSE 1 END, r.order, coalesce(m.title, m.name)'
        : 'ORDER BY coalesce(m.audienceRating, m.rating, 0) DESC, coalesce(m.title, m.name)';
    return this.#read(async (tx) => {
      const res = await tx.run(
        `MATCH (n:${label} {${keyProp}: $key})-[r]-(m)
         WHERE NOT m:Movie OR ${movieFilter('m')}
         RETURN n, r, m
         ${order}
         LIMIT $limit`,
        { key, limit: neo4j.int(lim), ...fp },
      );
      const total = await tx.run(
        `MATCH (:${label} {${keyProp}: $key})-[r]-(m)
         WHERE NOT m:Movie OR ${movieFilter('m')}
         RETURN count(r) AS total`,
        { key, ...fp },
      );
      let center = null;
      const nodes = new Map();
      const edges = [];
      const byEid = new Map();
      for (const rec of res.records) {
        const n = toNode(rec.get('n'));
        const m = toNode(rec.get('m'));
        center = n;
        for (const x of [n, m]) {
          nodes.set(x.id, x);
          byEid.set(x._eid, x.id);
        }
        edges.push(toEdge(rec.get('r'), byEid));
      }
      if (!center) {
        // Node exists but has no relationships (or does not exist at all).
        const one = await tx.run(`MATCH (n:${label} {${keyProp}: $key}) RETURN n`, { key });
        if (one.records[0]) center = toNode(one.records[0].get('n'));
        if (center) nodes.set(center.id, center);
      }
      return {
        center: center ? stripInternal(center) : null,
        nodes: [...nodes.values()].map(stripInternal),
        edges,
        total: total.records[0]?.get('total') ?? 0,
        shown: edges.length,
      };
    });
  }

  /**
   * "More like this": other movies ranked by what they share with this one. Shared collections
   * and directors count most, then writers and top-billed cast, then the rest of the cast,
   * studios and genres. Countries are ignored (nearly everything shares one). Each shared
   * person or thing counts once, by its strongest link (a director who also wrote both films
   * counts as a shared director), and the reasons are listed strongest first.
   */
  async similar(movieId, limit = 12, filters = normalizeFilters()) {
    const lim = neo4j.int(clamp(limit, 1, 50, 12));
    return this.#read(async (tx) => {
      const res = await tx.run(
        `MATCH (m:Movie {id: $id})-[r1]-(x)-[r2]-(o:Movie)
         WHERE o <> m AND NOT x:Country AND ${movieFilter('o')}
         WITH m, o, x, max(
              CASE
                WHEN x:Collection THEN 6.0
                WHEN x:Person AND type(r1) = 'DIRECTED' AND type(r2) = 'DIRECTED' THEN 5.0
                WHEN x:Person AND type(r1) = 'WROTE' AND type(r2) = 'WROTE' THEN 3.0
                WHEN x:Person AND type(r1) = 'PRODUCED' AND type(r2) = 'PRODUCED' THEN 1.5
                WHEN x:Person AND type(r1) = 'ACTED_IN' AND type(r2) = 'ACTED_IN'
                     THEN CASE WHEN r1.order < 5 AND r2.order < 5 THEN 3.0 ELSE 1.5 END
                WHEN x:Person THEN 1.0
                WHEN x:Studio THEN 1.0
                WHEN x:Genre THEN 1.0
                ELSE 0.0
              END) AS w
         ORDER BY w DESC
         WITH m, o, sum(w) AS score,
              collect(DISTINCT CASE WHEN NOT x:Genre AND NOT x:Studio THEN x.name END) AS shared,
              collect(DISTINCT CASE WHEN x:Genre THEN x.name END) AS sharedGenres
         ORDER BY score DESC, coalesce(o.audienceRating, o.rating, 0) DESC, o.title
         LIMIT $limit
         RETURN o, score, shared, sharedGenres`,
        { id: movieId, limit: lim, ...filterParams(filters) },
      );
      return res.records.map((r) => ({
        ...stripInternal(toNode(r.get('o'))),
        score: r.get('score'),
        shared: r.get('shared').slice(0, 6),
        sharedGenres: r.get('sharedGenres'),
      }));
    });
  }

  /** Values the filter controls can offer: the year range, content ratings and genres in the library. */
  async facets() {
    return this.#read(async (tx) => {
      const years = await tx.run(
        `MATCH (m:Movie)
         RETURN min(m.year) AS minYear, max(m.year) AS maxYear,
                [r IN collect(DISTINCT m.contentRating) WHERE r <> ''] AS contentRatings,
                sum(CASE WHEN m.genres IS NULL THEN 1 ELSE 0 END) AS missingGenres`,
      );
      const genres = await tx.run(
        `MATCH (g:Genre)<-[:IN_GENRE]-(:Movie)
         RETURN g.name AS name, count(*) AS c ORDER BY c DESC, name`,
      );
      const y = years.records[0];
      return {
        minYear: y?.get('minYear') ?? null,
        maxYear: y?.get('maxYear') ?? null,
        contentRatings: (y?.get('contentRatings') ?? []).sort(),
        genres: genres.records.map((r) => ({ name: r.get('name'), count: r.get('c') })),
        // Movies imported before v0.3 lack the genres list the graph's genre filter needs.
        needsReimport: (y?.get('missingGenres') ?? 0) > 0,
      };
    });
  }

  /** Genre map: genres sized by movie count, linked by how many movies they share. */
  async overview(maxGenres = 30, filters = normalizeFilters()) {
    const lim = neo4j.int(clamp(maxGenres, 2, 60, 30));
    const fp = filterParams(filters);
    return this.#read(async (tx) => {
      const genres = await tx.run(
        `MATCH (g:Genre)<-[:IN_GENRE]-(m:Movie)
         WHERE ${movieFilter('m')}
         WITH g, count(m) AS c ORDER BY c DESC, g.name LIMIT $lim
         RETURN g.name AS name, c`,
        { lim, ...fp },
      );
      const names = genres.records.map((r) => r.get('name'));
      const pairs = await tx.run(
        `MATCH (a:Genre)<-[:IN_GENRE]-(m:Movie)-[:IN_GENRE]->(b:Genre)
         WHERE a.name < b.name AND a.name IN $names AND b.name IN $names AND ${movieFilter('m')}
         RETURN a.name AS a, b.name AS b, count(m) AS weight`,
        { names, ...fp },
      );
      return {
        nodes: genres.records.map((r) => ({
          id: `Genre:${r.get('name')}`,
          label: 'Genre',
          name: r.get('name'),
          count: r.get('c'),
          props: {},
        })),
        edges: pairs.records.map((r) => ({
          source: `Genre:${r.get('a')}`,
          target: `Genre:${r.get('b')}`,
          type: 'SHARES_MOVIES',
          weight: r.get('weight'),
        })),
      };
    });
  }

  /** Shortest chain of people and movies linking two of them (through cast and crew only). */
  async path(from, to) {
    for (const end of [from, to]) {
      if (end.label !== 'Movie' && end.label !== 'Person') throw badRequest('Connections are between people and movies');
    }
    return this.#read(async (tx) => {
      const res = await tx.run(
        `MATCH (a:${from.label} {${KEY_PROP[from.label]}: $a}), (b:${to.label} {${KEY_PROP[to.label]}: $b})
         WHERE a <> b
         MATCH p = shortestPath((a)-[:${PATH_RELS}*..10]-(b))
         RETURN p LIMIT 1`,
        { a: from.key, b: to.key },
      );
      if (res.records.length === 0) return null;
      const p = res.records[0].get('p');
      const byEid = new Map();
      const nodes = [];
      for (const seg of p.segments) {
        for (const n of [seg.start, seg.end]) {
          if (!byEid.has(n.elementId)) {
            const node = toNode(n);
            byEid.set(n.elementId, node.id);
            nodes.push(stripInternal(node));
          }
        }
      }
      const edges = p.segments.map((seg) => toEdge(seg.relationship, byEid));
      return { nodes, edges };
    });
  }

  async posterPath(movieId) {
    return (await this.imageSource('Movie', movieId))?.plex ?? null;
  }

  /**
   * Where a node's picture comes from: { plex: '/library/...' } or { web: 'https://...' }.
   * The browser only ever sends a label and key; the location itself never leaves the server.
   */
  async imageSource(label, key) {
    assertLabel(label);
    if (!IMAGE_PROP[label]) return null;
    const props = await this.#read(async (tx) => {
      const res = await tx.run(
        `MATCH (n:${label} {${KEY_PROP[label]}: $key}) RETURN n {.thumb, .logo, .tmdbPoster} AS p`,
        { key: String(key) },
      );
      return res.records[0]?.get('p') ?? null;
    });
    return props ? imageOf(label, props) : null;
  }

  /** Movies with a TMDB id and no collection that haven't been looked up lately. */
  async moviesNeedingFranchise() {
    return this.#read(async (tx) => {
      const res = await tx.run(
        `MATCH (m:Movie) WHERE m.pg = true AND m.tmdbId IS NOT NULL AND NOT (m)-[:PART_OF]->()
           AND (m.franchiseChecked IS NULL OR m.franchiseChecked < timestamp() - $maxAge)
         RETURN m.id AS id, m.tmdbId AS tmdbId ORDER BY id`,
        { maxAge: neo4j.int(FRANCHISE_RECHECK_MS) },
      );
      return res.records.map((r) => ({ id: r.get('id'), tmdbId: String(r.get('tmdbId')) }));
    });
  }

  /**
   * Saves TMDB franchise lookups and links each movie to its franchise as a Collection (unless
   * Plex has meanwhile put it in a collection of its own).
   * @param {{id:string, name:string|null, poster:string|null}[]} list
   */
  async setFranchises(list) {
    if (list.length === 0) return;
    await this.#write((tx) =>
      tx.run(
        `UNWIND $list AS f
         MATCH (m:Movie {id: f.id}) WHERE m.pg = true
         SET m.franchise = f.name, m.franchiseChecked = timestamp()
         WITH m, f WHERE f.name IS NOT NULL AND NOT (m)-[:PART_OF]->()
         MERGE (x:Collection {name: f.name})
         SET x.pg = true, x.search = toLower(f.name), x.tmdbPoster = coalesce(x.tmdbPoster, f.poster)
         MERGE (m)-[:PART_OF]->(x)`,
        { list },
      ),
    );
  }

  /** Collection posters, matched by name to collections that already have movies in the graph. */
  async setCollectionPosters(list) {
    if (list.length === 0) return 0;
    return this.#write(async (tx) => {
      const res = await tx.run(
        `UNWIND $list AS c MATCH (x:Collection {name: c.name}) WHERE x.pg = true
         SET x.thumb = c.thumb RETURN count(x) AS n`,
        { list },
      );
      return res.records[0]?.get('n') ?? 0;
    });
  }

  /** Studios that have never been looked up for a logo. */
  async studiosNeedingLogos() {
    return this.#read(async (tx) => {
      const res = await tx.run('MATCH (s:Studio) WHERE s.pg = true AND s.logoChecked IS NULL RETURN s.name AS name ORDER BY name');
      return res.records.map((r) => r.get('name'));
    });
  }

  /** @param {{name:string, logo:string|null}[]} list */
  async setStudioLogos(list) {
    if (list.length === 0) return;
    await this.#write((tx) =>
      tx.run(
        `UNWIND $list AS l MATCH (s:Studio {name: l.name}) WHERE s.pg = true
         SET s.logo = l.logo, s.logoChecked = timestamp()`,
        { list },
      ),
    );
  }
}
