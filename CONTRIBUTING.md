# Contributing

Thanks for helping! Bug reports, ideas and pull requests are all welcome.

## Reporting bugs

Use **Issues → New issue → Bug report**. The version is at the bottom of the sidebar. Logs help a
lot: `docker compose logs app --tail 100`. Please remove your Plex token, TMDB key and any
addresses you don't want public before pasting.

## Development

You need Node.js 20.3+ (22 recommended) and Docker.

```bash
npm ci
npm test                      # unit and API tests, no database needed
```

The tests use a fake Plex server and an in-memory store that mirrors the database queries. The
real Cypher is checked by `scripts/smoke.js` against an empty, throwaway Neo4j:

```bash
docker compose --profile test up -d neo4j-test
docker compose -f docker-compose.yml -f docker-compose.build.yml run --rm --build \
  -e NEO4J_URI=bolt://neo4j-test:7687 app node scripts/smoke.js
docker compose --profile test rm -sf neo4j-test
```

CI runs both on every push and pull request.

To run your changes:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

The web UI is plain JavaScript (no build step) in `public/`; the server is Express in
`src/server/`; the Plex/TMDB importer is in `src/importer/`.

## Pull requests

- Keep changes focused, and add or update tests for behaviour changes.
- If you change a database query, update `test/fixtures/memory-store.js` to match and extend
  `scripts/smoke.js`.
- Never send the Plex token or TMDB key to the browser, and only fetch pictures from the hosts in
  `src/importer/images.js`.
- By contributing you agree that your contribution is licensed under the GPL v3 or later.

## Releasing (maintainers)

Update `version` in `package.json` and `CHANGELOG.md`, commit, then tag and push:

```bash
git tag v0.8.0
git push origin main --tags
```

The *Release* workflow builds and publishes `ghcr.io/009bob/cinestellar` (Intel and ARM) and
creates the GitHub release.
