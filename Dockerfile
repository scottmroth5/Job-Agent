# Job Agent server image: Node 22, the built web page, and Playwright's Chromium.
# Holds code only. Personal data (.env, data/) never enters the image: .dockerignore keeps it out, and the
# server mounts the data folder at /data and reads its settings from an env file at run time.
#
#   docker build -t job-agent .
#   docker run --env-file .env -e HOST=0.0.0.0 -v "$PWD/data:/data" -p 127.0.0.1:5178:5178 job-agent
#
# Layers are ordered so a code change rebuilds only the last one: production dependencies and Chromium are reused
# until package-lock.json changes, which keeps each deploy's download small.

# Tools for installing dependencies. git: agent-core is a GitHub dependency. python3, make, g++: the fallback
# if better-sqlite3 has no prebuilt binary for this platform.
FROM node:22-bookworm-slim AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./

# Production dependencies only: what the server runs with.
FROM base AS deps
RUN npm ci --omit=dev

# Build the web page (Vite is a dev dependency), then drop node_modules so only code and web/dist move on.
FROM base AS build
RUN npm ci
COPY . .
RUN npm run web:build && rm -rf node_modules

# The country database for US-only access (server/geo.js): DB-IP's free IP to Country Lite (CC BY 4.0,
# https://db-ip.com), this month's file or last month's. A failed download leaves no file, and the app then blocks
# nothing and says so in its log; the weekly rebuild tries again.
FROM debian:bookworm-slim AS geo
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# GEO_STAMP (the build date, from the deploy workflow) makes each build download the file afresh rather than reuse the cache.
ARG GEO_STAMP=none
RUN echo "country database for build $GEO_STAMP" && mkdir -p /geo \
 && for m in "$(date -u +%Y-%m)" "$(date -u -d "$(date -u +%Y-%m-01) -1 month" +%Y-%m)"; do \
      if curl -fsSL --max-time 120 -o /tmp/country.mmdb.gz "https://download.db-ip.com/free/dbip-country-lite-$m.mmdb.gz" \
         && gunzip -c /tmp/country.mmdb.gz > /geo/country.mmdb && [ -s /geo/country.mmdb ]; then echo "country database $m"; break; fi; \
      rm -f /geo/country.mmdb; \
    done; rm -f /tmp/country.mmdb.gz; true

# Runtime: the same Debian and Node as the stages above, so native modules built there load here unchanged.
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=5178 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# Chromium and its system libraries, matching the installed Playwright version; tzdata for the TZ setting.
# Then npm, npx, yarn, and corepack are removed: only node runs here, and their bundled dependencies would fail the
# image scan (Trivy) for code that never runs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tzdata ca-certificates \
 && npx playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=build /app ./
COPY --from=geo /geo /app/geo
# Runs as the unprivileged node user (uid 1000); the mounted /data folder must be owned by that uid.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 5178
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5178)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
