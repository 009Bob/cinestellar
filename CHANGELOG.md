# Changelog

All notable changes are listed here. Versions follow [semantic versioning](https://semver.org/);
while the version starts with 0, minor versions may change behaviour.

After updating, run the import once more whenever a release says so: some features are only
filled in by an import.

## 0.8.0 – first public release

- Renamed from "Plex Graph" to **Cinestellar**. Existing installs keep their data; see the
  README section *Updating from Plex Graph*.
- Published as a ready-made Docker image (`ghcr.io/009bob/cinestellar`, Intel and ARM).
  `docker-compose.yml` now pulls it; `docker-compose.build.yml` builds from source instead.
- Licensed under the GNU GPL v3 or later.
- `NEO4J_PASSWORD` is now required (no default password).
- About footer with version, links, and the TMDB and Plex notices. `/healthz` endpoint and a
  Docker health check.

## 0.7.1

- Paste a TMDB key in the site (Libraries → Studio logos and franchises). It is checked with TMDB,
  kept in the app's data volume and used at once; it takes precedence over `TMDB_API_KEY`.

## 0.7.0

- Franchises from TMDB for movies Plex hasn't put in a collection (needs a TMDB key). Plex's own
  collections always win. *Re-import after updating.*

## 0.6.1

- *Genre links* and *Country links* toggles take those hubs out of the graph and the layout.

## 0.6.0

- Pictures on the graph: box art for movies, posters for collections, photos for cast and crew,
  logos for studios (logos need a TMDB key). Shapes remain the fallback. *Re-import after updating.*
- **Sign in with Plex**: no token to copy, and the server is found again automatically if its LAN
  address changes.

## 0.5.0

- Browse by role (Cast, Directors, Screenplay, Producers), combined picks, Timeline view,
  plain-English line labels, tighter layout, Fit to selection, Unfold, loading bar.
  *Re-import after updating* (producers).

## 0.4.0 and earlier

- Neo4j import of Plex movie libraries, graph explorer, search, filters, genre map, connection
  finder, "More like this", posters.
