# ── Stage 1: Install deps + build ─────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

# Copy workspace config and lockfile first (cache layer)
COPY package.json package-lock.json ./
COPY packages/agent/package.json packages/agent/
COPY packages/server/package.json packages/server/
COPY packages/ui/package.json packages/ui/

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

# better-sqlite3 needs shared libs; puppeteer needs chromium deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libasound2 \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

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
ENV AGENT001_DATA_DIR=/data

# Default env
ENV HOST=0.0.0.0
ENV PORT=3001
ENV NODE_ENV=production

EXPOSE 3001

# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:3001/api/health').then(r=>{if(!r.ok)throw 1}).catch(()=>process.exit(1))"

CMD ["node", "packages/server/dist/index.js"]
