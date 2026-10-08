import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PlexTv, candidates } from '../src/importer/plextv.js';
import { createApp } from '../src/server/app.js';
import { ConfigStore } from '../src/server/config.js';
import { startMockPlex, GOOD_TOKEN, SERVER_ID } from './fixtures/mock-plex.js';

test('server addresses: local first; plain http only for LAN addresses of your own servers', () => {
  const conns = [
    { address: '73.1.2.3', port: 32400, local: false, uri: 'https://73-1-2-3.abc.plex.direct:32400' },
    { address: '192.168.1.50', port: 32400, local: true, uri: 'https://192-168-1-50.abc.plex.direct:32400' },
    { address: '10.0.0.9', port: 8443, local: false, relay: true, uri: 'https://relay.plex.direct:8443' },
    { address: 'fe80::1', port: 32400, local: true, IPv6: true, uri: 'https://[fe80::1]:32400' },
    { address: '8.8.8.8', port: 80, local: true, uri: 'http://8.8.8.8:80' },
    { address: 'not an ip', port: 99999, local: true, uri: 'javascript:alert(1)' },
    { address: '192.168.1.1', port: 80, local: true, uri: 'https://router.example.com' },
  ];
  assert.deepEqual(candidates(conns), [
    'http://192.168.1.50:32400',
    'https://192-168-1-50.abc.plex.direct:32400',
    'http://192.168.1.1:80',
    'https://73-1-2-3.abc.plex.direct:32400',
  ]);
  // A server someone shared with you lives on their network: only its plex.direct addresses.
  assert.deepEqual(candidates(conns, { owned: false }), [
    'https://192-168-1-50.abc.plex.direct:32400',
    'https://73-1-2-3.abc.plex.direct:32400',
  ]);
  assert.deepEqual(candidates(undefined), []);
});

/** A fake plex.tv: one PIN, approved on demand, and one account with a server and a player. */
function fakePlexTv(state) {
  const seen = [];
  const fetchImpl = async (u, init) => {
    const url = new URL(u);
    seen.push({ path: url.pathname, headers: init.headers });
    assert.equal(init.redirect, 'error');
    if (init.method === 'POST' && url.pathname === '/api/v2/pins') {
      assert.equal(url.searchParams.get('strong'), 'true');
      return Response.json({ id: 4242, code: 'pin-code', expiresIn: 900 }, { status: 201 });
    }
    if (url.pathname === '/api/v2/pins/4242') return Response.json({ id: 4242, authToken: state.approved ? 'ACCOUNT-TOKEN' : null });
    if (url.pathname.startsWith('/api/v2/pins/')) return new Response('{}', { status: 404 });
    if (url.pathname === '/api/v2/resources') {
      // Like plex.tv, only the account token (not a server's access token) lists resources.
      if (init.headers['X-Plex-Token'] !== 'ACCOUNT-TOKEN') return new Response('{}', { status: 401 });
      return Response.json([
        {
          name: 'LivingRoom',
          provides: 'server',
          owned: true,
          clientIdentifier: SERVER_ID,
          accessToken: GOOD_TOKEN,
          connections: [
            { address: '127.0.0.1', port: 1, local: true },
            { address: '127.0.0.1', port: state.decoyPort, local: true },
            { address: '127.0.0.1', port: state.port, local: true },
          ],
        },
        { name: 'Phone', provides: 'player', clientIdentifier: 'phone' },
      ]);
    }
    return new Response('{}', { status: 404 });
  };
  return { seen, fetchImpl };
}

async function harness() {
  const mock = await startMockPlex();
  // Another Plex server on the network that must never be sent this server's token.
  const decoy = await startMockPlex({ serverId: 'someone-else' });
  const state = { approved: false, port: Number(new URL(mock.url).port), decoyPort: Number(new URL(decoy.url).port) };
  const tv = fakePlexTv(state);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cinestellar-'));
  const config = new ConfigStore(dir);
  await config.load();
  const store = { async ping() {}, async stats() { return {}; }, async isDedicated() { return true; } };
  const { app } = createApp({ store, config, makePlexTv: (clientId) => new PlexTv({ clientId, fetchImpl: tv.fetchImpl }) });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (p, body) => {
    const res = await fetch(base + p, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, text, json: JSON.parse(text) };
  };
  return { mock, decoy, state, tv, config, dir, call, close: async () => { await new Promise((r) => server.close(r)); await mock.close(); await decoy.close(); } };
}

