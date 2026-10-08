FROM node:22-alpine
LABEL org.opencontainers.image.title="Cinestellar" \
      org.opencontainers.image.description="Explore your Plex movie library as a graph of films, cast, crew, studios and franchises" \
      org.opencontainers.image.source="https://github.com/009bob/cinestellar" \
      org.opencontainers.image.licenses="GPL-3.0-or-later"
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
# Shipped so the database check can run inside the bundle:
#   docker compose run --rm app node scripts/smoke.js
COPY scripts ./scripts
COPY test/fixtures ./test/fixtures
COPY LICENSE ./
RUN mkdir -p /app/data && chown node:node /app/data
ENV NODE_ENV=production PORT=8080 DATA_DIR=/app/data
USER node
EXPOSE 8080
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/server/index.js"]
