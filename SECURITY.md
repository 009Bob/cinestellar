# Security

Cinestellar is meant to run on a home network. It stores your Plex token and (optionally) a TMDB
key in its own Docker volume and never sends either to the browser.

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Use GitHub's private reporting
instead: on the repository page open **Security → Report a vulnerability**. Include the version
(shown at the bottom of the sidebar), what you found and how to reproduce it. You should get a
reply within a week.

## Supported versions

Only the latest release gets fixes. Update with `docker compose pull && docker compose up -d`.

## Hardening tips

- Set `APP_PASSWORD` unless everyone on your network should be able to use the site and change
  which Plex server it reads.
- Don't expose port 8080 to the internet. If you need remote access, put it behind a VPN (for
  example Tailscale) or a reverse proxy with its own login, and add that hostname to
  `ALLOWED_HOSTS`.
