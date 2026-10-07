// SPDX-License-Identifier: GPL-3.0-or-later
// Cinestellar explorer. No build step; force-graph is served from /vendor.
// All text from Plex is inserted with textContent / createElement, never innerHTML,
// except tooltips (force-graph requires HTML strings) which are escaped with esc().

const TYPES = [
  { label: 'Movie', series: 1, shape: 'circle' },
  { label: 'Person', series: 2, shape: 'diamond' },
  { label: 'Genre', series: 3, shape: 'square' },
  { label: 'Country', series: 4, shape: 'triangle' },
  { label: 'Collection', series: 5, shape: 'hexagon' },
  { label: 'Studio', series: 6, shape: 'pentagon' },
];
const TYPE = Object.fromEntries(TYPES.map((t) => [t.label, t]));

// How a relationship reads from each side. [as seen from the movie, as seen from the other node]
const REL = {
  ACTED_IN: ['Cast', 'Acted in'],
  DIRECTED: ['Director', 'Directed'],
  WROTE: ['Writer', 'Wrote'],
  PRODUCED: ['Producers', 'Produced'],
  IN_GENRE: ['Genres', 'Movies'],
  PRODUCED_IN: ['Countries', 'Movies'],
  PART_OF: ['Collections', 'Movies'],
  MADE_BY: ['Studios', 'Movies'],
  SHARES_MOVIES: ['Shares movies with', 'Shares movies with'],
  SIMILAR_TO: ['More like this', 'More like this'],
};

// ---- small helpers ----------------------------------------------------------

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n) => Number(n ?? 0).toLocaleString();

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null) e.append(kid);
  return e;
}

// The busy bar shows while graph data is loading or the layout is still moving.
const busy = { requests: 0, layout: false };
function updateBusy() {
  const on = busy.requests > 0 || busy.layout;
  const bar = document.getElementById('busy');
  if (bar) bar.hidden = !on;
  document.getElementById('graph')?.setAttribute('aria-busy', String(on));
}

async function api(path, opts = {}) {
  const tracked = path.startsWith('/api/graph/');
  if (tracked) {
    busy.requests++;
    updateBusy();
  }
  try {
    return await apiRequest(path, opts);
  } finally {
    if (tracked) {
      busy.requests--;
      updateBusy();
    }
  }
}

async function apiRequest(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON error */
  }
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data;
}

const keyOf = (id, label) => id.slice(label.length + 1);
const debounce = (fn, ms) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};

// ---- node shapes (shared by canvas and legend so they always match) ----------

function polygon(sides, rotation) {
  return Array.from({ length: sides }, (_, i) => {
    const a = rotation + (i * 2 * Math.PI) / sides;
    return [Math.cos(a), Math.sin(a)];
  });
}
const SHAPE_POINTS = {
  diamond: polygon(4, -Math.PI / 2),
  square: polygon(4, -Math.PI / 4).map(([x, y]) => [x * 0.9, y * 0.9]),
  triangle: polygon(3, -Math.PI / 2),
  hexagon: polygon(6, 0),
  pentagon: polygon(5, -Math.PI / 2),
};

function drawShape(ctx, shape, x, y, r) {
  ctx.beginPath();
  if (shape === 'circle') {
    ctx.arc(x, y, r, 0, 2 * Math.PI);
  } else {
    SHAPE_POINTS[shape].forEach(([px, py], i) => {
      if (i === 0) ctx.moveTo(x + px * r, y + py * r);
      else ctx.lineTo(x + px * r, y + py * r);
    });
    ctx.closePath();
  }
}

function shapeSvg(type) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '-8 -8 16 16');
  svg.setAttribute('class', 'swatch');
  svg.setAttribute('aria-hidden', 'true');
  let node;
  if (type.shape === 'circle') {
    node = document.createElementNS(ns, 'circle');
    node.setAttribute('r', '7');
  } else {
    node = document.createElementNS(ns, 'polygon');
    node.setAttribute('points', SHAPE_POINTS[type.shape].map(([x, y]) => `${(x * 7).toFixed(2)},${(y * 7).toFixed(2)}`).join(' '));
  }
  node.setAttribute('fill', `var(--series-${type.series})`);
  svg.append(node);
  return svg;
}

// ---- graph state --------------------------------------------------------------

const state = {
  nodes: new Map(),
  links: [],
  linkKeys: new Set(),
  adj: new Map(),
  hidden: new Set(),
  selected: null,
  hover: null,
  hoverSet: null,
  pathEdges: new Set(),
  showPosters: true,
  history: [], // where "Back" goes: overview | focus | picks | path entries
  view: null, // what the view bar describes (see setView)
  picks: [], // combined picks: movies matching ALL of these are shown
  results: null, // last picks result, for the side panel list
  mode: 'graph', // 'graph' | 'timeline'
  timeline: null, // { data, minDecade, nodes } while the timeline is showing
  unfolding: false,
  filters: { yearFrom: null, yearTo: null, minRating: null, genres: new Set(), contentRatings: new Set() },
};

let colors = {};
function refreshColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  colors = {
    surface: v('--surface-1'),
    band: v('--surface-2'),
    border: v('--border'),
    text: v('--text-primary'),
    muted: v('--text-muted'),
    edge: v('--edge'),
    edgeHi: v('--edge-hi'),
    series: Object.fromEntries(TYPES.map((t) => [t.label, v(`--series-${t.series}`)])),
  };
}
refreshColors();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  refreshColors();
  requestRedraw();
});

// force-graph stops repainting once the layout settles. Anything that changes the picture
// without changing the data (a poster finished loading, filters, theme) asks for one repaint.
let redrawQueued = false;
function requestRedraw() {
  if (redrawQueued || typeof Graph === 'undefined') return;
  redrawQueued = true;
  Graph.autoPauseRedraw(false);
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      Graph.autoPauseRedraw(true);
      redrawQueued = false;
    }),
  );
}

const endId = (end) => (typeof end === 'object' ? end.id : end);
const linkKey = (l) => `${endId(l.source)}|${endId(l.target)}|${l.type}`;

function rebuildAdjacency() {
  state.adj = new Map();
  for (const l of state.links) {
    const a = endId(l.source);
    const b = endId(l.target);
    if (!state.adj.has(a)) state.adj.set(a, new Set());
    if (!state.adj.has(b)) state.adj.set(b, new Set());
    state.adj.get(a).add(b);
    state.adj.get(b).add(a);
  }
  for (const n of state.nodes.values()) {
    const degree = state.adj.get(n.id)?.size ?? 0;
    const size = n.count ?? n.total ?? degree;
    n.r = n.label === 'Movie' ? 5 : Math.min(18, 4 + Math.sqrt(size) * 0.9);
  }
}

// ---- filters ------------------------------------------------------------------------

function filtersActive() {
  const f = state.filters;
  return f.yearFrom != null || f.yearTo != null || f.minRating != null || f.genres.size > 0 || f.contentRatings.size > 0;
}

/** Query-string form of the filters, appended to expand / similar requests. */
function filterParams() {
  const f = state.filters;
  const q = {};
  if (f.yearFrom != null) q.yearFrom = f.yearFrom;
  if (f.yearTo != null) q.yearTo = f.yearTo;
  if (f.minRating != null) q.minRating = f.minRating;
  if (f.genres.size) q.genres = [...f.genres].join(',');
  if (f.contentRatings.size) q.contentRatings = [...f.contentRatings].join(',');
  return q;
}

function passesFilters(n) {
  if (n.label !== 'Movie') return true;
  const f = state.filters;
  const p = n.props ?? {};
  if (f.yearFrom != null && !(p.year >= f.yearFrom)) return false;
  if (f.yearTo != null && !(p.year <= f.yearTo)) return false;
  if (f.minRating != null && !((p.audienceRating ?? p.rating ?? 0) >= f.minRating)) return false;
  if (f.contentRatings.size && !f.contentRatings.has(p.contentRating)) return false;
  // Movies imported before genres were stored on them can't be checked here; keep them visible.
  if (f.genres.size && Array.isArray(p.genres) && !p.genres.some((g) => f.genres.has(g))) return false;
  return true;
}

// A hidden type still shows what you picked or selected yourself, and the genre map (which is
// nothing but genres) always shows genres.
const typeShown = (n) =>
  !state.hidden.has(n.label) || n.isPick || n === state.selected || (n.label === 'Genre' && state.viewing?.kind === 'overview');
const nodeVisible = (n) => typeShown(n) && (n === state.selected || passesFilters(n));

/**
 * What the layout works with. Hidden types are left out entirely (not just drawn invisibly), so
 * switching off genre or country links also stops those hubs from pulling movies together.
 */
function layoutData() {
  if (state.hidden.size === 0) return { nodes: [...state.nodes.values()], links: state.links };
  const nodes = [...state.nodes.values()].filter(typeShown);
  const ids = new Set(nodes.map((n) => n.id));
  return { nodes, links: state.links.filter((l) => ids.has(endId(l.source)) && ids.has(endId(l.target))) };
}
const linkVisible = (l) => typeof l.source === 'object' && typeof l.target === 'object' && nodeVisible(l.source) && nodeVisible(l.target);

function applyVisibility() {
  // New function identities make force-graph re-evaluate visibility.
  Graph.nodeVisibility((n) => nodeVisible(n)).linkVisibility((l) => linkVisible(l));
  requestRedraw();
}

// ---- rendering --------------------------------------------------------------------
//
// Nodes are drawn by force-graph one at a time; labels are collected while drawing and placed
// afterwards in priority order, skipping any that would overlap one already placed.

// Pictures: box art for movies and collections, faces for people, logos for studios. The coloured
// shapes from the legend are the fallback while zoomed out, while a picture loads, or when there
// is none.
const PICTURE_MIN_SCALE = 0.6; // below this a picture would be a few pixels wide
const frame = { labels: [], boxes: [], bounds: null };
const pictureCache = new Map(); // node id -> { img, ok, failed }
const textWidth = new Map(); // label text -> width in CSS px at 12px

function inView(n, pad = 20) {
  const b = frame.bounds;
  return !b || (n.x > b.x0 - pad && n.x < b.x1 + pad && n.y > b.y0 - pad && n.y < b.y1 + pad);
}

const hasPicture = (n) => Boolean(n.props?.hasImage ?? n.props?.hasPoster);

/** Size and style of a node's picture, in graph units. */
function pictureBox(n) {
  switch (n.label) {
    case 'Movie': return { w: 12, h: 18, shape: 'poster' };
    case 'Collection': return { w: 13, h: 19, shape: 'stack' };
    case 'Person': {
      const d = Math.max(14, 2 * (n.r ?? 5) + 4);
      return { w: d, h: d, shape: 'round' };
    }
    case 'Studio': {
      const w = Math.max(26, 2.8 * (n.r ?? 5));
      return { w, h: w * 0.5, shape: 'chip' };
    }
    default: return null;
  }
}

/** How much room a node takes, for the collision force. */
function nodeRadius(n) {
  const box = state.showPosters && hasPicture(n) ? pictureBox(n) : null;
  return box ? Math.max(box.w, box.h) / 2 : (n.r ?? 5);
}

/** A small picture for lists (search, browse), or the legend shape when there is none. */
function listIcon(it) {
  if (!state.showPosters || !hasPicture(it) || !pictureBox(it)) return shapeSvg(TYPE[it.label]);
  return el('img', {
    class: `thumb thumb-${it.label}`,
    src: pictureUrl({ label: it.label, key: it.key ?? keyOf(it.id, it.label) }),
    alt: '',
    loading: 'lazy',
    onerror: (e) => e.target.replaceWith(shapeSvg(TYPE[it.label])),
  });
}

const pictureUrl = (n) => `/api/image?label=${encodeURIComponent(n.label)}&key=${encodeURIComponent(n.key)}&size=small`;

