// SPDX-License-Identifier: GPL-3.0-or-later
import { GraphStore } from './graph.js';
import { ConfigStore } from './config.js';
import { createApp, VERSION } from './app.js';

const env = process.env;
const store = new GraphStore({
  uri: env.NEO4J_URI ?? 'bolt://localhost:7687',
  user: env.NEO4J_USER ?? 'neo4j',
  password: env.NEO4J_PASSWORD ?? 'neo4j',
  database: env.NEO4J_DATABASE || undefined,
});
const config = new ConfigStore(env.DATA_DIR ?? './data');
await config.load();

const positiveInt = (v, dflt) => (Number.isInteger(+v) && +v > 0 ? +v : dflt);

const { app } = createApp({
  store,
  config,
  password: env.APP_PASSWORD || undefined,
  allowedHosts: (env.ALLOWED_HOSTS ?? '').split(','),
  tmdbEnvKey: env.TMDB_API_KEY ?? '',
  importOptions: {
    maxCast: positiveInt(env.MAX_CAST, 30),
    fetchBatch: positiveInt(env.PLEX_FETCH_BATCH, 10),
  },
});
const port = Number(env.PORT ?? 8080);
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`Cinestellar ${VERSION} listening on http://0.0.0.0:${port}`);
  if (!env.APP_PASSWORD) console.log('No APP_PASSWORD set: anyone on your network can open this site.');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    server.close();
    await store.close();
    process.exit(0);
  });
}