test('Sign in with Plex: approve on plex.tv, pick a server, and no token ever reaches the browser', async () => {
  const h = await harness();
  try {
    const start = await h.call('/api/plex/signin', {});
    assert.equal(start.status, 200);
    const auth = new URL(start.json.url);
    assert.equal(auth.origin + auth.pathname, 'https://app.plex.tv/auth');
    const params = new URLSearchParams(auth.hash.slice(2));
    assert.equal(params.get('code'), 'pin-code');
    assert.equal(params.get('clientID'), h.config.data.clientId, 'a stable id for this install');
    assert.equal(params.get('context[device][product]'), 'Cinestellar');

    assert.deepEqual((await h.call(`/api/plex/signin/${start.json.id}`)).json, { state: 'waiting' });
    h.state.approved = true;
    const done = await h.call(`/api/plex/signin/${start.json.id}`);
    assert.equal(done.json.state, 'done');
    assert.deepEqual(done.json.servers.map((s) => s.name), ['LivingRoom'], 'players are not servers');
    assert.ok(!done.text.includes(GOOD_TOKEN) && !done.text.includes('ACCOUNT-TOKEN'));

    assert.equal((await h.call(`/api/plex/signin/${start.json.id}/choose`, { serverId: 'nope' })).status, 400);
    const chosen = await h.call(`/api/plex/signin/${start.json.id}/choose`, { serverId: SERVER_ID });
    assert.equal(chosen.status, 200, chosen.text);
    assert.equal(chosen.json.url, h.mock.url, 'skips the address that does not answer and the wrong server');
    assert.ok(!h.decoy.hits.some((x) => x !== '/identity'), `the other server only had its id asked: ${h.decoy.hits}`);
    assert.ok(!h.mock.hits.includes('TOKEN SENT TO /identity'));
    assert.equal(h.config.data.plexAccountToken, 'ACCOUNT-TOKEN', 'kept server-side to find the server again');
    assert.ok(chosen.json.libraries.length > 0);
    assert.ok(!chosen.text.includes(GOOD_TOKEN));
    const status = (await h.call('/api/status')).json;
    assert.equal(status.configured, true);
    assert.equal(status.signedIn, true);
    assert.ok(!JSON.stringify(status).includes(GOOD_TOKEN) && !JSON.stringify(status).includes('ACCOUNT-TOKEN'));
    assert.equal(h.config.data.plexToken, GOOD_TOKEN);

    // The finished sign-in is gone; unknown ids are refused.
    assert.equal((await h.call(`/api/plex/signin/${start.json.id}`)).status, 404);
    assert.equal((await h.call('/api/plex/signin/999')).status, 404);
  } finally { await h.close(); }
});

test('a signed-in server that changed address is found again automatically', async () => {
  const h = await harness();
  try {
    const start = await h.call('/api/plex/signin', {});
    h.state.approved = true;
    await h.call(`/api/plex/signin/${start.json.id}`);
    await h.call(`/api/plex/signin/${start.json.id}/choose`, { serverId: SERVER_ID });

    // Pretend the server used to be somewhere that no longer answers.
    await h.config.save({ plexUrl: 'http://127.0.0.1:1' });
    const libs = await h.call('/api/plex/libraries');
    assert.equal(libs.status, 200, libs.text);
    assert.equal(h.config.data.plexUrl, h.mock.url);

    // A manual connection turns this off and forgets the plex.tv sign-in.
    await h.call('/api/plex/connect', { url: h.mock.url, token: GOOD_TOKEN });
    assert.equal((await h.call('/api/status')).json.signedIn, false);
    assert.equal(h.config.data.plexAccountToken, '');
  } finally { await h.close(); }
});

test('sign-ins use unguessable handles and are capped', async () => {
  const h = await harness();
  try {
    const ids = [];
    for (let i = 0; i < 10; i++) ids.push((await h.call('/api/plex/signin', {})).json.id);
    assert.ok(ids.every((id) => /^[0-9a-f-]{36}$/.test(id)), 'not plex.tv\'s sequential PIN id');
    const extra = await h.call('/api/plex/signin', {});
    assert.equal(extra.status, 429, 'others cannot push pending sign-ins out');
    assert.equal((await h.call('/api/plex/signin/4242')).status, 404);
  } finally { await h.close(); }
});