// Pictures drawn in the current frame are never evicted, so a graph with more pictures than this
// just lets the cache grow instead of reloading them every frame.
const PICTURE_CACHE_MAX = 600;
let pictureFrame = 0;
function pictureFor(n) {
  let p = pictureCache.get(n.id);
  if (p?.failed && Date.now() - p.failed > 60000) {
    pictureCache.delete(n.id); // try a failed picture again after a minute
    p = null;
  }
  if (p) {
    // Keep recently drawn pictures at the end so the oldest are dropped first.
    pictureCache.delete(n.id);
    pictureCache.set(n.id, p);
  } else {
    if (pictureCache.size >= PICTURE_CACHE_MAX) {
      const [oldId, old] = pictureCache.entries().next().value;
      if (old.frame !== pictureFrame) pictureCache.delete(oldId);
    }
    const img = new Image();
    p = { img, ok: false, failed: false, frame: pictureFrame };
    img.onload = () => {
      p.ok = true;
      requestRedraw();
    };
    img.onerror = () => {
      p.failed = Date.now();
    };
    img.src = pictureUrl(n);
    pictureCache.set(n.id, p);
  }
  p.frame = pictureFrame;
  return p.ok ? p.img : null;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Draws img to fill (cover) or fit inside (contain) the box; `top` biases a crop towards the top. */
function drawImageIn(ctx, img, x, y, w, h, { fit = 'cover', top = 0.5 } = {}) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (!iw || !ih) return;
  if (fit === 'contain') {
    const k = Math.min(w / iw, h / ih);
    const dw = iw * k;
    const dh = ih * k;
    ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    return;
  }
  const k = Math.max(w / iw, h / ih);
  const sw = w / k;
  const sh = h / k;
  ctx.drawImage(img, (iw - sw) / 2, (ih - sh) * top, sw, sh, x, y, w, h);
}

function drawPicture(ctx, n, img, box, scale, selected) {
  const { w, h, shape } = box;
  const x = n.x - w / 2;
  const y = n.y - h / 2;
  const ring = selected ? colors.text : colors.series[n.label];
  const lw = (selected ? 2.5 : 1.5) / scale;
  ctx.save();
  if (shape === 'round') {
    ctx.beginPath();
    ctx.arc(n.x, n.y, w / 2, 0, 2 * Math.PI);
    ctx.fillStyle = colors.surface;
    ctx.fill();
    ctx.clip();
    drawImageIn(ctx, img, x, y, w, h, { top: 0.2 }); // faces sit near the top of a headshot
    ctx.restore();
    ctx.beginPath();
    ctx.arc(n.x, n.y, w / 2, 0, 2 * Math.PI);
  } else if (shape === 'chip') {
    // Logos are made for light backgrounds, so they always sit on white.
    roundRect(ctx, x, y, w, h, 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.clip();
    const pad = Math.min(w, h) * 0.12;
    drawImageIn(ctx, img, x + pad, y + pad, w - 2 * pad, h - 2 * pad, { fit: 'contain' });
    ctx.restore();
    roundRect(ctx, x, y, w, h, 2);
  } else {
    if (shape === 'stack') {
      // A second card peeking out behind marks a collection.
      roundRect(ctx, x + 2, y - 2, w, h, 1.2);
      ctx.fillStyle = colors.series.Collection;
      ctx.fill();
    }
    roundRect(ctx, x, y, w, h, 1.2);
    ctx.clip();
    drawImageIn(ctx, img, x, y, w, h);
    ctx.restore();
    roundRect(ctx, x, y, w, h, 1.2);
  }
  ctx.lineWidth = lw;
  ctx.strokeStyle = ring;
  ctx.stroke();
  n.__img = { x, y, w, h, round: shape === 'round' };
}

function labelPriority(n) {
  if (state.selected?.id === n.id) return 0;
  if (state.hover?.id === n.id) return 1;
  if (state.hoverSet?.has(n.id)) return 2;
  if (state.pathNodes?.has(n.id)) return 3;
  return n.label === 'Movie' ? 5 : 4;
}

function drawNode(n, ctx, scale) {
  const type = TYPE[n.label];
  const dim = state.hoverSet && !state.hoverSet.has(n.id);
  const selected = state.selected?.id === n.id;
  ctx.globalAlpha = dim ? 0.18 : 1;
  n.__img = null;

  const box = state.showPosters && hasPicture(n) && scale >= PICTURE_MIN_SCALE && inView(n) ? pictureBox(n) : null;
  const img = box ? pictureFor(n) : null;
  let halfW = n.r ?? 5;
  let halfH = n.r ?? 5;
  if (img) {
    drawPicture(ctx, n, img, box, scale, selected);
    halfW = box.w / 2;
    halfH = box.h / 2;
  } else {
    const r = n.r ?? 5;
    drawShape(ctx, type.shape, n.x, n.y, r);
    ctx.fillStyle = colors.series[n.label];
    ctx.fill();
    ctx.lineWidth = 2 / scale; // surface ring keeps overlapping marks separable
    ctx.strokeStyle = colors.surface;
    ctx.stroke();
    if (selected) {
      drawShape(ctx, type.shape, n.x, n.y, r + 3 / scale);
      ctx.lineWidth = 2 / scale;
      ctx.strokeStyle = colors.text;
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;

  if (dim || !inView(n)) return;
  // Labels must not cover other nodes either.
  frame.boxes.push({ x0: n.x - halfW, x1: n.x + halfW, y0: n.y - halfH, y1: n.y + halfH, id: n.id });
  const cls = labelPriority(n);
  const few = state.nodes.size <= 40;
  // People shown as faces get their name underneath as soon as the face is visible.
  const face = img && n.label === 'Person';
  const wanted = cls <= 3 || few || face || (cls === 4 && scale >= 0.5) || (cls === 5 && scale >= 1.1);
  if (wanted) frame.labels.push({ n, cls, halfH });
}

// ---- plain-English links ----------------------------------------------------------

const article = (word) => (/^[aeiou]/i.test(word) ? 'an' : 'a');
const endNode = (end) => (typeof end === 'object' ? end : state.nodes.get(end));
const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many}`;

/** A full sentence for a link, shown when you point at it. */
function linkSentence(l) {
  const a = endNode(l.source)?.name ?? '';
  const b = endNode(l.target)?.name ?? '';
  switch (l.type) {
    case 'ACTED_IN': return `${a} acted in ${b}${l.role ? ` as ${l.role}` : ''}`;
    case 'DIRECTED': return `${a} directed ${b}`;
    case 'WROTE': return `${a} wrote ${b}`;
    case 'PRODUCED': return `${a} produced ${b}`;
    case 'IN_GENRE': return `${a} is ${article(b)} ${b} movie`;
    // Plex's country is where a film was produced, not necessarily where it was shot.
    case 'PRODUCED_IN': return `${a} was made in ${b}`;
    case 'PART_OF': return `${a} is part of ${b}`;
    case 'MADE_BY': return `${a} is a ${b} film`;
    case 'SHARES_MOVIES': return `${plural(l.weight ?? 0, 'movie is', 'movies are')} both ${a} and ${b}`;
    case 'SIMILAR_TO': return `${b} is a lot like ${a}${l.reason ? `: ${l.reason.charAt(0).toLowerCase()}${l.reason.slice(1)}` : ''}`;
    default: return `${a} – ${b}`;
  }
}

/** A few words drawn on the line itself, read from the end you're looking at. */
function linkPhrase(l, fromId) {
  const fromMovie = endNode(fromId)?.label === 'Movie';
  const other = endNode(endId(l.source) === fromId ? l.target : l.source)?.name ?? '';
  switch (l.type) {
    case 'ACTED_IN': return fromMovie ? (l.role ? `as ${l.role}` : 'cast') : l.role ? `played ${l.role}` : 'acted in';
    case 'DIRECTED': return fromMovie ? 'directed it' : 'directed';
    case 'WROTE': return fromMovie ? 'wrote it' : 'wrote';
    case 'PRODUCED': return fromMovie ? 'produced it' : 'produced';
    case 'IN_GENRE': return fromMovie ? 'genre' : `${article(endNode(l.target)?.name ?? '')} ${endNode(l.target)?.name ?? ''} movie`;
    case 'PRODUCED_IN': return fromMovie ? `made in ${other}` : 'made here';
    case 'PART_OF': return fromMovie ? 'in this collection' : 'part of it';
    case 'MADE_BY': return fromMovie ? 'studio' : 'their film';
    case 'SHARES_MOVIES': return `${plural(l.weight ?? 0, 'movie', 'movies')} in both`;
    case 'SIMILAR_TO': return 'similar';
    default: return '';
  }
}

function drawLabels(ctx, scale) {
  const placed = [];
  const fontPx = 12;
  const nodeBoxes = frame.boxes;
  const lineH = 15 / scale;
  const gap = 2 / scale;
  const hit = (b, p) => b.x0 < p.x1 && b.x1 > p.x0 && b.y0 < p.y1 && b.y1 > p.y0;
  const overlaps = (b, selfId) => placed.some((p) => hit(b, p)) || nodeBoxes.some((p) => p.id !== selfId && hit(b, p));

  frame.labels.sort((a, b) => a.cls - b.cls || (b.n.r ?? 5) - (a.n.r ?? 5));
  ctx.font = `${fontPx / scale}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.lineJoin = 'round';
  for (const { n, cls, halfH } of frame.labels) {
    const text = n.name.length > 28 ? `${n.name.slice(0, 27)}…` : n.name;
    if (!textWidth.has(text)) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.font = `${fontPx}px system-ui, sans-serif`;
      textWidth.set(text, ctx.measureText(text).width);
      ctx.restore();
    }
    const w = textWidth.get(text) / scale;
    // Try below the node, then above it.
    const spots = [n.y + halfH + gap, n.y - halfH - gap - lineH];
    let top = null;
    for (const y of spots) {
      const box = { x0: n.x - w / 2 - gap, x1: n.x + w / 2 + gap, y0: y, y1: y + lineH };
      if (cls <= 1 || !overlaps(box, n.id)) {
        placed.push(box);
        top = y;
        break;
      }
    }
    if (top == null) continue;
    ctx.lineWidth = 3 / scale;
    ctx.strokeStyle = colors.surface;
    ctx.strokeText(text, n.x, top);
    ctx.fillStyle = colors.text;
    ctx.fillText(text, n.x, top);
  }

  // Short phrases on the lines of whatever you're pointing at or have selected (graph only).
  const focus = state.hover ?? state.selected;
  if (state.mode !== 'graph' || !focus || scale < 0.7) return;
  const lines = state.links.filter((l) => {
    const a = endNode(l.source);
    const b = endNode(l.target);
    return (a?.id === focus.id || b?.id === focus.id) && a && b && nodeVisible(a) && nodeVisible(b) && (inView(a) || inView(b));
  });
  if (lines.length > 60) return; // too many to read; the tooltip still explains each line
  const small = 10 / scale;
  ctx.font = `${small}px system-ui, sans-serif`;
  for (const l of lines) {
    const a = endNode(l.source);
    const b = endNode(l.target);
    const text = linkPhrase(l, focus.id);
    if (!text) continue;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const w = ctx.measureText(text).width;
    const box = { x0: mx - w / 2 - gap, x1: mx + w / 2 + gap, y0: my - small / 2 - gap, y1: my + small / 2 + gap };
    if (overlaps(box, null)) continue;
    placed.push(box);
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3 / scale;
    ctx.strokeStyle = colors.surface;
    ctx.strokeText(text, mx, my);
    ctx.fillStyle = colors.muted;
    ctx.fillText(text, mx, my);
  }
}

