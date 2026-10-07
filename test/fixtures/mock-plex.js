// A tiny fake Plex Media Server used by the tests and the smoke script.
import http from 'node:http';

export const GOOD_TOKEN = 'good-token';
export const SERVER_ID = 'mock-server-id';

const tag = (...names) => names.map((tag) => ({ tag }));
// tagKey is Plex's global person id. The Wachowskis and some crew deliberately have none, like
// people on items matched by Plex's older agents.
// Photos: one from Plex's image host, one old-style TMDB link (resized on import) and one that
// points at the LAN and must be dropped.
const keanu = { tag: 'Keanu Reeves', tagKey: 'keanu', thumb: 'https://metadata-static.plex.tv/people/keanu.jpg' };
const bullock = { tag: 'Sandra Bullock', tagKey: 'bullock', thumb: 'http://image.tmdb.org/t/p/original/bullock.jpg' };
const moss = { tag: 'Carrie-Anne Moss', tagKey: 'moss', thumb: 'http://192.168.1.1/admin.jpg' };
const fishburne = { tag: 'Laurence Fishburne', tagKey: 'fishburne' };

export const MOVIES = [
  {
    ratingKey: '1', title: 'The Matrix', year: 1999, studio: 'Warner Bros.', contentRating: 'R', duration: 8160000,
    audienceRating: 8.7, tagline: 'Welcome to the Real World.', summary: 'A hacker learns the truth.', thumb: '/library/metadata/1/thumb/1',
    Genre: tag('Action', 'Sci-Fi'), Country: tag('USA'), Collection: tag('The Matrix Collection'),
    Director: tag('Lana Wachowski', 'Lilly Wachowski'), Writer: tag('Lana Wachowski', 'Lilly Wachowski'),
    Producer: [{ tag: 'Joel Silver', tagKey: 'silver' }],
    Role: [{ ...keanu, role: 'Neo' }, { ...moss, role: 'Trinity' }, { ...fishburne, role: 'Morpheus' }],
    Guid: [{ id: 'imdb://tt0133093' }, { id: 'tmdb://603' }],
  },
  {
    ratingKey: '2', title: 'The Matrix Reloaded', year: 2003, studio: 'Warner Bros.', contentRating: 'R', audienceRating: 7.2,
    Genre: tag('Action', 'Sci-Fi'), Country: tag('USA'), Collection: tag('The Matrix Collection'),
    Director: tag('Lana Wachowski', 'Lilly Wachowski'), Writer: tag('Lana Wachowski', 'Lilly Wachowski'),
    Producer: [{ tag: 'Joel Silver', tagKey: 'silver' }],
    Role: [{ ...keanu, role: 'Neo' }, { ...moss, role: 'Trinity' }, { ...fishburne, role: 'Morpheus' }],
    Guid: [{ id: 'imdb://tt0234215' }],
  },
  {
    ratingKey: '3', title: 'John Wick', year: 2014, studio: 'Summit', audienceRating: 7.9, Guid: [{ id: 'tmdb://245891' }],
    Genre: tag('Action', 'Thriller'), Country: tag('USA'), Director: tag('Chad Stahelski'),
    Role: [{ ...keanu, role: 'John Wick' }],
  },
  {
    ratingKey: '4', title: 'Speed', year: 1994, studio: '20th Century Fox', audienceRating: 7.3, Guid: [{ id: 'tmdb://1637' }],
    Genre: tag('Action', 'Thriller'), Country: tag('USA'), Director: tag('Jan de Bont'),
    Role: [{ ...keanu, role: 'Jack Traven' }, { ...bullock, role: 'Annie Porter' }],
  },
  {
    ratingKey: '5', title: 'The Lake House', year: 2006, audienceRating: 6.0,
    Genre: tag('Romance', 'Drama'), Country: tag('USA'), Director: tag('Alejandro Agresti'),
    // Two different people who share a name (different tagKeys) must stay two nodes.
    Role: [{ ...keanu, role: 'Alex Wyler' }, { ...bullock, role: 'Kate Forster' }, { tag: 'Chris Wood', tagKey: 'cw-2', role: 'Neighbor' }],
  },
  {
    ratingKey: '6', title: 'Gravity', year: 2013, studio: 'Warner Bros.', audienceRating: 7.7, Guid: [{ id: 'tmdb://49047' }],
    Genre: tag('Sci-Fi', 'Thriller'), Country: tag('United Kingdom', 'USA'), Director: tag('Alfonso Cuarón'),
    Role: [{ ...bullock, role: 'Ryan Stone' }, { tag: 'George Clooney', role: 'Matt Kowalski' }, { tag: 'Chris Wood', tagKey: 'cw-1', role: 'Astronaut' }],
  },
];

