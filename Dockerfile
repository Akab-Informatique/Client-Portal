# AKAB Portal — production image (Debian-based runtime for reliable pg + Node)
# Build on Debian 13 hosts / any Docker Engine 24+

# ---------- build UI ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV NODE_ENV=production
RUN npm run build

# ---------- runtime ----------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
# Helpful defaults; Compose overrides POSTGRES_*
ENV POSTGRES_HOST=db
ENV POSTGRES_PORT=5432
ENV POSTGRES_DB=akab
ENV POSTGRES_USER=akab

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && npm install tsx@4.19.2 --no-save

COPY --from=build /app/dist ./dist
COPY api ./api
COPY server ./server
COPY vite-plugins ./vite-plugins
COPY scripts ./scripts

# Run unprivileged (uid/gid 1000 "node" from the base image). The app never
# writes into /app; the mounted .env must be readable by gid 1000.
USER node

EXPOSE 3000

# Liveness: process + HTTP (no DB). Compose also healthchecks this.
HEALTHCHECK --interval=15s --timeout=5s --start-period=45s --retries=8 \
  CMD curl -fsS -m 4 http://127.0.0.1:3000/api/health || exit 1

# Migrations + empty-DB bootstrap run on process start when POSTGRES_* is set
CMD ["node", "--import", "tsx", "server/prod-server.mjs"]
