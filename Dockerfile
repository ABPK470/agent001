# ── Stage 1: Install deps + build ─────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

# Copy workspace config and lockfile first (cache layer)
COPY package.json package-lock.json ./
COPY packages/agent/package.json packages/agent/
COPY packages/server/package.json packages/server/
COPY packages/ui/package.json packages/ui/

# Skip Playwright browser download in the build image — browsers live in the
# dedicated mia-browser sandbox image.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

RUN npm ci --workspaces

# Copy source
COPY packages/agent/src packages/agent/src
COPY packages/agent/tsconfig.json packages/agent/
COPY packages/server/src packages/server/src
COPY packages/server/tsconfig.json packages/server/
COPY packages/ui/src packages/ui/src
COPY packages/ui/tsconfig.json packages/ui/
COPY packages/ui/vite.config.ts packages/ui/
COPY packages/ui/index.html packages/ui/
COPY packages/ui/public packages/ui/public

# Build all packages
RUN cd packages/agent && npx tsc
RUN cd packages/ui && npx tsc -b && npx vite build
RUN cd packages/server && npx tsc

# ── Stage 2: Production runtime ──────────────────────────────
FROM node:20-slim AS runtime

# better-sqlite3 needs build libs already present in node:20-slim.
# Browser work happens in the mia-browser sandbox container, so the main
# runtime image does NOT bundle Chromium.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

# Copy package manifests and install prod-only deps
COPY package.json package-lock.json ./
COPY packages/agent/package.json packages/agent/
COPY packages/server/package.json packages/server/
COPY packages/ui/package.json packages/ui/

RUN npm ci --workspaces --omit=dev

# Copy built artifacts from builder
COPY --from=builder /app/packages/agent/dist packages/agent/dist
COPY --from=builder /app/packages/server/dist packages/server/dist
COPY --from=builder /app/packages/ui/dist packages/ui/dist

# Patch agent package.json exports to point to compiled JS (not raw .ts)
RUN node -e "const p=require('./packages/agent/package.json');p.exports={'.':'./dist/lib.js'};require('fs').writeFileSync('./packages/agent/package.json',JSON.stringify(p,null,2))"

# Data directory (SQLite DB lives here)
RUN mkdir -p /data
ENV MIA_DATA_DIR=/data

# Default env
ENV HOST=0.0.0.0
ENV PORT=3001
ENV NODE_ENV=production

EXPOSE 3001

# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:3001/api/health').then(r=>{if(!r.ok)throw 1}).catch(()=>process.exit(1))"

CMD ["node", "packages/server/dist/index.js"]
