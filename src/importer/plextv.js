// SPDX-License-Identifier: GPL-3.0-or-later
// "Sign in with Plex": Plex's own PIN flow, so nobody has to dig out a token by hand.
//
// 1. createPin()      -> a short-lived PIN and a plex.tv page where you approve this app
// 2. checkPin(id)     -> the token, once you have approved it
// 3. servers(token)   -> your servers, each with the addresses Plex knows for it right now
//
// The same server list lets the app find a server again after its LAN address changes.
import net from 'node:net';
import { VERSION } from '../version.js';

const PRODUCT = 'Cinestellar';

export class PlexTvError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'PlexTvError';
    this.status = status;
  }
}

export class PlexTv {
  /** @param {{clientId:string, fetchImpl?:typeof fetch, timeoutMs?:number, baseUrl?:string, authUrl?:string}} o */
  constructor({ clientId, fetchImpl = fetch, timeoutMs = 10000, baseUrl = 'https://plex.tv', authUrl = 'https://app.plex.tv/auth' }) {
    if (!clientId) throw new Error('clientId is required');
    this.clientId = clientId;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.baseUrl = baseUrl;
    this.authUrl = authUrl;
  }

  async #call(method, path, { token, params = {} } = {}) {
    const u = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
    let res;
    try {
      res = await this.fetchImpl(u, {
        method,
        headers: {
          Accept: 'application/json',
          'X-Plex-Product': PRODUCT,
          'X-Plex-Client-Identifier': this.clientId,
          'X-Plex-Version': VERSION,
          ...(token ? { 'X-Plex-Token': token } : {}),
        },
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
    } catch (err) {
      throw new PlexTvError(`Could not reach plex.tv: ${err.cause?.code || err.message}`);
    }
    if (res.status === 401) throw new PlexTvError('plex.tv did not accept the sign-in (401)', 401);
    if (res.status === 404) throw new PlexTvError('That sign-in has expired; start again', 404);
    if (!res.ok) throw new PlexTvError(`plex.tv returned HTTP ${res.status}`, res.status);
    return res.json();
  }

  /** @returns {Promise<{id:number, code:string, expiresIn:number, url:string}>} */
  async createPin() {
    const pin = await this.#call('POST', '/api/v2/pins', { params: { strong: 'true' } });
    if (!Number.isInteger(pin?.id) || typeof pin.code !== 'string') throw new PlexTvError('plex.tv sent an unexpected reply');
    const qs = new URLSearchParams({ clientID: this.clientId, code: pin.code, 'context[device][product]': PRODUCT });
    const expiresIn = Math.min(900, Number.isFinite(pin.expiresIn) && pin.expiresIn > 0 ? pin.expiresIn : 900);
    return { id: pin.id, code: pin.code, expiresIn, url: `${this.authUrl}#?${qs}` };
  }

  /** The token once the PIN has been approved, otherwise null. */
  async checkPin(id) {
    const pin = await this.#call('GET', `/api/v2/pins/${encodeURIComponent(id)}`);
    return typeof pin?.authToken === 'string' && pin.authToken ? pin.authToken : null;
  }

  /** Media servers this account can use, with the addresses to try for each, best first. */
  async servers(token) {
    const list = await this.#call('GET', '/api/v2/resources', { token, params: { includeHttps: 1, includeRelay: 0 } });
    if (!Array.isArray(list)) throw new PlexTvError('plex.tv sent an unexpected reply');
    return list
      .filter((r) => String(r?.provides ?? '').split(',').includes('server') && typeof r.clientIdentifier === 'string')
      .map((r) => ({
        serverId: r.clientIdentifier,
        name: String(r.name ?? 'Plex Media Server'),
        owned: Boolean(r.owned),
        ownerName: r.owned ? null : String(r.sourceTitle ?? '') || null,
        accessToken: typeof r.accessToken === 'string' ? r.accessToken : token,
        addresses: candidates(r.connections, { owned: Boolean(r.owned) }),
      }));
  }
}

const PRIVATE_V4 = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^127\./];
const isPrivateV4 = (a) => net.isIPv4(a) && PRIVATE_V4.some((re) => re.test(a));

/**
 * Addresses worth trying for one server, best first: local before remote, and for each the plain
 * http://IP:port form before Plex's https://…plex.direct name (some routers refuse to resolve
 * plex.direct names, while a plain address works unless the server insists on secure connections).
 *
 * Plain http is only used for private (LAN) addresses of a server you own. Everything else must be
 * a https://…plex.direct address, which only the real server holds a certificate for. Callers
 * still confirm the server's id before sending it a token.
 */
export function candidates(connections, { owned = true } = {}) {
  const out = [];
  const add = (u) => {
    if (u && !out.includes(u)) out.push(u);
  };
  const conns = (Array.isArray(connections) ? connections : []).filter((c) => c && !c.relay && !c.IPv6);
  for (const local of [true, false]) {
    for (const c of conns.filter((x) => Boolean(x.local) === local)) {
      const port = Number(c.port);
      if (owned && local && isPrivateV4(String(c.address)) && Number.isInteger(port) && port > 0 && port < 65536) {
        add(`http://${c.address}:${port}`);
      }
      try {
        const u = new URL(String(c.uri));
        if (u.protocol === 'https:' && u.hostname.endsWith('.plex.direct') && !u.username && !u.password) add(u.origin);
      } catch {
        /* skip malformed */
      }
    }
  }
  return out.slice(0, 8);
}