/** Keeps nodes from sitting on top of each other (force-graph ships no collision force). */
function collideForce(padding = 4) {
  let nodes = [];
  function force(alpha) {
    if (nodes.length > 1500) return; // quadratic; skip on huge canvases
    const strength = 0.7;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const min = nodeRadius(a) + nodeRadius(b) + padding;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 >= min * min) continue;
        if (d2 === 0) {
          dx = Math.random() - 0.5;
          dy = Math.random() - 0.5;
          d2 = dx * dx + dy * dy;
        }
        const d = Math.sqrt(d2);
        const push = ((min - d) / d) * strength * Math.min(1, alpha * 8) * 0.5;
        a.vx -= dx * push;
        a.vy -= dy * push;
        b.vx += dx * push;
        b.vy += dy * push;
      }
    }
  }
  force.initialize = (n) => {
    nodes = n;
  };
  return force;
}

const Graph = ForceGraph()($('graph'))
  .nodeId('id')
  .backgroundColor('rgba(0,0,0,0)')
  .nodeVisibility(nodeVisible)
  .linkVisibility(linkVisible)
  .nodeCanvasObject(drawNode)
  .nodePointerAreaPaint((n, color, ctx) => {
    ctx.fillStyle = color;
    const p = n.__img;
    if (p && !p.round) {
      ctx.fillRect(p.x - 1, p.y - 1, p.w + 2, p.h + 2);
      return;
    }
    ctx.beginPath();
    ctx.arc(n.x, n.y, (p ? p.w / 2 : (n.r ?? 5)) + 3, 0, 2 * Math.PI);
    ctx.fill();
  })
  .onRenderFramePre((ctx, scale) => {
    pictureFrame += 1;
    if (state.mode === 'timeline') drawTimelineBackground(ctx, scale);
    const t = ctx.getTransform();
    frame.labels = [];
    frame.boxes = [];
    frame.bounds = {
      x0: -t.e / t.a,
      y0: -t.f / t.d,
      x1: (ctx.canvas.width - t.e) / t.a,
      y1: (ctx.canvas.height - t.f) / t.d,
    };
  })
  .onRenderFramePost((ctx, scale) => drawLabels(ctx, scale))
  .nodeLabel((n) => `<b>${esc(n.name)}</b><br><span style="opacity:.75">${esc(n.label)}${n.props?.year ? ` · ${esc(n.props.year)}` : ''}</span>`)
  .linkLabel((l) => esc(linkSentence(l)))
  .linkColor((l) => (isHot(l) ? colors.edgeHi : l.type === 'SIMILAR_TO' ? colors.series.Movie : colors.edge))
  .linkLineDash((l) => (l.type === 'SIMILAR_TO' ? [4, 3] : null))
  .linkWidth((l) =>
    state.pathEdges.has(linkKey(l))
      ? 3.5
      : isHot(l)
        ? 2
        : l.type === 'SHARES_MOVIES'
          ? Math.min(7, 0.6 + Math.sqrt(l.weight ?? 1) / 3)
          : l.type === 'SIMILAR_TO'
            ? 1.5
            : 1,
  )
  .onNodeHover((n) => {
    state.hover = n || null;
    state.hoverSet = n && state.mode === 'graph' ? new Set([n.id, ...(state.adj.get(n.id) ?? [])]) : null;
    $('graph').style.cursor = n ? 'pointer' : 'default';
    requestRedraw(); // force-graph doesn't repaint on hover once the layout has settled
  })
  // In a picks view, clicking a pick shows its details without pulling in all its other movies.
  .onNodeClick((n) => selectNode(n, { expand: state.mode === 'graph' && !(state.view?.kind === 'picks' && n.isPick) }))
  .onBackgroundClick(() => selectNode(null))
  .cooldownTicks(200);

// Fit the view once the layout has settled (fitting earlier zooms in on a still-collapsed cluster).
let fitOnSettle = false;
let centerOnSettle = null; // a node to keep in view while newly added neighbours push it around
const fitSoon = () => {
  fitOnSettle = true;
  centerOnSettle = null;
};
Graph.onEngineStop(() => {
  busy.layout = false;
  updateBusy();
  if (state.mode !== 'graph') return; // keep any pending fit for when the graph is shown again
  if (fitOnSettle) {
    fitOnSettle = false;
    Graph.zoomToFit(400, 70);
  } else if (centerOnSettle) {
    const n = centerOnSettle;
    centerOnSettle = null;
    if (n.x != null && state.nodes.has(n.id)) Graph.centerAt(n.x, n.y, 400);
  }
});

/** A gentle pull toward the middle so separate groups don't drift far apart. */
function gravityForce(strength = 0.04) {
  let nodes = [];
  function force(alpha) {
    for (const n of nodes) {
      n.vx -= n.x * strength * alpha;
      n.vy -= n.y * strength * alpha;
    }
  }
  force.initialize = (n) => {
    nodes = n;
  };
  return force;
}

const degree = (end) => state.adj.get(endId(end))?.size ?? 1;

// Nodes only push each other away within a limited range, so two busy groups that share a
// link don't fly apart and stretch that link across the screen.
Graph.d3Force('charge').strength(-110).distanceMax(240);
Graph.d3Force('link')
  .distance((l) => (l.type === 'SHARES_MOVIES' ? 130 / (1 + Math.log(l.weight ?? 1)) : l.type === 'SIMILAR_TO' ? 80 : 50))
  // d3's default makes a link between two busy nodes almost slack; keep a floor so it holds.
  .strength((l) => Math.max(0.3, 1 / Math.min(degree(l.source), degree(l.target))));
Graph.d3Force('collide', collideForce());
Graph.d3Force('gravity', gravityForce());

function isHot(l) {
  if (state.pathEdges.has(linkKey(l))) return true;
  const h = state.hover;
  return Boolean(h) && (endId(l.source) === h.id || endId(l.target) === h.id);
}

function resize() {
  const box = $('graph');
  Graph.width(box.clientWidth).height(box.clientHeight);
}
new ResizeObserver(resize).observe($('graph'));
resize();

function updateGraph() {
  rebuildAdjacency();
  if (state.mode === 'timeline') return; // the graph keeps updating underneath; shown when you switch back
  busy.layout = state.nodes.size > 0;
  updateBusy();
  Graph.graphData(layoutData());
  $('empty').hidden = state.nodes.size > 0;
}

function clearGraph() {
  state.nodes = new Map();
  state.links = [];
  state.linkKeys = new Set();
  state.pathEdges = new Set();
  state.pathNodes = null;
  state.selected = null;
  state.hover = null;
  state.hoverSet = null;
  $('path-chain').replaceChildren();
  state.viewing = null;
  closeDetail();
  updateGraph();
  if ($('btn-back')) updateBackButton();
}

/** Merge API nodes/edges into the canvas, spawning new nodes next to `near`. */
function addData({ nodes = [], edges = [] }, near) {
  for (const n of nodes) {
    const existing = state.nodes.get(n.id);
    if (existing) {
      Object.assign(existing, { count: n.count ?? existing.count, props: { ...existing.props, ...n.props } });
      continue;
    }
    const node = { ...n, key: keyOf(n.id, n.label), props: n.props ?? {} };
    if (near && near.x != null) {
      node.x = near.x + (Math.random() - 0.5) * 30;
      node.y = near.y + (Math.random() - 0.5) * 30;
    }
    state.nodes.set(node.id, node);
  }
  for (const e of edges) {
    if (!state.nodes.has(e.source) || !state.nodes.has(e.target)) continue;
    const link = { source: e.source, target: e.target, type: e.type, role: e.role, weight: e.weight, order: e.order, reason: e.reason };
    const k = linkKey(link);
    if (state.linkKeys.has(k)) continue;
    state.linkKeys.add(k);
    state.links.push(link);
  }
  updateGraph();
  if (typeof updateFilterStatus === 'function') updateFilterStatus();
}

// ---- selecting / expanding ----------------------------------------------------

async function expandNode(node, limit = 60) {
  const mine = focusSeq;
  const q = new URLSearchParams({ label: node.label, key: node.key, limit, ...filterParams() });
  const data = await api(`/api/graph/expand?${q}`);
  if (mine !== focusSeq || state.nodes.get(node.id) !== node) return data; // the view changed meanwhile
  node.total = data.total;
  node.shown = data.shown;
  node.limit = limit;
  addData(data, node);
  if (state.view && !state.view.expanded) {
    state.view.expanded = true;
    renderViewBar();
  }
  return data;
}

async function selectNode(node, { expand = false, center = false } = {}) {
  if (state.mode === 'timeline') {
    expand = false; // the hidden graph isn't touched while the timeline is showing
    center = false;
  }
  state.selected = node;
  requestRedraw();
  if (center && node?.x != null) {
    Graph.centerAt(node.x, node.y, 500);
    centerOnSettle = node;
  }
  if (filtersActive()) applyVisibility(); // the selected node always stays visible
  if (!node) {
    if (state.results) renderResults();
    else closeDetail();
    return;
  }
  renderDetail(node);
  if (expand && node.limit == null) {
    try {
      await expandNode(node);
    } catch (err) {
      showBanner(err.message);
    }
    if (state.selected?.id === node.id) renderDetail(node);
  }
}

/** Replace the canvas with one node and its neighbours. */
let focusSeq = 0;
async function focusOn(label, key, { fromHistory = false, name } = {}) {
  setMode('graph'); // "around one movie" only makes sense as a graph
  const mine = ++focusSeq;
  const entry = fromHistory ? state.history.at(-1) : pushHistory({ kind: 'focus', label, key, name: name ?? key });
  clearGraph();
  state.viewing = entry;
  updateBackButton();
  setView({ kind: 'focus', label, key, name: entry?.name ?? name ?? '…', loading: true });
  try {
    const q = new URLSearchParams({ label, key, limit: 60, ...filterParams() });
    const data = await api(`/api/graph/expand?${q}`);
    if (mine !== focusSeq) return; // a newer focus request replaced this one
    if (!data.center) throw new Error('That item is no longer in the graph. Try re-importing.');
    setView({ kind: 'focus', label: data.center.label, key: keyOf(data.center.id, data.center.label), name: data.center.name });
    addData({ nodes: data.nodes, edges: data.edges });
    const node = state.nodes.get(data.center.id);
    node.total = data.total;
    node.shown = data.shown;
    node.limit = 60;
    selectNode(node);
    if (state.hidden.has(node.label) && state.mode === 'graph') Graph.graphData(layoutData()); // what you opened stays shown
    fitSoon();
  } catch (err) {
    if (mine !== focusSeq) return;
    setView({ kind: 'focus', label, key, name: entry?.name ?? key, error: err.message });
    showBanner(err.message);
  }
}

async function loadOverview({ fromHistory = false } = {}) {
  setMode('graph'); // the genre map is a graph of genres, not movies
  const mine = ++focusSeq;
  const entry = fromHistory ? state.history.at(-1) : pushHistory({ kind: 'overview' });
  clearGraph();
  state.viewing = entry;
  updateBackButton();
  try {
    setView({ kind: 'overview' });
    const data = await api(`/api/graph/overview?${new URLSearchParams(filterParams())}`);
    if (mine !== focusSeq) return; // something newer replaced the canvas meanwhile
    addData(data);
    fitSoon();
  } catch (err) {
    showBanner(err.message);
  }
}

// ---- what's on screen: view bar and combined picks ------------------------------------

// A pick can be limited to one role: "directed by", "starring", "written by", "produced by".
const ROLE_LABEL = { ACTED_IN: 'cast', DIRECTED: 'director', WROTE: 'screenplay', PRODUCED: 'producer' };
const pickOf = (it) => ({ label: it.label, key: it.key ?? keyOf(it.id, it.label), name: it.name, ...(it.role ? { role: it.role } : {}) });
const samePick = (a, b) => a.label === b.label && a.key === b.key && (a.role ?? null) === (b.role ?? null);
const pickParam = (picks) => JSON.stringify(picks.map(({ label, key, role }) => (role ? { label, key, role } : { label, key })));
const pickName = (p) => (p.role ? `${p.name} (${ROLE_LABEL[p.role]})` : p.name);

