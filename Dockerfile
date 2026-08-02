# AKAB Portal v1 — multi-stage production image
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
# pg (node-postgres) needs OpenSSL libs on Alpine
RUN apk add --no-cache libc6-compat openssl
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm install tsx@4.19.2 --no-save
COPY --from=build /app/dist ./dist
COPY api ./api
COPY server ./server
COPY vite-plugins ./vite-plugins
COPY scripts ./scripts
EXPOSE 3000
# Migrations + empty-DB bootstrap run on boot when POSTGRES_* is set
CMD ["node", "--import", "tsx", "server/prod-server.mjs"]