// Distinct coloured placeholder posters, handy when looking at the UI against the mock.
function svgPoster(res, path) {
  const n = [...String(path)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const hue = n % 360;
  res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
  res.end(
    `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="180"><rect width="120" height="180" fill="hsl(${hue},45%,35%)"/>` +
      `<rect x="10" y="120" width="100" height="10" fill="hsl(${hue},45%,70%)"/><circle cx="60" cy="70" r="28" fill="hsl(${(hue + 40) % 360},50%,55%)"/></svg>`,
  );
}

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * @param {{ failDetailFor?: string[], libraries?: object[] }} [opts]
 * @returns {Promise<{url:string, close():Promise<void>, hits:string[]}>}
 */
/**
 * @param {object} [opts]
 * @param {string[]} [opts.failDetailFor]  ratingKeys whose metadata request fails (alone or in a batch)
 * @param {'ok'|'error'|'partial'|'thin'} [opts.batchMode]  how comma-separated metadata requests behave
 *   ('thin' = Plex leaves the cast out of combined responses)
 * @param {number} [opts.detailDelayMs]  slow down every metadata response
 */
export async function startMockPlex({ failDetailFor = [], libraries, omitTotalSize = false, posterMode = 'normal', rootMode = 'plex', batchMode = 'ok', serverId = SERVER_ID, extraMovies = 0, detailDelayMs = 0, collectionsMode = 'ok' } = {}) {
  const movies = [
    ...MOVIES,
    ...Array.from({ length: extraMovies }, (_, i) => ({ ratingKey: String(1000 + i), title: `Filler ${i}`, Genre: [{ tag: 'Filler' }] })),
  ];
  const hits = [];
  const libs = libraries ?? [
    { key: '1', title: 'Movies', type: 'movie' },
    { key: '2', title: 'TV Shows', type: 'show' },
  ];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    hits.push(url.pathname);
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/identity') {
      if (req.headers['x-plex-token']) hits.push('TOKEN SENT TO /identity');
      return json(200, { MediaContainer: { machineIdentifier: serverId } });
    }
    if (req.headers['x-plex-token'] !== GOOD_TOKEN) return json(401, { error: 'unauthorized' });

    if (url.pathname === '/' && rootMode === 'redirect') {
      res.writeHead(302, { Location: 'http://127.0.0.1:1/elsewhere' });
      return res.end();
    }
    if (url.pathname === '/' && rootMode === 'not-plex') return json(200, { hello: 'I am a router admin page' });
    if (url.pathname === '/') {
      return json(200, { MediaContainer: { machineIdentifier: serverId, friendlyName: 'Mock Plex', version: '1.0' } });
    }
    if (url.pathname === '/library/sections') {
      return json(200, { MediaContainer: { Directory: libs } });
    }
    const cols = /^\/library\/sections\/(\d+)\/collections$/.exec(url.pathname);
    if (cols) {
      if (collectionsMode === 'error') return json(500, { error: 'boom' });
      return json(200, {
        MediaContainer: {
          Metadata: cols[1] === '1'
            ? [
                { ratingKey: '77', title: 'The Matrix Collection', thumb: '/library/collections/77/composite/1700000000?width=400&height=600' },
                { ratingKey: '78', title: 'Nothing Imported', thumb: '/library/collections/78/thumb/1' },
                { ratingKey: '79', title: 'Bad Path', thumb: 'http://evil.example/x.jpg' },
              ]
            : [],
        },
      });
    }
    const all = /^\/library\/sections\/(\d+)\/all$/.exec(url.pathname);
    if (all) {
      const start = Number(url.searchParams.get('X-Plex-Container-Start') ?? 0);
      const size = Number(url.searchParams.get('X-Plex-Container-Size') ?? 50);
      const page = all[1] === '1' ? movies.slice(start, start + size) : [];
      return json(200, {
        MediaContainer: {
          size: page.length,
          ...(omitTotalSize ? {} : { totalSize: all[1] === '1' ? movies.length : 0 }),
          Metadata: page.map((m) => ({ ratingKey: m.ratingKey, title: m.title })),
        },
      });
    }
    const detail = /^\/library\/metadata\/(\d+(?:,\d+)*)$/.exec(url.pathname);
    if (detail) {
      const keys = detail[1].split(',');
      const batch = keys.length > 1;
      if (batch) hits.push('BATCH');
      if (keys.some((k) => failDetailFor.includes(k))) return json(500, { error: 'boom' });
      if (batch && batchMode === 'error') return json(400, { error: 'no batches here' });
      let found = movies.filter((x) => keys.includes(x.ratingKey));
      if (batch && batchMode === 'partial') found = found.slice(1);
      if (batch && batchMode === 'thin') found = found.map(({ Role, ...rest }) => rest);
      if (detailDelayMs) {
        const t = setTimeout(() => (found.length ? json(200, { MediaContainer: { Metadata: found } }) : json(404, {})), detailDelayMs);
        req.on('close', () => clearTimeout(t));
        return;
      }
      return found.length ? json(200, { MediaContainer: { Metadata: found } }) : json(404, {});
    }
    if (url.pathname === '/photo/:/transcode') {
      hits.push(`TRANSCODE ${url.searchParams.get('width')}x${url.searchParams.get('height')} ${url.searchParams.get('url')}`);
      if (posterMode === 'no-transcode') return json(500, { error: 'transcoder unavailable' });
      if (posterMode === 'svg') return svgPoster(res, url.searchParams.get('url'));
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      return res.end(PNG_1PX);
    }
    if (/^\/library\/(metadata|collections)\/\d+\/(thumb|composite)\//.test(url.pathname)) {
      if (posterMode === 'html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end('<script>alert(1)</script>');
      }
      if (posterMode === 'svg') return svgPoster(res, url.pathname);
      if (posterMode === 'drop') {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': '5000' });
        res.write(PNG_1PX);
        return setTimeout(() => req.socket.destroy(), 20);
      }
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(PNG_1PX);
    }
    json(404, {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise((r) => server.close(r)),
  };
}