/** Records what the graph shows, refreshes the bar at the top and the Browse list. */
function setView(view) {
  const before = JSON.stringify(state.picks);
  state.view = view;
  state.picks = view?.kind === 'picks' ? view.picks : [];
  if (view?.kind !== 'picks') state.results = null;
  renderViewBar();
  if (JSON.stringify(state.picks) !== before) loadBrowse(currentTab());
  if (state.mode === 'timeline' && !view?.loading) showTimelineSoon();
}

function pill(item, onRemove) {
  return el(
    'span',
    { class: 'pill' },
    shapeSvg(TYPE[item.label]),
    el('span', { class: 'pill-text', text: pickName(item), title: pickName(item) }),
    onRemove ? el('button', { type: 'button', 'aria-label': `Remove ${item.name}`, title: `Remove ${item.name}`, text: '×', onclick: onRemove }) : null,
  );
}

function filterPill(text, onRemove) {
  return el(
    'span',
    { class: 'pill filter' },
    el('span', { class: 'pill-text', text, title: text }),
    el('button', { type: 'button', 'aria-label': `Remove filter ${text}`, title: 'Remove this filter', text: '×', onclick: onRemove }),
  );
}

const PLURAL = { Movie: 'movies', Person: 'people', Genre: 'genres', Country: 'countries', Collection: 'collections', Studio: 'studios' };

function renderViewBar() {
  const v = state.view;
  const muted = (text) => el('span', { class: 'muted', text });
  const joiner = (text) => el('span', { class: 'joiner', text });
  let desc;
  if (!v) {
    desc = [muted('Nothing selected. Search, pick something under Browse, or open the Genre map.')];
  } else if (v.kind === 'overview') {
    desc = [el('span', { text: 'Genre map' }), muted('genres sized by number of movies, linked by the movies they share')];
  } else if (v.kind === 'picks') {
    desc = [el('span', { text: 'Movies with' })];
    v.picks.forEach((p, i) => {
      if (i > 0) desc.push(joiner('and'));
      desc.push(pill(p, () => removePick(i)));
    });
    desc.push(
      muted(
        v.error
          ? `couldn't load: ${v.error}`
          : v.loading
          ? 'loading…'
          : v.total === 0
            ? 'no movies match all of these. Remove one.'
            : v.shown < v.total
              ? `showing the ${fmt(v.shown)} best rated of ${fmt(v.total)}`
              : `${fmt(v.total)} movie${v.total === 1 ? '' : 's'}`,
      ),
    );
  } else if (v.kind === 'focus') {
    desc = [el('span', { text: 'Around' }), pill(v), muted(v.error ? `couldn't load: ${v.error}` : v.loading ? 'loading…' : 'and everything connected to it')];
  } else if (v.kind === 'path') {
    desc = [el('span', { text: 'Connection' }), pill(v.a), joiner('→'), pill(v.b), muted(`${v.steps} step${v.steps === 1 ? '' : 's'}`)];
    if (filtersActive()) desc.push(muted('(filters don\'t apply to connections)'));
  }
  if (v?.expanded && state.mode === 'graph') desc.push(muted('+ what you opened'));
  if (state.unfolding) desc.push(muted(`unfolding… ${fmt(state.nodes.size)} on the graph`));
  if (state.mode === 'timeline') {
    const t = state.timeline?.data;
    const scope = state.picks.length ? [] : [el('span', { text: 'your whole library' })];
    const count = !t
      ? 'loading…'
      : t.movies.length < t.total
        ? `the ${fmt(t.movies.length)} best rated of ${fmt(t.total)} movies, by release year`
        : `${fmt(t.total)} movie${t.total === 1 ? '' : 's'} by release year`;
    desc = state.picks.length
      ? [el('span', { text: 'Timeline ·' }), ...desc.filter((d) => !d.classList?.contains('muted')), muted(count)]
      : [el('span', { text: 'Timeline ·' }), ...scope, muted(count)];
  }
  $('view-desc').replaceChildren(...desc);

  // Every active filter, each removable on its own.
  const f = state.filters;
  const chips = [];
  const changed = () => {
    if (facets) buildFilters(facets);
    onFiltersChanged();
  };
  if (f.yearFrom != null || f.yearTo != null) {
    const text = f.yearFrom != null && f.yearTo != null ? `${f.yearFrom}–${f.yearTo}` : f.yearFrom != null ? `${f.yearFrom} and later` : `Up to ${f.yearTo}`;
    chips.push(filterPill(text, () => { f.yearFrom = null; f.yearTo = null; changed(); }));
  }
  if (f.minRating != null) chips.push(filterPill(`★ ${f.minRating}+`, () => { f.minRating = null; changed(); }));
  for (const g of f.genres) chips.push(filterPill(`Genre: ${g}`, () => { f.genres.delete(g); changed(); }));
  for (const r of f.contentRatings) chips.push(filterPill(`Rated ${r}`, () => { f.contentRatings.delete(r); changed(); }));
  for (const t of state.hidden) {
    const text = t === 'Genre' ? 'Genre links off' : t === 'Country' ? 'Country links off' : `Hiding ${PLURAL[t]}`;
    chips.push(filterPill(text, () => setTypeHidden(t, false)));
  }
  $('view-filters').replaceChildren(
    ...(chips.length
      ? [el('span', { text: 'Filters:' }), ...chips, el('button', { class: 'linkish', type: 'button', text: 'Clear filters', onclick: clearAllFilters })]
      : [el('span', { text: 'No filters' })]),
  );
}

/** Shows movies matching every pick. Creates a Back entry unless replaying one. */
function showPicks(picks, { fromHistory = false } = {}) {
  const clean = picks.map(pickOf);
  const entry = fromHistory ? state.history.at(-1) : pushHistory({ kind: 'picks', picks: clean });
  return loadPicksView(entry);
}

const MAX_PICKS = 6; // same limit as the server
function addPick(item) {
  const p = pickOf(item);
  if (state.picks.some((x) => samePick(x, p))) return;
  if (state.picks.length >= MAX_PICKS) {
    showBanner(`You can combine up to ${MAX_PICKS} things. Remove one in the bar above the graph first.`);
    return;
  }
  showPicks([...state.picks, p]);
}

function removePick(i) {
  const rest = state.picks.filter((_, j) => j !== i);
  if (rest.length) showPicks(rest);
  else loadOverview();
}

async function loadPicksView(entry) {
  const mine = ++focusSeq;
  clearGraph();
  state.viewing = entry;
  updateBackButton();
  setView({ kind: 'picks', picks: entry.picks, loading: true });
  try {
    const q = new URLSearchParams({ picks: pickParam(entry.picks), limit: 150, ...filterParams() });
    const data = await api(`/api/graph/intersect?${q}`);
    if (mine !== focusSeq) return;
    addData(data);
    for (const p of data.picks) {
      const n = state.nodes.get(p.id);
      if (n) n.isPick = true;
    }
    // A pick of a switched-off type (say a genre) is still shown, so put it back in the layout.
    if (data.picks.some((p) => state.hidden.has(p.label)) && state.mode === 'graph') Graph.graphData(layoutData());
    setView({ kind: 'picks', picks: entry.picks, total: data.total, shown: data.shown });
    state.results = {
      picks: entry.picks,
      total: data.total,
      movies: data.nodes.filter((n) => n.label === 'Movie').map((n) => n.id),
    };
    renderResults();
    fitSoon();
  } catch (err) {
    if (mine !== focusSeq) return;
    setView({ kind: 'picks', picks: entry.picks, error: err.message });
    showBanner(err.message);
  }
}

/** Side panel: the movies matching the current picks, as a plain list. */
function renderResults() {
  const r = state.results;
  if (!r) return closeDetail();
  state.selected = null;
  requestRedraw();
  const panel = $('detail');
  panel.hidden = false;
  const names = r.picks.map(pickName).join(' and ');
  const movies = r.movies.map((id) => state.nodes.get(id)).filter(Boolean);
  const visible = movies.filter(passesFilters);
  panel.replaceChildren(
    el('h3', { text: `Movies with ${names}` }),
    el('div', { class: 'hint', text: r.total === 0 ? 'Nothing in your library matches all of these.' : movies.length < r.total ? `The ${fmt(movies.length)} best rated of ${fmt(r.total)}` : `${fmt(r.total)} movie${r.total === 1 ? '' : 's'}` }),
    el(
      'ul',
      { class: 'results-list' },
      visible.map((n) =>
        el(
          'li',
          {},
          el(
            'button',
            { type: 'button', onclick: () => selectNode(n, { expand: true, center: true }) },
            shapeSvg(TYPE.Movie),
            el('span', { text: n.props?.year ? `${n.name} (${n.props.year})` : n.name }),
            n.props?.audienceRating ? el('span', { class: 'count', text: `★ ${Number(n.props.audienceRating).toFixed(1)}` }) : null,
          ),
        ),
      ),
    ),
  );
}

const HIDDEN_KEY = 'cinestellar.hiddenTypes';
const OLD_HIDDEN_KEY = 'plexGraph.hiddenTypes'; // before the rename

function setTypeHidden(type, hidden, { save = true } = {}) {
  const was = state.hidden.has(type);
  if (hidden) state.hidden.add(type);
  else state.hidden.delete(type);
  const b = document.querySelector(`#legend button[data-type="${type}"]`);
  if (b) b.setAttribute('aria-pressed', String(!hidden));
  const box = $(`toggle-${type}`);
  if (box) box.checked = !hidden;
  if (save) {
    try {
      localStorage.setItem(HIDDEN_KEY, JSON.stringify([...state.hidden]));
    } catch {
      /* storage blocked: the choice just isn't remembered */
    }
  }
  if (was !== hidden && state.mode === 'graph' && typeof Graph !== 'undefined') {
    Graph.graphData(layoutData()); // let the layout re-form without (or with) these hubs
    busy.layout = state.nodes.size > 0;
    updateBusy();
  }
  applyVisibility();
  renderViewBar();
}

// ---- timeline -------------------------------------------------------------------------
//
// Movies placed by release year (x) and stacked best-rated-first within each year (y), over
// shaded decade bands with a small bar showing how many movies each decade has. It covers the
// current picks, or the whole library when nothing is picked. Filters apply.

const TL = { col: 16, row: 21 };
let timelineSeq = 0;

function setMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode;
  $('mode-graph').setAttribute('aria-pressed', String(mode === 'graph'));
  $('mode-timeline').setAttribute('aria-pressed', String(mode === 'timeline'));
  if (mode === 'graph') {
    timelineSeq++;
    state.timeline = null;
    if (state.selected) state.selected = state.nodes.get(state.selected.id) ?? null;
    Graph.graphData(layoutData());
    $('empty').hidden = state.nodes.size > 0;
    fitSoon();
    renderViewBar();
  } else {
    stopUnfold();
    showTimeline();
  }
}

const showTimelineSoon = debounce(() => showTimeline(), 60);

async function showTimeline() {
  if (state.mode !== 'timeline') return;
  const mine = ++timelineSeq;
  state.timeline = null;
  renderViewBar();
  const params = { limit: 400, ...filterParams() };
  if (state.picks.length) params.picks = pickParam(state.picks);
  try {
    const data = await api(`/api/graph/timeline?${new URLSearchParams(params)}`);
    if (mine !== timelineSeq || state.mode !== 'timeline') return;
    layoutTimeline(data);
  } catch (err) {
    if (mine === timelineSeq) showBanner(err.message);
  }
}

function layoutTimeline(data) {
  const years = data.movies.map((m) => m.props.year);
  const decades = data.decades.map((d) => d.decade);
  const minDecade = Math.min(...decades, ...years.map((y) => Math.floor(y / 10) * 10));
  const perYear = new Map();
  const nodes = data.movies.map((m) => {
    const y = m.props.year;
    const i = perYear.get(y) ?? 0;
    perYear.set(y, i + 1);
    return {
      ...m,
      key: keyOf(m.id, m.label),
      r: 5,
      fx: (y - minDecade) * TL.col,
      fy: -(i + 1) * TL.row,
    };
  });
  state.timeline = { data, minDecade, nodes };
  Graph.graphData({ nodes, links: [] });
  $('empty').hidden = nodes.length > 0;
  renderViewBar();
  setTimeout(fitTimeline, 60);
}

