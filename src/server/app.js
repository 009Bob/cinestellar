// SPDX-License-Identifier: GPL-3.0-or-later
import crypto from 'node:crypto';
import { VERSION } from '../version.js';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import express from 'express';
import { PlexClient } from '../importer/plex.js';
import { PlexTv } from '../importer/plextv.js';
import { runImport, newProgress } from '../importer/importer.js';
import { assertLabel, normalizeFilters, normalizePicks } from './graph.js';
import { WebImages } from './webimage.js';
import { TmdbClient } from '../importer/tmdb.js';

export { VERSION };

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../public');
const vendorDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../node_modules/force-graph/dist');

const httpError = (status, message) => Object.assign(new Error(message), { status });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * DNS-rebinding guard. A malicious public site can point its own hostname at this machine's LAN
 * address and then talk to the app "same-origin" from your browser. Such requests carry the
 * attacker's hostname in the Host header, so only addresses and names that cannot belong to an
 * outside party are accepted, plus anything listed in ALLOWED_HOSTS.
 */
export function hostAllowed(hostHeader, extra = []) {
  if (!hostHeader) return false;
  let host;
  try {
    host = new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  host = host.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (net.isIP(host)) return true;
  if (!host.includes('.')) return true; // single-label LAN names, e.g. http://my-pc:8080
  if (/\.(local|lan|home|internal|localdomain|home\.arpa)$/.test(host)) return true;
  return extra.includes(host);
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * @param {object} deps
 * @param {import('./graph.js').GraphStore} deps.store
 * @param {import('./config.js').ConfigStore} deps.config
 * @param {string} [deps.password]  optional shared password (HTTP basic auth)
 * @param {string[]} [deps.allowedHosts]  extra hostnames the site may be reached by
 * @param {{maxCast?:number, fetchBatch?:number}} [deps.importOptions]
 * @param {(opts:{url:string,token:string}) => PlexClient} [deps.makePlex]
 * @param {object|null} [deps.tmdb]  fixed TMDB client (tests); otherwise one is made from the key
 * @param {string} [deps.tmdbEnvKey]  TMDB key from the environment (.env), if any
 * @param {(key:string) => TmdbClient} [deps.makeTmdb]
 * @param {WebImages} [deps.webImages]  fetcher for cast photos and studio logos
 * @param {(clientId:string) => PlexTv} [deps.makePlexTv]  plex.tv client for "Sign in with Plex"
 */
export function createApp({
  store,
  config,
  password,
  allowedHosts = [],
  importOptions = {},
  makePlex = (o) => new PlexClient(o),
  tmdb = null,
  tmdbEnvKey = '',
  makeTmdb = (key) => new TmdbClient({ key }),
  webImages = new WebImages(),
  makePlexTv = (clientId) => new PlexTv({ clientId }),
}) {
  const app = express();
  app.disable('x-powered-by');

  // Accept entries written as "name", "name:8080", "name." or even "http://name:8080/".
  const extraHosts = allowedHosts
    .map((h) => h.trim())
    .filter(Boolean)
    .map((h) => {
      try {
        return new URL(h.includes('://') ? h : `http://${h}`).hostname.toLowerCase().replace(/\.$/, '');
      } catch {
        return '';
      }
    })
    .filter(Boolean);
  app.use((req, res, next) => {
    if (hostAllowed(req.headers.host, extraHosts)) return next();
    res
      .status(403)
      .type('text/plain')
      .send(
        `Cinestellar refused this request because it was addressed to "${req.headers.host ?? ''}".\n` +
          'Open it by IP address, localhost or your computer name, or add this hostname to ALLOWED_HOSTS.',
      );
  });

  // Liveness for Docker's HEALTHCHECK. Says nothing about the database and needs no password.
  app.get('/healthz', (req, res) => res.type('text/plain').send('ok'));

  if (password) {
    app.use((req, res, next) => {
      const m = /^Basic (.+)$/.exec(req.headers.authorization ?? '');
      const supplied = m ? Buffer.from(m[1], 'base64').toString().split(':').slice(1).join(':') : '';
      if (m && safeEqual(supplied, password)) return next();
      res.set('WWW-Authenticate', 'Basic realm="Cinestellar"').status(401).send('Password required');
    });
  }

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });

  // Browsers cannot send cross-site JSON without a CORS preflight, so requiring it blocks CSRF.
  app.use('/api', (req, res, next) => {
    if (['POST', 'PUT', 'DELETE'].includes(req.method) && !req.is('application/json')) {
      return next(httpError(415, 'Content-Type must be application/json'));
    }
    next();
  });
  app.use(express.json({ limit: '50kb' }));

  const job = { progress: newProgress(), abort: null, starting: false };

  // TMDB key: one saved from the site (kept in the app's data volume, like the Plex token) wins
  // over TMDB_API_KEY from .env. Neither is ever sent back to the browser.
  const tmdbKey = () => (config.data.tmdbKey || String(tmdbEnvKey ?? '').trim() || '');
  const currentTmdb = () => tmdb ?? (tmdbKey() ? makeTmdb(tmdbKey()) : null);
  const tmdbStatus = () => ({
    on: Boolean(tmdb || tmdbKey()),
    source: config.data.tmdbKey ? 'site' : tmdbEnvKey?.trim() ? 'env' : null,
  });

  const plexOrThrow = (opts = {}) => {
    if (!config.configured) throw httpError(409, 'Connect to Plex first');
    return makePlex({ url: config.data.plexUrl, token: config.data.plexToken, ...opts });
  };

  // Posters are decoration. If Plex stops answering, fail fast for a while instead of making
  // every poster wait out its own timeout (and filling the log).
  const POSTER_TIMEOUT_MS = 8000;
  const POSTER_PAUSE_MS = 30000;
  let postersPausedUntil = 0;
  const unreachable = (err) => err?.name === 'PlexError' && !err.status;

  // ---- setup / import ----------------------------------------------------

  app.get('/api/status', wrap(async (req, res) => {
    let neo4j = { ok: true, dedicated: true };
    let stats = null;
    try {
      await store.ping();
      stats = await store.stats();
      neo4j.dedicated = await store.isDedicated();
    } catch (err) {
      neo4j = { ok: false, error: err.message, authFailed: err.code === 'Neo.ClientError.Security.Unauthorized' };
    }
    res.json({
      version: VERSION,
      configured: config.configured,
      plexUrl: config.data.plexUrl || null,
      libraries: config.data.libraries,
      tmdb: tmdbStatus(),
      signedIn: Boolean(config.data.plexSignedIn),
      neo4j,
      stats,
      import: job.progress,
    });
  }));

  /** Checks a server address + token and saves them. Returns what the setup screen shows next. */
  async function connectTo({ url, token, accountToken = null }) {
    let plex;
    try {
      plex = makePlex({ url, token });
    } catch (err) {
      throw httpError(400, err.message);
    }
    let server;
    let libraries;
    try {
      server = await plex.identity();
      libraries = await plex.libraries();
    } catch (err) {
      throw httpError(err.status === 401 ? 401 : 502, err.message);
    }
    const sameServer = config.data.serverId === server.serverId;
    await config.save({
      plexUrl: plex.baseUrl,
      plexToken: token,
      serverId: server.serverId,
      // The plex.tv sign-in is kept (server-side only) so a server that moves can be found again.
      plexSignedIn: Boolean(accountToken),
      plexAccountToken: accountToken ?? '',
      // Library keys like "1" are reused by every server, so never carry choices across servers.
      ...(sameServer ? {} : { libraries: [] }),
    });
    return { server, libraries, url: plex.baseUrl };
  }

  app.post('/api/plex/connect', wrap(async (req, res) => {
    const { url, token } = req.body ?? {};
    if (typeof url !== 'string' || typeof token !== 'string' || !url.trim() || !token.trim()) {
      throw httpError(400, 'Plex URL and token are required');
    }
    res.json(await connectTo({ url, token: token.trim() }));
  }));

  // ---- Sign in with Plex -----------------------------------------------------
  //
  // The token from plex.tv stays on the server. The browser only gets the plex.tv approval page
  // and, once approved, a list of servers (names and LAN addresses) to choose from.

  // Pending sign-ins are keyed by a random handle (plex.tv's own PIN ids are sequential, so another
  // user on the network could guess them).
  const signins = new Map(); // handle -> { pin, deadline, accountToken, servers }
  const SIGNIN_MAX = 10;
  const plexTv = async () => {
    if (!config.data.clientId) await config.save({ clientId: crypto.randomUUID() });
    return makePlexTv(config.data.clientId);
  };
  const liveSignin = (id) => {
    for (const [k, v] of signins) if (v.deadline < Date.now()) signins.delete(k);
    const s = signins.get(String(id));
    if (!s) throw httpError(404, 'This sign-in has expired; start again');
    return s;
  };

  /**
   * The first address (in order of preference) where this exact server answers, or null.
   * Each address is first asked for its id without the token; the token only goes to an address
   * that has identified itself as the chosen server.
   */
  async function findWorkingUrl(server) {
    const probes = server.addresses.map(async (url) => {
      const plex = makePlex({ url, token: '', timeoutMs: 4000 });
      if ((await plex.publicIdentity()) !== server.serverId) throw new Error('a different server answered');
      return url;
    });
    for (const r of await Promise.allSettled(probes)) {
      if (r.status !== 'fulfilled') continue;
      try {
        const plex = makePlex({ url: r.value, token: server.accessToken, timeoutMs: 4000 });
        if ((await plex.identity()).serverId === server.serverId) return plex.baseUrl;
      } catch {
        /* try the next one */
      }
    }
    return null;
  }

  app.post('/api/plex/signin', wrap(async (req, res) => {
    for (const [k, v] of signins) if (v.deadline < Date.now()) signins.delete(k);
    if (signins.size >= SIGNIN_MAX) throw httpError(429, 'Too many sign-ins are in progress. Try again in a few minutes.');
    let pin;
    try {
      pin = await (await plexTv()).createPin();
    } catch (err) {
      throw httpError(502, err.message);
    }
    const id = crypto.randomUUID();
    signins.set(id, { pin, deadline: Date.now() + pin.expiresIn * 1000, accountToken: null, servers: null });
    res.json({ id, url: pin.url, expiresIn: pin.expiresIn });
  }));

  app.get('/api/plex/signin/:id', wrap(async (req, res) => {
    const s = liveSignin(req.params.id);
    if (!s.servers) {
      const tv = await plexTv();
      let token;
      try {
        token = await tv.checkPin(s.pin.id);
      } catch (err) {
        if (err.status === 404) signins.delete(String(req.params.id));
        throw httpError(err.status === 404 ? 404 : 502, err.message);
      }
      if (!token) return res.json({ state: 'waiting' });
      try {
        s.servers = await tv.servers(token);
        s.accountToken = token;
      } catch (err) {
        throw httpError(502, err.message);
      }
    }
    res.json({
      state: 'done',
      servers: s.servers.map(({ serverId, name, owned, ownerName, addresses }) => {
        const plain = addresses.find((a) => a.startsWith('http://'));
        return { serverId, name, owned, ownerName, address: plain ? new URL(plain).host : null };
      }),
    });
  }));

  app.post('/api/plex/signin/:id/choose', wrap(async (req, res) => {
    const s = liveSignin(req.params.id);
    const server = s.servers?.find((x) => x.serverId === req.body?.serverId);
    if (!server) throw httpError(400, 'Choose one of the listed servers');
    const url = await findWorkingUrl(server);
    if (!url) {
      throw httpError(
        502,
        `Could not reach "${server.name}" at any of the addresses Plex knows for it. Is it switched on and on this network?`,
      );
    }
    const result = await connectTo({ url, token: server.accessToken, accountToken: s.accountToken });
    signins.delete(String(req.params.id));
    res.json(result);
  }));

  // When a server signed in through plex.tv stops answering, ask plex.tv where it is now (its LAN
  // address may have changed) and switch to the new address. At most once a minute.
  let healing = null;
  let lastHeal = 0;
  function healPlex() {
    if (!config.data.plexSignedIn || !config.data.serverId || !config.data.plexAccountToken) return Promise.resolve(false);
    if (healing) return healing;
    if (Date.now() - lastHeal < 60000) return Promise.resolve(false);
    lastHeal = Date.now();
    const { serverId, plexAccountToken } = config.data;
    healing = (async () => {
      const servers = await (await plexTv()).servers(plexAccountToken);
      const server = servers.find((x) => x.serverId === serverId);
      if (!server) return false;
      const url = await findWorkingUrl(server);
      if (!url || url === config.data.plexUrl) return false;
      // Someone may have connected to a different server while we were looking.
      if (config.data.serverId !== serverId || config.data.plexAccountToken !== plexAccountToken) return false;
      await config.save({ plexUrl: url, plexToken: server.accessToken });
      console.log(`Plex server "${server.name}" moved; now using ${url}`);
      return true;
    })()
      .catch((err) => {
        console.warn(`Could not look up the Plex server's address on plex.tv: ${err.message}`);
        return false;
      })
      .finally(() => {
        healing = null;
      });
    return healing;
  }

  /** Runs fn with a Plex client; if Plex can't be reached, tries once more after healPlex(). */
  async function withPlex(fn, opts) {
    try {
      return await fn(plexOrThrow(opts));
    } catch (err) {
      if (unreachable(err) && (await healPlex())) return fn(plexOrThrow(opts));
      throw err;
    }
  }

  app.post('/api/settings/tmdb', wrap(async (req, res) => {
    const key = req.body?.key;
    if (typeof key !== 'string' || key.length > 2000) throw httpError(400, 'key must be text');
    const clean = key.trim();
    if (clean && !/^[A-Za-z0-9._-]+$/.test(clean)) throw httpError(400, 'That does not look like a TMDB key');
    if (clean) {
      try {
        await makeTmdb(clean).check();
      } catch (err) {
        throw httpError(err.status === 401 ? 400 : 502, err.status === 401 ? 'TMDB did not accept that key' : err.message);
      }
    }
    await config.save({ tmdbKey: clean });
    res.json({ tmdb: tmdbStatus() });
  }));

  app.get('/api/plex/libraries', wrap(async (req, res) => {
    plexOrThrow();
    try {
      res.json({ libraries: await withPlex((plex) => plex.libraries()) });
    } catch (err) {
      throw httpError(502, err.message);
    }
  }));

  app.post('/api/import', wrap(async (req, res) => {
    // The lock is taken synchronously: two overlapping requests must never both start a run,
    // because each run prunes whatever the *other* run wrote.
    if (job.progress.state === 'running' || job.starting) throw httpError(409, 'An import is already running');
    job.starting = true;
    try {
      plexOrThrow();
      const keys = req.body?.libraries;
      if (!Array.isArray(keys) || keys.length === 0 || !keys.every((k) => typeof k === 'string')) {
        throw httpError(400, 'Choose at least one library');
      }
      let available;
      try {
        available = await withPlex((p) => p.libraries()); // also finds a server that moved
      } catch (err) {
        throw httpError(502, err.message);
      }
      const plex = plexOrThrow();
      const chosen = available.filter((l) => keys.includes(l.key) && l.type === 'movie');
      if (chosen.length === 0) throw httpError(400, 'None of the chosen libraries are movie libraries');
      await store.assertDedicated();
      await config.save({ libraries: chosen });

      job.abort = new AbortController();
      runImport({ plex, store, libraries: chosen, progress: job.progress, signal: job.abort.signal, tmdb: currentTmdb(), ...importOptions }).catch(
        (err) => {
          job.progress.state = 'error';
          job.progress.message = err.message;
        },
      );
      // runImport flips state to 'running' synchronously before its first await.
      res.status(202).json(job.progress);
    } finally {
      job.starting = false;
    }
  }));

  app.get('/api/import/progress', (req, res) => res.json(job.progress));

  app.post('/api/import/cancel', (req, res) => {
    job.abort?.abort();
    res.json({ ok: true });
  });

  // ---- graph ---------------------------------------------------------------

  app.get('/api/graph/overview', wrap(async (req, res) => res.json(await store.overview(30, normalizeFilters(req.query)))));

  app.get('/api/graph/search', wrap(async (req, res) => {
    const types = typeof req.query.types === 'string' && req.query.types ? req.query.types.split(',') : undefined;
    res.json({ results: await store.search(req.query.q, { limit: req.query.limit, types }) });
  }));

  app.get('/api/graph/top', wrap(async (req, res) => {
    const picks = normalizePicks(req.query.picks);
    res.json({ items: await store.top(String(req.query.label), req.query.limit, { picks, filters: normalizeFilters(req.query), role: req.query.role }) });
  }));

  app.get('/api/graph/timeline', wrap(async (req, res) => {
    const picks = normalizePicks(req.query.picks);
    res.json(await store.timeline(picks, req.query.limit, normalizeFilters(req.query)));
  }));

  app.get('/api/graph/intersect', wrap(async (req, res) => {
    const picks = normalizePicks(req.query.picks);
    if (picks.length === 0) throw httpError(400, 'Pick at least one thing');
    res.json(await store.intersect(picks, req.query.limit, normalizeFilters(req.query)));
  }));

  app.get('/api/graph/expand', wrap(async (req, res) => {
    const { label, key, limit } = req.query;
    assertLabel(label);
    if (typeof key !== 'string' || !key) throw httpError(400, 'key is required');
    res.json(await store.expand(label, key, limit, normalizeFilters(req.query)));
  }));

  app.get('/api/graph/similar', wrap(async (req, res) => {
    const { id, limit } = req.query;
    if (typeof id !== 'string' || !id || id.length > 200) throw httpError(400, 'id is required');
    res.json({ results: await store.similar(id, limit, normalizeFilters(req.query)) });
  }));

  app.get('/api/graph/facets', wrap(async (req, res) => res.json(await store.facets())));

  app.get('/api/graph/path', wrap(async (req, res) => {
    const { fromLabel, fromKey, toLabel, toKey } = req.query;
    assertLabel(fromLabel);
    assertLabel(toLabel);
    if (typeof fromKey !== 'string' || typeof toKey !== 'string' || !fromKey || !toKey) {
      throw httpError(400, 'fromKey and toKey are required');
    }
    const result = await store.path({ label: fromLabel, key: fromKey }, { label: toLabel, key: toKey });
    res.json(result ?? { nodes: [], edges: [], none: true });
  }));

  // Pictures are proxied: the Plex token and the stored picture locations never reach the
  // browser, which only names a node (label + key).
  // A picture opened on its own (e.g. an SVG from Plex) must not be able to run anything.
  const IMAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
  const isImage = (r) => /^image\/[a-z0-9.+-]+$/i.test(r?.headers.get('content-type') ?? '') && r.body;

  async function sendPlexImage(res, thumb, small) {
    if (Date.now() < postersPausedUntil) throw httpError(503, 'Plex is not answering; posters are paused for a moment');
    // Small posters for the graph come from Plex's resizer; if that fails, send the original.
    const fetchUpstream = async (plex) => {
      let upstream = null;
      if (small) {
        try {
          upstream = await plex.thumbnail(thumb, 120, 180);
        } catch (err) {
          if (unreachable(err)) throw err; // no point trying the original if Plex isn't there
        }
        if (!isImage(upstream)) {
          await upstream?.body?.cancel().catch(() => {});
          upstream = null;
        }
      }
      return upstream ?? (await plex.image(thumb));
    };
    let upstream;
    try {
      upstream = await withPlex(fetchUpstream, { timeoutMs: POSTER_TIMEOUT_MS });
    } catch (err) {
      if (unreachable(err)) {
        postersPausedUntil = Date.now() + POSTER_PAUSE_MS;
        throw httpError(502, err.message);
      }
      throw err;
    }
    const type = upstream.headers.get('content-type') ?? '';
    if (!/^image\/[a-z0-9.+-]+$/i.test(type) || !upstream.body) throw httpError(502, 'Plex did not return an image');
    res.set('Content-Type', type);
    res.set('Cache-Control', 'private, max-age=86400');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', IMAGE_CSP);
    try {
      await pipeline(Readable.fromWeb(upstream.body), res);
    } catch {
      // Upstream dropped mid-body: nothing useful left to send. Closing the socket is the
      // only honest signal, and it must not take the process down with it.
      res.destroy();
    }
  }

  app.get('/api/image', wrap(async (req, res) => {
    const { label, key } = req.query;
    assertLabel(label);
    if (typeof key !== 'string' || !key || key.length > 300) throw httpError(400, 'key is required');
    const src = await store.imageSource(label, key);
    if (!src) throw httpError(404, 'No picture');
    if (src.plex) return sendPlexImage(res, src.plex, req.query.size === 'small');
    let img;
    try {
      img = await webImages.get(src.web);
    } catch (err) {
      if (err.name === 'WebImageError') {
        if (err.status >= 500) console.warn(`picture for ${label} ${key}: ${err.message}`);
        throw httpError(err.status, err.message);
      }
      throw err;
    }
    res.set('Content-Type', img.type);
    res.set('Cache-Control', 'private, max-age=86400');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', IMAGE_CSP);
    res.send(img.buf);
  }));

  // Older pages ask for movie posters here.
  app.get('/api/poster', wrap(async (req, res) => {
    const id = req.query.id;
    if (typeof id !== 'string' || !id || id.length > 200) throw httpError(400, 'id is required');
    const src = await store.imageSource('Movie', id);
    if (!src?.plex) throw httpError(404, 'No poster');
    return sendPlexImage(res, src.plex, req.query.size === 'small');
  }));

  // ---- static --------------------------------------------------------------

  app.use('/vendor', express.static(vendorDir, { maxAge: '7d' }));
  app.use(express.static(publicDir));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    // Errors raised on purpose (they carry a status, e.g. 502 "Could not reach Plex…") are meant
    // for the user. Only unexpected errors are hidden behind a generic message.
    let status = err.status ?? 500;
    let message = err.status ? err.message : 'Internal error';
    const code = String(err.code ?? '');
    if (!err.status && /^(ServiceUnavailable|SessionExpired)/.test(code)) {
      status = 503;
      message = 'The graph database is not reachable';
    } else if (!err.status && code === 'Neo.ClientError.Security.Unauthorized') {
      status = 503;
      message = 'The graph database rejected the configured credentials (check NEO4J_PASSWORD)';
    } else if (!err.status && err.name === 'Neo4jError') {
      message = 'The graph database returned an error; details are in the server log';
    }
    if (!err.status) console.error(err);
    else if (status >= 500) console.warn(`${req.method} ${req.path}: ${err.message}`);
    res.status(status).json({ error: message });
  });

  return { app, job };
}
