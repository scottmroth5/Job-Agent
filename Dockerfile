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
RUN apt-get update \
 && apt-get install -y --no-install-recommends tzdata ca-certificates \
 && npx playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm
COPY --from=build /app ./
# Runs as the unprivileged node user (uid 1000); the mounted /data folder must be owned by that uid.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 5178
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5178)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