/** Fit the whole timeline, decade labels and bars included (zoomToFit only knows about nodes). */
function fitTimeline(ms = 400) {
  const t = state.timeline;
  if (!t || !t.data.decades.length) return;
  const last = Math.max(...t.data.decades.map((d) => d.decade));
  const x0 = -TL.col;
  const x1 = (last + 10 - t.minDecade) * TL.col;
  const y0 = Math.min(-TL.row, ...t.nodes.map((n) => n.fy)) - TL.row * 1.5;
  const y1 = 125;
  const box = $('graph');
  const k = Math.min(box.clientWidth / (x1 - x0), box.clientHeight / (y1 - y0)) * 0.92;
  Graph.centerAt((x0 + x1) / 2, (y0 + y1) / 2, ms);
  Graph.zoom(Math.min(k, 6), ms);
}

function drawTimelineBackground(ctx, scale) {
  const t = state.timeline;
  if (!t || !t.data.decades.length) return;
  const max = Math.max(...t.data.decades.map((d) => d.count));
  const top = Math.min(-TL.row, ...t.nodes.map((n) => n.fy)) - TL.row;
  const font = (px, weight = '') => `${weight} ${px / scale}px system-ui, sans-serif`;
  ctx.save();
  t.data.decades.forEach((d, i) => {
    const x0 = (d.decade - t.minDecade) * TL.col - TL.col / 2;
    const w = 10 * TL.col;
    if (i % 2 === 0) {
      ctx.fillStyle = colors.band;
      ctx.fillRect(x0, top, w, -top + 120);
    }
    // How many movies this decade has in total (not just the ones drawn).
    const h = 70 * (d.count / max);
    ctx.fillStyle = colors.series.Movie;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(x0 + 6, 46, w - 12, h);
    ctx.globalAlpha = 1;
    ctx.fillStyle = colors.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = font(14, '600');
    ctx.fillText(`${d.decade}s`, x0 + w / 2, 10);
    ctx.fillStyle = colors.muted;
    ctx.font = font(11);
    ctx.fillText(`${fmt(d.count)} movie${d.count === 1 ? '' : 's'}`, x0 + w / 2, 10 + 17 / scale);
  });
  // Axis with a tick per year and a label every five.
  const first = t.minDecade;
  const last = Math.max(...t.data.decades.map((d) => d.decade)) + 9;
  ctx.strokeStyle = colors.border;
  ctx.lineWidth = 1 / scale;
  ctx.beginPath();
  ctx.moveTo(-TL.col / 2, 0);
  ctx.lineTo((last - first) * TL.col + TL.col / 2, 0);
  for (let y = first; y <= last; y++) {
    const x = (y - first) * TL.col;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, y % 5 === 0 ? 5 : 2.5);
  }
  ctx.stroke();
  ctx.restore();
}

// ---- unfold: keep opening connections, ring by ring ---------------------------------------

const UNFOLD = { maxNodes: 350, perNode: 12, delayMs: 650, maxDepth: 3 };

let unfoldSeq = 0;
function stopUnfold() {
  if (!state.unfolding) return;
  unfoldSeq++; // any loop still sleeping sees this and quits
  state.unfolding = false;
  $('btn-unfold').textContent = 'Unfold';
  $('btn-unfold').setAttribute('aria-pressed', 'false');
  renderViewBar();
}

async function unfold() {
  if (state.unfolding) return stopUnfold();
  if (state.mode !== 'graph') setMode('graph');
  if (state.nodes.size === 0) {
    showBanner('Pick or search for something first; Unfold grows the graph from what is on it.');
    return;
  }
  state.unfolding = true;
  const run = ++unfoldSeq;
  $('btn-unfold').textContent = 'Stop';
  $('btn-unfold').setAttribute('aria-pressed', 'true');
  const seq = focusSeq;
  const alive = () => run === unfoldSeq && seq === focusSeq;
  // Start from the selection (or everything on screen) and work outwards one ring at a time.
  let ring = state.selected ? [state.selected] : [...state.nodes.values()];
  const seen = new Set();
  for (let depth = 0; depth < UNFOLD.maxDepth && alive(); depth++) {
    const next = [];
    for (const node of ring) {
      if (!alive() || state.nodes.size >= UNFOLD.maxNodes) break;
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      // Countries link to almost everything; opening them buries the picture.
      if (node.label === 'Country' || !nodeVisible(node)) continue;
      if (node.limit == null) {
        try {
          await expandNode(node, UNFOLD.perNode);
        } catch (err) {
          showBanner(err.message);
          break;
        }
        renderViewBar();
        Graph.zoomToFit(UNFOLD.delayMs, 60); // follow the graph as it grows
        await new Promise((r) => setTimeout(r, UNFOLD.delayMs));
      }
      for (const id of state.adj.get(node.id) ?? []) next.push(state.nodes.get(id));
    }
    ring = next.filter(Boolean);
    if (!ring.length) break;
  }
  if (run !== unfoldSeq) return; // stopped, or a newer run took over
  stopUnfold();
  if (seq === focusSeq) fitSoon();
}

// ---- back navigation ----------------------------------------------------------------

// state.history holds the views you've opened; state.viewing is the one on screen now (null
// after Clear). Back returns to the latest entry that isn't what's on screen.
const sameEntry = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function updateBackButton() {
  const last = state.history.at(-1);
  $('btn-back').disabled = !(state.history.length >= 2 || (last && state.viewing !== last));
}

function pushHistory(entry) {
  const last = state.history.at(-1);
  if (last && sameEntry(last, entry)) return last;
  state.history.push(entry);
  if (state.history.length > 50) state.history.shift();
  updateBackButton();
  return entry;
}

function showEntry(entry) {
  if (entry.kind === 'overview') loadOverview({ fromHistory: true });
  else if (entry.kind === 'focus') focusOn(entry.label, entry.key, { fromHistory: true });
  else if (entry.kind === 'path') runPath(entry.a, entry.b, { fromHistory: true });
  else if (entry.kind === 'picks') showPicks(entry.picks, { fromHistory: true });
}

function goBack() {
  const last = state.history.at(-1);
  if (!last) return;
  if (state.viewing !== last) {
    showEntry(last); // e.g. after Clear: bring back what was there
  } else if (state.history.length >= 2) {
    state.history.pop();
    showEntry(state.history.at(-1));
  }
  updateBackButton();
}

// ---- detail panel ----------------------------------------------------------------

// ---- more like this ---------------------------------------------------------------

const similarCache = new Map();
function loadSimilar(node) {
  const params = { id: node.key, limit: 10, ...filterParams() };
  const key = JSON.stringify(params);
  if (!similarCache.has(key)) {
    const p = api(`/api/graph/similar?${new URLSearchParams(params)}`).then((r) => r.results);
    p.catch(() => similarCache.delete(key));
    similarCache.set(key, p);
  }
  return similarCache.get(key);
}

function similarReason(item) {
  if (item.shared?.length) {
    const more = item.shared.length > 3 ? ` +${item.shared.length - 3} more` : '';
    return `Shares ${item.shared.slice(0, 3).join(', ')}${more}`;
  }
  return item.sharedGenres?.length ? `Same genres: ${item.sharedGenres.join(', ')}` : '';
}

/** Puts suggestions on the canvas, linked to the movie by dashed "more like this" edges. */
async function addSimilarToGraph(node, items) {
  setMode('graph');
  if (!state.nodes.has(node.id)) await focusOn(node.label, node.key, { name: node.name });
  node = state.nodes.get(node.id) ?? node;
  addData(
    {
      nodes: items.map(({ score, shared, sharedGenres, ...n }) => n),
      edges: items.map((it) => ({ source: node.id, target: it.id, type: 'SIMILAR_TO', weight: it.score, reason: similarReason(it) })),
    },
    node,
  );
}

function similarSection(node) {
  const list = el('ol', { class: 'similar' }, el('li', { class: 'hint', text: 'Finding similar movies…' }));
  const showAll = el('button', { class: 'btn small', type: 'button', text: 'Show on graph', disabled: true });
  const box = el(
    'section',
    { class: 'similar-box', 'aria-label': 'More like this' },
    el('div', { class: 'similar-head' }, el('h4', { text: 'More like this' }), showAll),
    filtersActive() ? el('div', { class: 'hint', text: 'Using your filters' }) : null,
    list,
  );
  loadSimilar(node)
    .then((items) => {
      if (state.selected?.id !== node.id) return;
      if (!items.length) {
        list.replaceChildren(el('li', { class: 'hint', text: 'Nothing in your library shares much with this one.' }));
        return;
      }
      const best = items[0].score || 1;
      showAll.disabled = false;
      showAll.onclick = async () => {
        await addSimilarToGraph(node, items);
        fitSoon();
      };
      list.replaceChildren(
        ...items.map((it) =>
          el(
            'li',
            {},
            el(
              'button',
              {
                type: 'button',
                class: 'sim',
                onclick: async () => {
                  if (state.mode === 'timeline') {
                    // Stay on the timeline: just show the suggestion's details.
                    const there = state.timeline?.nodes.find((n) => n.id === it.id);
                    selectNode(there ?? { ...it, key: keyOf(it.id, it.label) });
                    return;
                  }
                  await addSimilarToGraph(node, [it]);
                  const added = state.nodes.get(it.id);
                  if (added) selectNode(added, { expand: true, center: true });
                },
              },
              el('span', { class: 'sim-title', text: it.props?.year ? `${it.name} (${it.props.year})` : it.name }),
              el('span', { class: 'sim-why', text: similarReason(it) }),
              el('span', { class: 'sim-bar', 'aria-hidden': 'true' }, el('span', { style: `width:${Math.max(6, Math.round((it.score / best) * 100))}%` })),
            ),
          ),
        ),
      );
    })
    .catch((err) => {
      if (state.selected?.id === node.id) list.replaceChildren(el('li', { class: 'error', text: err.message }));
    });
  return box;
}

function closeDetail() {
  $('detail').hidden = true;
  $('detail').replaceChildren();
}

function relText(type, fromMovie) {
  return REL[type]?.[fromMovie ? 0 : 1] ?? type;
}

function renderDetail(node) {
  const panel = $('detail');
  panel.hidden = false;
  const p = node.props ?? {};
  const type = TYPE[node.label];
  const kids = [];

  const headText = el(
    'div',
    { class: 'head-text' },
    el('h3', { text: node.name }),
    el('div', { class: 'type' }, shapeSvg(type), el('span', { text: node.label })),
  );
  if (node.label === 'Movie') {
    const meta = [
      p.year,
      p.contentRating,
      p.duration ? `${Math.round(p.duration / 60000)} min` : null,
      p.audienceRating ? `★ ${Number(p.audienceRating).toFixed(1)}` : null,
    ].filter(Boolean);
    if (meta.length) headText.append(el('div', { class: 'meta', text: meta.join(' · ') }));
  }
  const PICTURE_CLASS = { Movie: 'poster', Collection: 'poster', Person: 'photo', Studio: 'logo' };
  const PICTURE_ALT = { Movie: 'Poster for', Collection: 'Poster for', Person: 'Photo of', Studio: 'Logo of' };
  const poster =
    PICTURE_CLASS[node.label] && hasPicture(node)
      ? el('img', {
          class: PICTURE_CLASS[node.label],
          src: pictureUrl(node).replace('&size=small', ''),
          alt: `${PICTURE_ALT[node.label]} ${node.name}`,
          loading: 'lazy',
          onerror: (e) => e.target.remove(),
        })
      : null;
  kids.push(el('div', { class: poster ? 'detail-head with-poster' : 'detail-head' }, poster, headText));

  if (node.label === 'Movie') {
    if (Array.isArray(p.genres) && p.genres.length) {
      kids.push(el('div', { class: 'chips' }, p.genres.map((g) => el('span', { class: 'chip', text: g }))));
    }
    if (p.tagline) kids.push(el('p', { class: 'tagline', text: p.tagline }));
    if (p.summary) {
      const summary = el('p', { class: 'summary clamp', text: p.summary });
      kids.push(summary);
      if (p.summary.length > 260) {
        kids.push(
          el('button', {
            class: 'linkish',
            type: 'button',
            text: 'Show full summary',
            onclick: (e) => {
              summary.classList.toggle('clamp');
              e.target.textContent = summary.classList.contains('clamp') ? 'Show full summary' : 'Show less';
            },
          }),
        );
      }
    }
    if (/^tt\d+$/.test(p.imdbId ?? '')) {
      kids.push(el('p', {}, el('a', { href: `https://www.imdb.com/title/${p.imdbId}/`, target: '_blank', rel: 'noopener noreferrer', text: 'IMDb' })));
    }
  }

  const actions = el('div', { class: 'actions' });
  if (node.label === 'Movie') {
    actions.append(el('button', { class: 'btn small', text: 'Focus here', onclick: () => { setMode('graph'); focusOn(node.label, node.key, { name: node.name }); } }));
  } else {
    const inPicks = state.picks.some((p) => p.label === node.label && p.key === node.key);
    if (state.picks.length && !inPicks) {
      actions.append(el('button', { class: 'btn small primary', text: `Narrow to + ${node.name}`, onclick: () => addPick(node) }));
    }
    if (!(inPicks && state.picks.length === 1)) {
      actions.append(el('button', { class: 'btn small', text: inPicks ? `Only ${node.name}` : 'Show its movies', onclick: () => showPicks([node]) }));
    }
  }
  if (state.results && node.label === 'Movie') {
    kids.unshift(el('button', { class: 'linkish', type: 'button', text: `← All ${fmt(state.results.total)} results`, onclick: () => renderResults() }));
  }
  if (node.total != null && node.shown < node.total && (node.limit ?? 0) < 300) {
    actions.append(
      el('button', {
        class: 'btn small',
        text: `Show more (${fmt(node.shown)} of ${fmt(node.total)})`,
        onclick: async () => {
          try {
            await expandNode(node, Math.min(300, (node.limit ?? 60) * 3));
            if (state.selected?.id === node.id) renderDetail(node);
          } catch (err) {
            showBanner(err.message);
          }
        },
      }),
    );
  }
  kids.push(actions);
  if (node.label === 'Movie') kids.push(similarSection(node));

  // Text view of everything connected on the canvas (also the keyboard route through the graph).
  const groups = new Map();
  for (const l of state.links) {
    const a = endId(l.source);
    const b = endId(l.target);
    if (a !== node.id && b !== node.id) continue;
    const other = state.nodes.get(a === node.id ? b : a);
    if (!other || l.type === 'SIMILAR_TO') continue;
    const heading = l.type === 'SHARES_MOVIES' ? REL.SHARES_MOVIES[0] : relText(l.type, node.label === 'Movie');
    if (!groups.has(heading)) groups.set(heading, []);
    groups.get(heading).push({ other, role: l.role, weight: l.weight, order: l.order });
  }
  if (node.total != null) {
    kids.push(el('div', { class: 'hint', text: `${fmt(node.shown ?? 0)} of ${fmt(node.total)} connections loaded` }));
  }
  for (const [heading, items] of groups) {
    items.sort((x, y) => (x.order ?? Infinity) - (y.order ?? Infinity) || (y.weight ?? 0) - (x.weight ?? 0));
    kids.push(
      el('h4', { text: `${heading} (${items.length})` }),
      el(
        'ul',
        { class: 'conn' },
        items.map(({ other, role, weight }) =>
          el(
            'li',
            {},
            el(
              'button',
              { type: 'button', onclick: () => selectNode(other, { expand: true, center: true }) },
              shapeSvg(TYPE[other.label]),
              el('span', { text: other.name }),
              role ? el('span', { class: 'role', text: `as ${role}` }) : null,
              weight ? el('span', { class: 'count', text: fmt(weight) }) : null,
            ),
          ),
        ),
      ),
    );
  }
  const hadFocus = panel.contains(document.activeElement);
  panel.replaceChildren(...kids);
  const heading = panel.querySelector('h3');
  heading.tabIndex = -1;
  if (hadFocus) heading.focus(); // the button that was just activated no longer exists
}

// ---- search / browse ------------------------------------------------------------

function attachSearch(input, list, onPick, { types } = {}) {
  let items = [];
  let active = -1;
  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    active = -1;
  };
  const render = () => {
    list.replaceChildren(
      ...(items.length
        ? items.map((it, i) =>
            el(
              'li',
              { role: 'option', 'aria-selected': i === active ? 'true' : 'false' },
              el(
                'button',
                { type: 'button', tabindex: '-1', onmousedown: (e) => e.preventDefault(), onclick: () => pick(it) },
                listIcon(it),
                el('span', { text: it.name }),
                it.props?.year ? el('span', { class: 'count', text: it.props.year }) : null,
                it.hint ? el('span', { class: 'count', text: it.hint }) : null,
              ),
            ),
          )
        : [el('li', { class: 'none', text: 'No matches' })]),
    );
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  };
  const pick = (it) => {
    seq++; // drop any search still in flight
    close();
    onPick(it, input);
  };
  let seq = 0;
  let pickWhenReady = false; // Enter pressed before results arrived
  const run = debounce(async () => {
    const mine = ++seq;
    const q = input.value.trim();
    if (q.length < 2) return close();
    try {
      const typeParam = types ? `&types=${types.join(',')}` : '';
      const results = (await api(`/api/graph/search?q=${encodeURIComponent(q)}${typeParam}`)).results;
      if (mine !== seq || input.value.trim() !== q) return; // a newer keystroke or a pick superseded this
      items = results;
      active = -1;
      if (pickWhenReady && items.length) {
        pickWhenReady = false;
        return pick(items[0]);
      }
      pickWhenReady = false;
      render();
    } catch (err) {
      if (mine === seq) showBanner(err.message);
    }
  }, 200);
  input.addEventListener('input', () => {
    // Results on screen belong to the old text; never let Enter pick one of them.
    items = [];
    pickWhenReady = false;
    close();
    run();
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', (e) => {
    if (list.hidden) {
      if (e.key === 'Enter' && input.value.trim().length >= 2) {
        e.preventDefault();
        pickWhenReady = true; // the next search result picks its first item
        run();
      }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % Math.max(items.length, 1);
      render();
    } else if (e.key === 'Enter' && items.length) {
      e.preventDefault();
      pick(items[Math.max(active, 0)]);
    } else if (e.key === 'Escape') {
      close();
    }
  });
}

attachSearch($('search'), $('search-results'), (it) => {
  $('search').value = '';
  if (it.label === 'Movie') focusOn(it.label, keyOf(it.id, it.label), { name: it.name });
  else showPicks([it]);
});

const browseCache = new Map();
let browseSeq = 0;
async function loadBrowse(tab) {
  const { label, role } = tab;
  const list = $('browse-list');
  const hint = $('browse-hint');
  const mine = ++browseSeq;
  const params = { label, limit: 50, ...filterParams(), ...(role ? { role } : {}) };
  if (state.picks.length) params.picks = pickParam(state.picks);
  const cacheKey = JSON.stringify(params);
  const what = role ? `as ${ROLE_LABEL[role]}` : '';
  hint.hidden = false;
  hint.textContent = state.picks.length
    ? `Only what appears in your current results (${state.picks.map(pickName).join(' + ')}). Click one to narrow further.`
    : `Click one to see their movies${what ? ` ${what}` : ''}; click another to combine.`;
  list.replaceChildren(el('li', { class: 'hint', text: 'Loading…' }));
  try {
    if (!browseCache.has(cacheKey)) browseCache.set(cacheKey, (await api(`/api/graph/top?${new URLSearchParams(params)}`)).items);
    if (mine !== browseSeq) return; // the user already switched tabs or picks
    const items = browseCache.get(cacheKey);
    const empty = state.picks.length
      ? 'Nothing else to narrow by here.'
      : role === 'PRODUCED'
        ? 'No producers yet. Run the import again (Libraries → Import selected) to load them.'
        : 'Nothing here yet';
    list.replaceChildren(
      ...(items.length
        ? items.map((it) => {
            const pick = { ...it, role };
            return el(
              'li',
              {},
              el(
                'button',
                {
                  type: 'button',
                  title: state.picks.length ? `Narrow to movies that also have ${pickName(pickOf(pick))}` : `Show movies with ${pickName(pickOf(pick))}`,
                  onclick: () => (state.view?.kind === 'picks' ? addPick(pick) : showPicks([pick])),
                },
                listIcon(it),
                el('span', { text: it.name }),
                el('span', { class: 'count', text: fmt(it.count) }),
              ),
            );
          })
        : [el('li', { class: 'hint', text: empty })]),
    );
  } catch (err) {
    if (mine === browseSeq) list.replaceChildren(el('li', { class: 'hint', text: err.message }));
  }
}
$('browse-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-label]');
  if (!b) return;
  for (const t of $('browse-tabs').children) t.setAttribute('aria-selected', String(t === b));
  loadBrowse(currentTab());
});

// ---- connection finder -------------------------------------------------------------

const pathPick = { a: null, b: null };
for (const side of ['a', 'b']) {
  const input = $(`path-${side}`);
  attachSearch(
    input,
    $(`path-${side}-results`),
    (it) => {
      pathPick[side] = it;
      input.value = it.name;
      $('btn-path').disabled = !(pathPick.a && pathPick.b);
    },
    { types: ['Person', 'Movie'] },
  );
  input.addEventListener('input', () => {
    pathPick[side] = null;
    $('btn-path').disabled = true;
  });
}

/** Shows the shortest chain between two picked items ({ id, label, name }). */
async function runPath(a, b, { fromHistory = false } = {}) {
  setMode('graph');
  const mine = ++focusSeq;
  const chain = $('path-chain');
  chain.replaceChildren(el('li', { class: 'hint', text: 'Searching…' }));
  try {
    const q = new URLSearchParams({ fromLabel: a.label, fromKey: keyOf(a.id, a.label), toLabel: b.label, toKey: keyOf(b.id, b.label) });
    const data = await api(`/api/graph/path?${q}`);
    if (mine !== focusSeq) return;
    if (data.none || data.nodes.length === 0) {
      chain.replaceChildren(el('li', { class: 'hint', text: 'No connection through shared cast or crew.' }));
      return;
    }
    const entry = fromHistory
      ? state.history.at(-1)
      : pushHistory({ kind: 'path', a: { id: a.id, label: a.label, name: a.name }, b: { id: b.id, label: b.label, name: b.name } });
    clearGraph();
    state.viewing = entry;
    updateBackButton();
    addData(data);
    state.pathEdges = new Set(state.links.map(linkKey));
    state.pathNodes = new Set(data.nodes.map((n) => n.id));
    setView({ kind: 'path', a: pickOf(a), b: pickOf(b), steps: data.edges.length });
    chain.replaceChildren(
      ...data.nodes.map((n) =>
        el('li', {}, shapeSvg(TYPE[n.label]), el('span', { text: n.name }), n.props?.year ? el('span', { class: 'via', text: String(n.props.year) }) : null),
      ),
    );
    fitSoon();
  } catch (err) {
    chain.replaceChildren(el('li', { class: 'error', text: err.message }));
  }
}

$('btn-path').addEventListener('click', () => runPath(pathPick.a, pathPick.b));

// ---- legend / toolbar --------------------------------------------------------------

$('legend').replaceChildren(
  ...TYPES.map((t) =>
    el(
      'li',
      {},
      el('button', {
        type: 'button',
        'aria-pressed': 'true',
        dataset: { type: t.label },
        onclick: (e) => setTypeHidden(t.label, e.currentTarget.getAttribute('aria-pressed') === 'true'),
      }, shapeSvg(t), el('span', { text: t.label })),
    ),
  ),
);
for (const type of ['Genre', 'Country']) {
  $(`toggle-${type}`).addEventListener('change', (e) => setTypeHidden(type, !e.target.checked));
}
// Bring back the types you switched off last time.
try {
  const saved = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? localStorage.getItem(OLD_HIDDEN_KEY) ?? '[]');
  if (Array.isArray(saved)) for (const t of saved) if (TYPES.some((x) => x.label === t)) setTypeHidden(t, true, { save: false });
} catch {
  /* nothing saved, or storage blocked */
}

// Fit: zoom to the selected item and what it touches; Shift-click (or nothing selected) shows everything.
$('btn-fit').addEventListener('click', (e) => {
  const sel = state.selected;
  if (state.mode === 'timeline') {
    fitTimeline();
    return;
  }
  if (sel && !e.shiftKey && state.nodes.has(sel.id)) {
    const keep = new Set([sel.id, ...(state.adj.get(sel.id) ?? [])]);
    if (keep.size <= 1) {
      Graph.centerAt(sel.x, sel.y, 400);
      Graph.zoom(2, 400);
    } else {
      Graph.zoomToFit(400, 60, (n) => keep.has(n.id) && nodeVisible(n));
    }
  } else {
    Graph.zoomToFit(400, 60, (n) => nodeVisible(n));
  }
});
$('btn-back').addEventListener('click', goBack);
$('mode-graph').addEventListener('click', () => setMode('graph'));
$('mode-timeline').addEventListener('click', () => setMode('timeline'));
$('btn-unfold').addEventListener('click', unfold);
$('toggle-posters').addEventListener('change', (e) => {
  state.showPosters = e.target.checked;
  // Pictures take more room than the shapes, so let the layout make space (graph view only).
  if (state.mode === 'graph') Graph.d3ReheatSimulation();
  requestRedraw();
});
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName ?? '');
  if (e.altKey && e.key === 'ArrowLeft') {
    e.preventDefault();
    goBack();
  } else if (e.key === '/' && !typing && $('modal').hidden) {
    e.preventDefault();
    $('search').focus();
  }
});
$('btn-clear').addEventListener('click', () => {
  clearGraph();
  setView(null);
});
$('btn-overview').addEventListener('click', loadOverview);

// ---- filter controls -------------------------------------------------------------------

const RATING_STEPS = [5, 6, 7, 7.5, 8, 8.5];

function chipToggles(values, selected, label) {
  return el(
    'div',
    { class: 'chip-toggles', role: 'group', 'aria-label': label },
    values.map((v) =>
      el('button', {
        type: 'button',
        'aria-pressed': String(selected.has(v)),
        text: v,
        onclick: (e) => {
          if (selected.has(v)) selected.delete(v);
          else selected.add(v);
          e.currentTarget.setAttribute('aria-pressed', String(selected.has(v)));
          onFiltersChanged();
        },
      }),
    ),
  );
}

function buildFilters(f) {
  const body = $('filter-body');
  if (f.minYear == null) {
    body.replaceChildren(el('p', { class: 'hint', text: 'Import a library to filter it.' }));
    return;
  }
  const decades = [];
  for (let d = Math.floor(f.minYear / 10) * 10; d <= f.maxYear; d += 10) decades.push(d);
  const yearSelect = (id, label, value, toEnd) =>
    el(
      'div',
      {},
      el('label', { for: id, text: label }),
      el(
        'select',
        {
          id,
          onchange: (e) => {
            const v = e.target.value === '' ? null : Number(e.target.value);
            state.filters[toEnd ? 'yearTo' : 'yearFrom'] = v;
            onFiltersChanged();
          },
        },
        el('option', { value: '', text: 'Any' }),
        decades.map((d) => {
          const v = toEnd ? d + 9 : d;
          return el('option', { value: v, text: `${d}s`, selected: value === v });
        }),
      ),
    );
  const ratingSelect = el(
    'select',
    {
      id: 'filter-rating',
      onchange: (e) => {
        state.filters.minRating = e.target.value === '' ? null : Number(e.target.value);
        onFiltersChanged();
      },
    },
    el('option', { value: '', text: 'Any rating' }),
    RATING_STEPS.map((r) => el('option', { value: r, text: `★ ${r}+`, selected: state.filters.minRating === r })),
  );
  const kids = [
    el('div', { class: 'filter-row' }, yearSelect('filter-from', 'From', state.filters.yearFrom, false), yearSelect('filter-to', 'To', state.filters.yearTo, true)),
    el('div', { class: 'filter-row' }, el('div', {}, el('label', { for: 'filter-rating', text: 'Audience rating' }), ratingSelect)),
    el('span', { class: 'filter-label', text: 'Genres (any of)' }),
    chipToggles(f.genres.slice(0, 24).map((g) => g.name), state.filters.genres, 'Genres'),
  ];
  if (f.contentRatings.length) {
    kids.push(el('span', { class: 'filter-label', text: 'Content rating' }), chipToggles(f.contentRatings, state.filters.contentRatings, 'Content rating'));
  }
  if (f.needsReimport) {
    kids.push(el('p', { class: 'hint', text: 'Run the import again once so genre filters also apply to movies already on the graph.' }));
  }
  body.replaceChildren(...kids);
}

/** How many movies currently on the graph the filters are hiding. */
function updateFilterStatus() {
  if (!filtersActive()) {
    $('filter-status').textContent = '';
    return;
  }
  const hidden = [...state.nodes.values()].filter((n) => n.label === 'Movie' && !passesFilters(n)).length;
  $('filter-status').textContent = `${hidden ? `${fmt(hidden)} movie${hidden === 1 ? '' : 's'} on the graph hidden. ` : ''}Filters also apply to what you expand, Browse and "More like this".`;
}

function onFiltersChanged() {
  const f = state.filters;
  const count = (f.yearFrom != null || f.yearTo != null ? 1 : 0) + (f.minRating != null ? 1 : 0) + (f.genres.size ? 1 : 0) + (f.contentRatings.size ? 1 : 0);
  $('filter-count').hidden = count === 0;
  $('filter-count').textContent = String(count);
  $('btn-clear-filters').hidden = count === 0;
  applyVisibility();
  updateFilterStatus();
  renderViewBar();
  loadBrowse(currentTab());
  if (state.mode === 'timeline') showTimelineSoon();
  // Views fetched from the server are refetched so the filters apply to them, not just hide.
  if (state.viewing?.kind === 'picks') loadPicksView(state.viewing);
  else if (state.viewing?.kind === 'overview' && state.mode === 'graph') loadOverview({ fromHistory: true });
  else if (state.selected) renderDetail(state.selected);
}

function clearAllFilters() {
  for (const t of [...state.hidden]) setTypeHidden(t, false); // everything listed in the bar
  const f = state.filters;
  Object.assign(f, { yearFrom: null, yearTo: null, minRating: null });
  f.genres.clear();
  f.contentRatings.clear();
  if (facets) buildFilters(facets); // reset the controls on screen
  onFiltersChanged();
}
$('btn-clear-filters').addEventListener('click', clearAllFilters);

let facets = null;
async function loadFacets() {
  try {
    facets = await api('/api/graph/facets');
    buildFilters(facets);
  } catch {
    /* filters stay as they were; the banner reports database problems */
  }
}

// ---- status + banner ----------------------------------------------------------------

function showBanner(msg) {
  const b = $('banner');
  b.textContent = msg;
  b.hidden = !msg;
}

async function refreshStatus() {
  const s = await api('/api/status');
  if (s.version) $('app-version').textContent = `v${s.version}`;
  const n = s.stats?.nodes ?? {};
  $('stats').textContent = s.stats
    ? `${fmt(n.Movie)} movies · ${fmt(n.Person)} people · ${fmt(s.stats.relationships)} connections`
    : '';
  showBanner(
    !s.neo4j.ok
      ? `Cannot reach the graph database: ${s.neo4j.error}`
      : s.neo4j.dedicated
        ? ''
        : 'This Neo4j database holds data Cinestellar did not create, so imports are disabled. Use the Neo4j bundled with Cinestellar.',
  );
  return s;
}

// ---- setup modal ---------------------------------------------------------------------

const modal = {
  open(title, ...kids) {
    $('modal-title').textContent = title;
    $('modal-body').replaceChildren(...kids);
    $('modal').hidden = false;
    const first = $('modal-body').querySelector('input, button');
    first?.focus();
  },
  close() {
    $('modal').hidden = true;
  },
};
$('modal').addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('modal').dataset.locked) return modal.close();
  if (e.key !== 'Tab') return;
  const focusable = [...$('modal').querySelectorAll('input:not(:disabled), button:not(:disabled), a[href], summary')];
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

let signinSeq = 0;

/** "Sign in with Plex": approve on plex.tv, then pick a server. No token to copy by hand. */
function signinSection(err) {
  const status = el('div', { class: 'hint', role: 'status' });
  const list = el('div', { class: 'server-list' });
  const btn = el('button', { class: 'btn primary', type: 'button', text: 'Sign in with Plex' });

  const chooseServer = async (id, server, buttons) => {
    buttons.forEach((b) => (b.disabled = true));
    err.textContent = '';
    status.textContent = `Connecting to ${server.name}…`;
    try {
      const r = await api(`/api/plex/signin/${encodeURIComponent(id)}/choose`, { method: 'POST', body: { serverId: server.serverId } });
      lastStatus = await refreshStatus();
      libraryStep(r.libraries, r.server.name);
    } catch (ex) {
      status.textContent = '';
      err.textContent = ex.message;
      buttons.forEach((b) => (b.disabled = false));
    }
  };

  const showServers = (id, servers) => {
    btn.hidden = true;
    if (servers.length === 0) {
      status.textContent = 'This Plex account has no media servers. Sign in with the account that owns your server.';
      btn.hidden = false;
      btn.disabled = false;
      return;
    }
    status.textContent = 'Signed in. Which server should Cinestellar use?';
    const buttons = servers.map((server) =>
      el(
        'button',
        { class: 'server-choice', type: 'button', onclick: () => chooseServer(id, server, buttons) },
        el('strong', { text: server.name }),
        el('span', {
          class: 'hint',
          text: [server.owned ? 'your server' : server.ownerName ? `shared by ${server.ownerName}` : 'shared with you', server.address]
            .filter(Boolean)
            .join(' · '),
        }),
      ),
    );
    list.replaceChildren(...buttons);
    buttons[0].focus();
  };

  btn.addEventListener('click', async () => {
    const mine = ++signinSeq;
    // Browsers only allow a new tab straight from a click, so open it now and point it at
    // plex.tv once we know the address.
    const tab = window.open('', '_blank');
    if (tab) tab.opener = null;
    btn.disabled = true;
    err.textContent = '';
    status.textContent = 'Opening plex.tv…';
    let s;
    try {
      s = await api('/api/plex/signin', { method: 'POST', body: {} });
    } catch (ex) {
      tab?.close();
      btn.disabled = false;
      status.textContent = '';
      err.textContent = ex.message;
      return;
    }
    if (tab) tab.location.href = s.url;
    status.replaceChildren(
      el('span', { text: 'Approve Cinestellar in the plex.tv tab, then come back here. ' }),
      el('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer', text: tab ? 'Open that page again' : 'Open the plex.tv sign-in page' }),
    );
    // Stop when the dialog closes, moves on (e.g. to the library list) or a new sign-in starts.
    const still = () => mine === signinSeq && !$('modal').hidden && btn.isConnected;
    const deadline = Date.now() + s.expiresIn * 1000;
    while (still() && Date.now() < deadline) {
      await sleep(2000);
      if (!still()) return;
      try {
        const r = await api(`/api/plex/signin/${encodeURIComponent(s.id)}`);
        if (r.state === 'done') return showServers(s.id, r.servers);
      } catch (ex) {
        err.textContent = ex.message;
        break;
      }
    }
    if (still()) {
      btn.disabled = false;
      if (!err.textContent) status.textContent = 'The sign-in timed out. Try again.';
    }
  });

  return el(
    'div',
    { class: 'signin' },
    el('p', { class: 'hint', text: 'Sign in with your Plex account and pick a server. Cinestellar gets its own access, and if the server\'s address on your network changes it finds it again by itself.' }),
    btn,
    status,
    list,
  );
}

function connectStep(prefill = {}, message = '') {
  const url = el('input', { type: 'url', id: 'plex-url', placeholder: 'http://192.168.1.10:32400', value: prefill.url ?? '', required: true, autocomplete: 'off' });
  const token = el('input', { type: 'password', id: 'plex-token', placeholder: 'X-Plex-Token', required: true, autocomplete: 'off' });
  const err = el('div', { class: 'error', role: 'alert', text: message });
  const submit = el('button', { class: 'btn primary', type: 'submit', text: 'Connect' });
  // Pasting the address of a "View XML" page fills in both the server address and the token.
  const splitViewXml = (e) => {
    try {
      const u = new URL(e.target.value.trim());
      const t = u.searchParams.get('X-Plex-Token');
      if (!t) return;
      url.value = u.origin;
      token.value = t;
      err.textContent = '';
    } catch {
      /* not a URL yet */
    }
  };
  url.addEventListener('input', splitViewXml);
  token.addEventListener('input', splitViewXml);
  const form = el(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        submit.disabled = true;
        err.textContent = '';
        try {
          const r = await api('/api/plex/connect', { method: 'POST', body: { url: url.value, token: token.value } });
          // Re-read the saved choices: they are cleared when this is a different server.
          lastStatus = await refreshStatus();
          libraryStep(r.libraries, r.server.name);
        } catch (ex) {
          err.textContent = ex.message;
        } finally {
          submit.disabled = false;
        }
      },
    },
    el('p', { class: 'hint', text: 'In Plex Web open any movie, choose Get Info → View XML, and paste that page\'s address below. It fills in both fields.' }),
    el('p', { class: 'hint', text: 'Plex on this same PC? Use http://host.docker.internal:32400. If Plex is set to require secure connections, use the https://…plex.direct:32400 address from the View XML page.' }),
    el('p', { class: 'hint', text: 'Your token is kept only in this app\'s data volume and is never sent back to the browser.' }),
    el('div', { class: 'form-row' }, el('label', { class: 'field-label', for: 'plex-url', text: 'Plex server URL (or paste the View XML address)' }), url),
    el('div', { class: 'form-row' }, el('label', { class: 'field-label', for: 'plex-token', text: 'Plex token' }), token,
      el('a', { class: 'hint', href: 'https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/', target: '_blank', rel: 'noopener noreferrer', text: 'How do I find my token?' })),
    err,
    el('div', { class: 'row-actions' }, submit),
  );
  const manual = el('details', { class: 'manual' }, el('summary', { text: 'Or enter the server address and token yourself' }), form);
  if (prefill.url && !lastStatus?.signedIn) manual.open = true;
  const signinErr = el('div', { class: 'error', role: 'alert' });
  modal.open(
    'Connect to Plex',
    signinSection(signinErr),
    signinErr,
    manual,
    el('div', { class: 'row-actions' }, el('button', { class: 'btn', type: 'button', text: 'Close', onclick: modal.close })),
  );
}

function libraryStep(libraries, serverName) {
  const saved = new Set(lastStatus?.libraries?.map((l) => l.key));
  const movies = libraries.filter((l) => l.type === 'movie');
  const boxes = libraries.map((l) => {
    const isMovie = l.type === 'movie';
    const cb = el('input', { type: 'checkbox', value: l.key, id: `lib-${l.key}`, disabled: !isMovie, checked: isMovie && (saved.size ? saved.has(l.key) : movies.length === 1) });
    return el('li', {}, el('label', { for: `lib-${l.key}` }, cb, el('span', { text: l.title }), isMovie ? null : el('span', { class: 'soon', text: `${l.type} · movies only for now` })));
  });
  const err = el('div', { class: 'error', role: 'alert' });
  const start = el('button', {
    class: 'btn primary',
    type: 'button',
    text: 'Import selected',
    onclick: async () => {
      const keys = [...document.querySelectorAll('.libs input:checked')].map((i) => i.value);
      if (!keys.length) {
        err.textContent = 'Choose at least one library.';
        return;
      }
      start.disabled = true;
      try {
        await api('/api/import', { method: 'POST', body: { libraries: keys } });
        progressStep();
      } catch (ex) {
        err.textContent = ex.message;
        start.disabled = false;
      }
    },
  });
  modal.open(
    serverName ? `Libraries on ${serverName}` : 'Choose libraries',
    el('p', { class: 'hint', text: 'The graph will hold exactly the libraries you tick. After a fully successful import, libraries you untick and titles deleted from Plex are removed. If anything fails or you cancel, nothing is removed. A library that comes back completely empty is left as it was, in case Plex is mid-scan.' }),
    el('ul', { class: 'libs' }, boxes),
    tmdbSection(),
    err,
    el('div', { class: 'row-actions' },
      el('button', { class: 'btn', type: 'button', text: 'Change server', onclick: () => connectStep() }),
      el('button', { class: 'btn', type: 'button', text: 'Close', onclick: modal.close }),
      start),
  );
}

/** The optional TMDB key (studio logos, and franchises Plex hasn't made collections for). */
function tmdbSection() {
  const box = el('details', { class: 'tmdb' });
  const status = el('span', { class: 'hint' });
  const msg = el('div', { class: 'hint', role: 'status' });
  const input = el('input', { type: 'password', id: 'tmdb-key', placeholder: 'TMDB API key or Read Access Token', autocomplete: 'off', spellcheck: 'false' });
  const save = el('button', { class: 'btn', type: 'button', text: 'Save key' });
  const remove = el('button', { class: 'btn', type: 'button', text: 'Remove' });

  const show = (t) => {
    const on = t?.on;
    status.textContent = !on
      ? 'off'
      : t.source === 'site'
        ? 'on (key saved here)'
        : t.source === 'env'
          ? 'on (key from .env)'
          : 'on';
    remove.hidden = t?.source !== 'site';
    // Open by default only while there's no key yet.
    if (!on) box.open = true;
  };
  const send = async (key, doneText) => {
    save.disabled = remove.disabled = true;
    msg.textContent = key ? 'Checking the key with TMDB…' : '';
    try {
      const r = await api('/api/settings/tmdb', { method: 'POST', body: { key } });
      if (lastStatus) lastStatus.tmdb = r.tmdb;
      show(r.tmdb);
      input.value = '';
      msg.textContent = doneText;
    } catch (ex) {
      msg.textContent = ex.message;
    } finally {
      save.disabled = remove.disabled = false;
    }
  };
  save.addEventListener('click', () => {
    if (!input.value.trim()) {
      msg.textContent = 'Paste a key first.';
      return;
    }
    send(input.value, 'Saved. Run the import to fetch studio logos and franchises.');
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      save.click();
    }
  });
  remove.addEventListener('click', () =>
    send('', lastStatus?.tmdb?.source === 'env' ? 'Removed; the key from .env is used again.' : 'Removed. Logos and franchises already imported stay until the next import changes them.'),
  );
  show(lastStatus?.tmdb);

  box.append(
    el('summary', {}, el('span', { text: 'Studio logos and franchises (TMDB): ' }), status),
    el('p', {
      class: 'hint',
      text: 'Plex has no studio logos, and only groups a franchise if you (or Plex) made a collection for it. A free key from The Movie Database fills both in during the import. Only studio names and TMDB movie ids are sent to TMDB.',
    }),
    el('a', { class: 'hint', href: 'https://www.themoviedb.org/settings/api', target: '_blank', rel: 'noopener noreferrer', text: 'Get a free key (themoviedb.org → Settings → API)' }),
    el('div', { class: 'key-row' }, input, save, remove),
    msg,
    el('p', { class: 'hint', text: 'This product uses the TMDB API but is not endorsed or certified by TMDB.' }),
  );
  return box;
}

let pollTimer = null;
function progressStep() {
  const bar = el('div');
  const status = el('p', { 'aria-live': 'polite' });
  const errs = el('details', { class: 'errors', hidden: true }, el('summary', { text: 'Skipped items' }), el('ul'));
  const actions = el('div', { class: 'row-actions' });
  modal.open('Importing', status, el('div', { class: 'progress', role: 'progressbar' }, bar), errs, actions);
  $('modal').dataset.locked = '1';

  const tick = async () => {
    let p;
    try {
      p = await api('/api/import/progress');
    } catch (ex) {
      status.textContent = `${ex.message} (retrying)`;
      pollTimer = setTimeout(tick, 2000);
      return;
    }
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    bar.style.width = `${p.state === 'done' ? 100 : pct}%`;
    status.textContent = p.state === 'running' ? `${p.message}: ${fmt(p.done)} of ${fmt(p.total)} (${p.failed} skipped)` : p.message;
    if (p.errors.length) {
      errs.hidden = false;
      errs.querySelector('ul').replaceChildren(...p.errors.map((m) => el('li', { text: m })));
    }
    if (p.state === 'running') {
      actions.replaceChildren(el('button', { class: 'btn', type: 'button', text: 'Cancel import', onclick: () => api('/api/import/cancel', { method: 'POST', body: {} }) }));
      pollTimer = setTimeout(tick, 800);
      return;
    }
    delete $('modal').dataset.locked;
    browseCache.clear();
    similarCache.clear();
    await refreshStatus().catch(() => {});
    const buttons = [];
    if (p.state === 'error' || p.state === 'cancelled') {
      buttons.push(el('button', { class: 'btn', type: 'button', text: 'Back', onclick: openLibraries }));
    }
    buttons.push(el('button', { class: 'btn primary', type: 'button', text: 'Explore', onclick: () => { modal.close(); loadOverview(); loadBrowse(currentTab()); loadFacets(); } }));
    actions.replaceChildren(...buttons);
  };
  clearTimeout(pollTimer);
  tick();
}

const currentTab = () => {
  const t = document.querySelector('#browse-tabs [aria-selected="true"]');
  return { label: t.dataset.label, role: t.dataset.role || null, name: t.textContent };
};
let lastStatus = null;

async function openLibraries() {
  lastStatus = await refreshStatus();
  if (!lastStatus.configured) return connectStep();
  try {
    const { libraries } = await api('/api/plex/libraries');
    libraryStep(libraries);
  } catch (err) {
    connectStep({ url: lastStatus.plexUrl }, err.message);
  }
}
$('btn-settings').addEventListener('click', openLibraries);

// ---- boot --------------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

renderViewBar();

(async function boot() {
  // Neo4j can take a minute to start the first time; keep checking instead of failing.
  for (let attempt = 0; ; attempt++) {
    try {
      lastStatus = await refreshStatus();
    } catch (err) {
      showBanner(err.message);
      return;
    }
    if (lastStatus.neo4j.ok) break;
    if (lastStatus.neo4j.authFailed) {
      showBanner('Neo4j rejected the password in your .env. If you changed NEO4J_PASSWORD after the first start, see "Changing the Neo4j password" in the README.');
      return;
    }
    showBanner(`Waiting for the graph database to start… (${lastStatus.neo4j.error})`);
    await sleep(Math.min(10000, 2000 + attempt * 1000));
  }
  if (lastStatus.import.state === 'running') return progressStep();
  if (!lastStatus.configured) return connectStep();
  if (!(lastStatus.stats?.nodes?.Movie > 0)) return openLibraries();
  loadOverview();
  loadBrowse(currentTab());
  loadFacets();
})();
